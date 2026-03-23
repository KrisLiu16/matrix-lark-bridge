/**
 * Forge Engine — Generic multi-agent orchestration loop.
 *
 * Flow: setup → [plan → execute(dynamic) → critic(forced) → verify(forced) → iterate]
 * Critic and Verifier are framework-enforced, cannot be skipped.
 * Index validation is done automatically by the framework (validateIndex), not a separate agent.
 *
 * v2: Internal logic replaced with v2 subsystems (EventBus, AsyncSemaphore, MiddlewarePipeline,
 * ForgeMemory, ForgeConfigManager). Public API unchanged. forge-state.json format unchanged.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { forgeRun } from './forge-runner.js';
import { leaderPrompt, criticPrompt, verifierPrompt, dynamicRolePrompt } from './forge-roles.js';
import { ForgeNotifier, type ForgeNotification } from './forge-notify.js';
import { buildForgePrompt } from './forge-context.js';
import type {
  ForgeProject, ForgeState, ForgeTask, ForgeIteration,
  ForgePhase as LegacyForgePhase,
  ForgeEvent as LegacyForgeEvent,
} from './types.js';

// v2 subsystems
import type { ForgeConfig } from './types/config';
import type { ForgeEvent as ForgeEventV2 } from './types/event';
import type { MiddlewareContext, MiddlewareResult } from './types/middleware';
import { createForgeSubsystems, destroyForgeSubsystems, type ForgeSubsystems } from './forge-engine-adapter.js';
import { DEFAULT_CONFIG } from './forge-config.js';
import { createForgeEvent } from './forge-events.js';
import { createMiddlewareContext } from './forge-middleware.js';

// v2 middleware modules
import { LoopDetectionMiddleware } from './forge-loop-detection.js';
import { ProgressMiddleware } from './forge-progress.js';
import { QualityGateMiddleware } from './forge-quality-gate.js';
import { SummarizationMiddleware } from './forge-summarization.js';
import { ContextEnrichmentMiddleware } from './forge-context-enrichment.js';
import { ArtifactTrackingMiddleware } from './forge-artifact-tracking.js';

export class ForgeEngine {
  private project: ForgeProject;
  private state!: ForgeState;
  private workDir: string;
  private statePath: string;
  private stopped = false;
  private log: (msg: string) => void;
  private onEvent?: (event: LegacyForgeEvent) => void;
  private onNotify?: (n: ForgeNotification) => void;
  private notifier: ForgeNotifier;

  // v2 subsystems
  private subsystems: ForgeSubsystems;

  constructor(
    project: ForgeProject,
    opts?: {
      log?: (msg: string) => void;
      onEvent?: (event: LegacyForgeEvent) => void;
      onNotify?: (n: ForgeNotification) => void;
    },
  ) {
    this.project = project;
    this.workDir = join(process.env.HOME || '/tmp', '.deepforge', 'projects', project.id);
    this.statePath = join(this.workDir, 'forge-state.json');
    this.log = opts?.log || ((m) => {
      const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const phase = this.state?.phase || 'init';
      console.log(`[${t}] [forge] [${project.id}] [${phase}] ${m}`);
    });
    this.onEvent = opts?.onEvent;
    this.onNotify = opts?.onNotify;
    this.notifier = new ForgeNotifier(this.workDir);

    // Initialize v2 subsystems from default config, adapted to project settings
    const config = this.buildForgeConfig(project);
    this.subsystems = createForgeSubsystems(config, {
      projectId: project.id,
      title: project.title,
    });

    // Register v2 middleware modules on the pipeline
    this.registerMiddleware();

    // Bridge v2 EventBus to legacy onEvent callback
    if (this.onEvent) {
      const legacyCallback = this.onEvent;
      this.subsystems.eventBus.on('*', (event: ForgeEventV2) => {
        // Map v2 event types to legacy event types
        const legacyType = this.mapEventType(event.type);
        if (legacyType) {
          const legacyEvent: LegacyForgeEvent = {
            type: legacyType,
            message: event.message,
            role: 'source' in event ? (event as any).source : undefined,
            taskId: 'taskId' in event ? (event as any).taskId : undefined,
            timestamp: event.timestamp,
          };
          legacyCallback(legacyEvent);
        }
      });
    }

    // Load or init state
    if (existsSync(this.statePath)) {
      try {
        this.state = JSON.parse(readFileSync(this.statePath, 'utf-8'));
        // Crash recovery: running → pending
        for (const iter of this.state.iterations) {
          for (const task of iter.tasks) {
            if (task.status === 'running') task.status = 'pending';
          }
        }
      } catch (err) {
        const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.error(`[${t}] [forge] [${project.id}] [init] Corrupt state file, resetting: ${(err as Error).message}`);
        try {
          copyFileSync(this.statePath, this.statePath + '.corrupt');
        } catch { /* ignore */ }
        this.state = undefined!;
      }
    }
    if (!this.state) {
      this.state = {
        projectId: project.id,
        phase: 'setup',
        currentIteration: 0,
        iterations: [],
        totalCostUsd: 0,
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  get currentState(): ForgeState { return this.state; }

  /** Main loop */
  async run(): Promise<void> {
    this.initWorkspace();
    this.log(`Started — ${this.project.title}`);

    try {
      while (!this.stopped) {
        try {
          switch (this.state.phase) {
            case 'setup':
              await this.setup();
              break;
            case 'planning':
              await this.plan();
              break;
            case 'executing':
              await this.executeDynamic();
              break;
            case 'critiquing':
              if (this.project.noCritic) {
                this.log('Critic skipped (disabled)');
                this.setPhase('verifying');
              } else {
                await this.runCritic();
              }
              break;
            case 'verifying':
              if (this.project.noVerifier) {
                this.log('Verifier skipped (disabled)');
                this.setPhase('iterating');
              } else {
                await this.runVerifier();
              }
              break;
            case 'iterating':
              await this.iterate();
              break;
            case 'completing':
              await this.runCompletion();
              return;
            case 'paused':
            case 'completed':
              return;
          }

          // Scan & send pending notifications (non-blocking)
          this.processPendingNotifications();

        } catch (err) {
          this.state.consecutiveFailures++;
          this.log(`Error: ${(err as Error).message}`);
          this.emitV2Alert('warn', `Engine error: ${(err as Error).message}`);
          if (this.state.consecutiveFailures >= 3) {
            this.log('Circuit breaker — pausing');
            this.setPhase('paused');
            return;
          }
          await this.sleep(30_000);
        }
      }
    } finally {
      // Cleanup v2 subsystems on exit
      await destroyForgeSubsystems(this.subsystems).catch(() => {});
    }
  }

  /** Resolve a notification from user reply (called externally) */
  resolveNotification(id: string, reply: string): void {
    this.notifier.resolve(id, reply);
    this.log(`Notification ${id} resolved by user`);
  }

  stop(): void { this.stopped = true; }

  // ========== Phases ==========

  private async setup(): Promise<void> {
    writeFileSync(join(this.workDir, 'brief.md'),
      `# ${this.project.title}\n\n${this.project.description}\n`);
    writeFileSync(join(this.workDir, 'index.md'), '# 产出索引\n\n');
    writeFileSync(join(this.workDir, 'status.md'),
      `# 状态\n\nDeepForge v0.8.3\n阶段：初始化\n迭代：0\n`);
    writeFileSync(join(this.workDir, 'feedback.md'), '');
    writeFileSync(join(this.workDir, 'iteration-log.md'), '# 迭代日志\n\n');

    this.setPhase('planning');
  }

  private async plan(): Promise<void> {
    this.state.currentIteration++;
    const iterNum = this.state.currentIteration;
    const iterDir = join(this.workDir, 'iterations', String(iterNum).padStart(3, '0'));
    mkdirSync(iterDir, { recursive: true });

    this.state.iterations.push({
      number: iterNum,
      tasks: [],
      costUsd: 0,
      startedAt: new Date().toISOString(),
    });

    this.log(`Planning iteration ${iterNum}...`);

    // Fire pipeline beforeIteration hooks
    const planCtx = this.buildMiddlewareContext('planning');
    await this.subsystems.pipeline.fireBeforeIteration(planCtx);

    // Emit v2 iteration_start event
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'iteration_start' as const,
      message: `Iteration ${iterNum} started`,
      iteration: iterNum,
      plannedTaskCount: 0,
    }));

    const task: ForgeTask = {
      id: `leader-plan-${iterNum}`,
      role: 'leader',
      description: `规划第 ${iterNum} 轮迭代`,
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const iter = this.currentIter()!;
    iter.tasks.push(task);
    this.persist();

    const result = await forgeRun({
      workDir: this.workDir,
      model: this.project.model,
      effort: this.project.effort,
      systemPrompt: leaderPrompt(this.project),
      userPrompt: buildForgePrompt('leader', task, this.project, this.workDir, iterNum),
      env: this.getEnv(),
      taskId: task.id,
      roleName: 'leader',
      taskDescription: task.description,
      timeoutMs: 60 * 60 * 1000,
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist();

    if (!result.success) this.reportTaskError(task, result.error);

    writeFileSync(join(iterDir, 'plan.md'), result.output);
    this.addCost(result.costUsd);

    // Parse tasks from leader output and add to iteration
    const newTasks = this.parseTasks(result.output, iterNum);

    // Code-level guard: warn about oversized tasks
    const oversized = newTasks.filter(t => t.description && t.description.length > 300);
    if (oversized.length > 0) {
      const warning = `\n\n# ⚠️ 系统警告 — 任务粒度过大\n\n` +
        `以下 ${oversized.length} 个任务描述过长（>300字符），很可能会超时失败：\n` +
        oversized.map(t => `- **${t.id}**（${t.description.length}字符）: ${t.description.substring(0, 100)}...`).join('\n') +
        `\n\nLeader 下一轮必须将这些任务拆分成多个小任务并行执行。\n` +
        `**规则**：每个任务只做一件事，30分钟内必须完成。\n`;
      appendFileSync(join(this.workDir, 'feedback.md'), warning);
      this.log(`⚠️ ${oversized.length} tasks have oversized descriptions (>300 chars) — may timeout`);
    }

    // Check if previous iteration had timeouts, inject reminder
    if (this.state.currentIteration > 1) {
      const prevIter = this.state.iterations[this.state.iterations.length - 2];
      if (prevIter) {
        const timedOut = prevIter.tasks.filter(t => t.status === 'failed' && t.error?.includes('timed out'));
        if (timedOut.length > 0) {
          const reminder = `\n\n# ⚠️ 上轮超时警告\n\n` +
            `上一轮有 ${timedOut.length} 个任务因超时失败：\n` +
            timedOut.map(t => `- **${t.id}**（${t.role}）: ${t.description}`).join('\n') +
            `\n\n必须将这些任务拆分成更小的子任务重新分配。\n`;
          appendFileSync(join(this.workDir, 'feedback.md'), reminder);
        }
      }
    }

    iter.tasks.push(...newTasks);

    this.log(`Planned ${newTasks.length} tasks`);
    this.setPhase('executing');
  }

  private async executeDynamic(): Promise<void> {
    // Hot-reload maxConcurrent from config
    this.reloadConfig();

    const iter = this.currentIter()!;
    const pending = iter.tasks.filter(t => t.status === 'pending');

    if (pending.length === 0) {
      this.log('No dynamic tasks, moving to critic');
      this.setPhase('critiquing');
      return;
    }

    this.log(`Executing ${pending.length} tasks in parallel (max ${this.project.maxConcurrent} concurrent)...`);

    // Run middleware pipeline before task execution (context enrichment, loop detection, etc.)
    const pipelineResult = await this.runPipeline('executing');

    // If a blocking middleware (quality-gate, loop-detection) failed, skip execution
    if (pipelineResult && !pipelineResult.success) {
      const blockingStep = pipelineResult.steps.find(
        s => (s.name === 'quality-gate' || s.name === 'loop-detection') && (s.status === 'error' || s.status === 'timeout'),
      );
      if (blockingStep) {
        this.log(`Blocking middleware failure: ${blockingStep.name} — ${blockingStep.error}. Skipping task execution.`);
        void this.subsystems.eventBus.emit(createForgeEvent({
          type: 'middleware_error' as const,
          message: `Pipeline blocked execution: ${blockingStep.name} — ${blockingStep.error}`,
          middlewareName: blockingStep.name,
          error: blockingStep.error ?? 'pipeline blocked',
          recovered: false,
        }));
        this.setPhase('iterating');
        return;
      }
    }

    // Update semaphore capacity to match project config
    this.subsystems.semaphore.updateMax(this.project.maxConcurrent);

    // Execute all tasks in parallel with AsyncSemaphore concurrency control
    await Promise.all(pending.map(async (task) => {
      const roleConfig = this.project.roles.find(r => r.name === task.role);
      if (!roleConfig) {
        this.log(`Unknown role ${task.role}, skipping`);
        task.status = 'failed';
        task.error = `Role ${task.role} not found`;
        return;
      }

      // Use v2 AsyncSemaphore instead of while-polling
      await this.subsystems.semaphore.withLock(async () => {
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        this.persist();
        this.emit('task_start', `${task.role}: ${task.id}`, task.role, task.id);

        // Emit v2 task_start event
        void this.subsystems.eventBus.emit(createForgeEvent({
          type: 'task_start' as const,
          message: `Task started: ${task.id}`,
          taskId: task.id,
          role: task.role,
        }));

        try {
          const result = await forgeRun({
            workDir: this.workDir,
            model: this.project.model,
            effort: 'medium',
            systemPrompt: dynamicRolePrompt(roleConfig, this.project),
            userPrompt: buildForgePrompt(task.role, task, this.project, this.workDir, this.state.currentIteration),
            env: this.getEnv(),
            taskId: task.id,
            roleName: task.role,
            taskDescription: task.description,
            timeoutMs: 60 * 60 * 1000,
          });

          task.status = result.success ? 'completed' : 'failed';
          task.output = result.output;
          task.costUsd = result.costUsd;
          task.durationMs = result.durationMs;
          task.completedAt = new Date().toISOString();
          task.error = result.error;
          this.addCost(result.costUsd);

          const icon = result.success ? '✅' : '❌';
          this.log(`  ${task.id}: ${icon} (${this.fmtDuration(result.durationMs)})`);
          this.emit(result.success ? 'task_done' : 'task_fail', `${task.role}: ${task.id}`, task.role, task.id);

          // Emit v2 task event
          if (result.success) {
            void this.subsystems.eventBus.emit(createForgeEvent({
              type: 'task_done' as const,
              message: `Task completed: ${task.id}`,
              taskId: task.id,
              role: task.role,
              durationMs: result.durationMs,
              costUsd: result.costUsd,
            }));
          } else {
            void this.subsystems.eventBus.emit(createForgeEvent({
              type: 'task_fail' as const,
              message: `Task failed: ${task.id}`,
              taskId: task.id,
              role: task.role,
              error: result.error || 'Unknown error',
            }));
          }

          if (!result.success) this.reportTaskError(task, result.error);
        } catch (err) {
          task.status = 'failed';
          task.error = (err as Error).message;
          task.completedAt = new Date().toISOString();
          this.reportTaskError(task, task.error);
        }
      });
    }));

    this.setPhase('critiquing');
  }

  /** Critic — FORCED, cannot be skipped */
  private async runCritic(): Promise<void> {
    this.log('Critic reviewing...');
    const iterNum = this.state.currentIteration;

    const task: ForgeTask = {
      id: `critic-${iterNum}`,
      role: 'critic',
      description: `审查第 ${iterNum} 轮产出，找问题`,
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const iter = this.currentIter();
    if (iter) { iter.tasks.push(task); this.persist(); }

    const result = await forgeRun({
      workDir: this.workDir,
      model: this.project.model,
      effort: this.project.effort,
      systemPrompt: criticPrompt(this.project),
      userPrompt: buildForgePrompt('critic', task, this.project, this.workDir, iterNum),
      env: this.getEnv(),
      taskId: task.id,
      roleName: 'critic',
      taskDescription: task.description,
      timeoutMs: 60 * 60 * 1000,
    });

    // Write critic feedback, preserving user's BINDING requirements
    if (result.success && result.output) {
      const fbPath = join(this.workDir, 'feedback.md');
      const existing = existsSync(fbPath) ? readFileSync(fbPath, 'utf-8') : '';
      const userBindings = existing.split('\n')
        .filter(l => l.includes('BINDING') || l.includes('强制要求') || l.includes('必须'))
        .join('\n');
      const newContent = `# Critic 反馈 — 迭代 ${iterNum}\n\n${result.output}`
        + (userBindings ? `\n\n---\n# 用户强制要求（保留）\n${userBindings}\n` : '');
      writeFileSync(fbPath, newContent);
      writeFileSync(join(this.workDir, 'reports', 'critic-report.md'), result.output);
    }

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist();

    this.addCost(result.costUsd);
    if (iter) {
      iter.criticFeedback = result.output;
      const criticOutput = result.output || '';
      if (!criticOutput.trim()) {
        iter.criticCleared = false;
        this.log('⚠️ Critic produced empty output (crash/timeout) — treating as not cleared');
      } else {
        const hasCriticalSection = /关键问题[^]*?\n\s*\d+\.\s/m.test(criticOutput);
        const hasCriticalMarker = /CRITICAL|严重问题/i.test(criticOutput);
        const hasBlockingFeedback = /必须解决[：:]\s*\n\s*\d+\./m.test(criticOutput);
        iter.criticCleared = !(hasCriticalSection || hasCriticalMarker || hasBlockingFeedback);
      }
    }
    this.log(`Critic: ${result.success ? '✅' : '❌'} (${this.fmtDuration(result.durationMs)})`);
    this.emit('critic', `Critic completed`, 'critic');

    // Emit v2 critic_review event
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'critic_review' as const,
      message: `Critic review for iteration ${iterNum}`,
      iteration: iterNum,
      passed: iter?.criticCleared ?? false,
      feedback: result.output?.substring(0, 500) || '',
    }));

    if (!result.success) this.reportTaskError(task, result.error);

    this.setPhase('verifying');
  }

  /** Verifier — FORCED, can BLOCK */
  private async runVerifier(): Promise<void> {
    this.log('Verifier checking...');
    const iterNum = this.state.currentIteration;

    // Validate index
    const broken = this.validateIndex();
    if (broken.length > 0) {
      this.log(`⚠️ ${broken.length} broken index links`);
    }

    const task: ForgeTask = {
      id: `verifier-${iterNum}`,
      role: 'verifier',
      description: `核查第 ${iterNum} 轮产出真实性`,
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const iter = this.currentIter();
    if (iter) { iter.tasks.push(task); this.persist(); }

    const result = await forgeRun({
      workDir: this.workDir,
      model: this.project.model,
      effort: this.project.effort,
      systemPrompt: verifierPrompt(this.project),
      userPrompt: buildForgePrompt('verifier', task, this.project, this.workDir, iterNum),
      env: this.getEnv(),
      taskId: task.id,
      roleName: 'verifier',
      taskDescription: task.description,
      timeoutMs: 60 * 60 * 1000,
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist();

    this.addCost(result.costUsd);
    if (iter) iter.verifierResult = result.output;
    writeFileSync(join(this.workDir, 'reports', 'verifier-report.md'), result.output || '');

    const verifierOutput = result.output || '';
    let hasVerifierIssues: boolean;
    if (!verifierOutput.trim()) {
      hasVerifierIssues = true;
      if (iter) iter.verifierPassed = false;
      this.log('⚠️ Verifier produced empty output (crash/timeout) — treating as failed');
    } else {
      hasVerifierIssues = /❌\s*CRITICAL|CRITICAL.*❌|编译失败|compile.*(fail|error)|test.*fail|测试失败|功能缺失|代码不能跑/i.test(verifierOutput);
      if (iter) iter.verifierPassed = !hasVerifierIssues;
    }

    if (hasVerifierIssues) {
      this.log('❌ Verifier found issues — appending to feedback');
      appendFileSync(join(this.workDir, 'feedback.md'),
        `\n\n# Verifier 问题 — 迭代 ${iterNum}\n\n${verifierOutput}`);
    }

    this.log(`Verifier: ${!hasVerifierIssues ? '✅' : '❌'} (${this.fmtDuration(result.durationMs)})`);

    // Emit v2 verifier_check event
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'verifier_check' as const,
      message: `Verifier check for iteration ${iterNum}`,
      iteration: iterNum,
      passed: !hasVerifierIssues,
      result: verifierOutput.substring(0, 500),
    }));

    if (!result.success) this.reportTaskError(task, result.error);

    // Run middleware pipeline after verification (quality gate, summarization, artifact tracking)
    const verifyPipelineResult = await this.runPipeline('verifying');

    // If a blocking middleware failed during verification, mark verifier as failed
    if (verifyPipelineResult && !verifyPipelineResult.success) {
      const blockingStep = verifyPipelineResult.steps.find(
        s => (s.name === 'quality-gate' || s.name === 'loop-detection') && (s.status === 'error' || s.status === 'timeout'),
      );
      if (blockingStep) {
        this.log(`Post-verification pipeline failure: ${blockingStep.name} — ${blockingStep.error}`);
        const iter = this.currentIter();
        if (iter) iter.verifierPassed = false;
      }
    }

    this.setPhase('iterating');
  }

  private async iterate(): Promise<void> {
    const iterNum = this.state.currentIteration;

    const task: ForgeTask = {
      id: `leader-iterate-${iterNum}`,
      role: 'leader',
      description: `总结第 ${iterNum} 轮，规划下一步`,
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const iter = this.currentIter();
    if (iter) { iter.tasks.push(task); this.persist(); }

    const result = await forgeRun({
      workDir: this.workDir,
      model: this.project.model,
      effort: this.project.effort,
      systemPrompt: leaderPrompt(this.project),
      userPrompt: buildForgePrompt('leader', task, this.project, this.workDir, iterNum),
      env: this.getEnv(),
      taskId: task.id,
      roleName: 'leader',
      taskDescription: task.description,
      timeoutMs: 60 * 60 * 1000,
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist();

    this.addCost(result.costUsd);

    appendFileSync(join(this.workDir, 'iteration-log.md'),
      `\n## 迭代 ${iterNum}\n${result.output?.substring(0, 2000) || ''}\n`);

    writeFileSync(join(this.workDir, 'status.md'),
      `# 状态\n\nDeepForge v0.8.3\n阶段：迭代 ${iterNum} 完成\n迭代：${iterNum}\n`);

    if (iter) {
      iter.leaderSummary = result.output;
      iter.completedAt = new Date().toISOString();
    }

    this.log(`Iteration ${iterNum} complete`);
    this.state.consecutiveFailures = 0;

    // Emit v2 iteration_end event
    const iterStartTime = iter?.startedAt ? new Date(iter.startedAt).getTime() : Date.now();
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'iteration_end' as const,
      message: `Iteration ${iterNum} completed`,
      iteration: iterNum,
      durationMs: Date.now() - iterStartTime,
      success: iter?.verifierPassed !== false,
    }));

    // Fire pipeline afterIteration hooks
    const iterCtx = this.buildMiddlewareContext('iterating');
    await this.subsystems.pipeline.fireAfterIteration(iterCtx);

    // Completion guard
    const MAX_ITERATIONS = Infinity;
    if (result.output?.includes('PROJECT_COMPLETE')) {
      const canComplete = this.canCompleteProject(iterNum);

      if (canComplete) {
        this.log('Leader declared PROJECT_COMPLETE — all checks passed, entering completion phase');
        this.setPhase('completing');
      } else if (iterNum >= MAX_ITERATIONS) {
        this.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached — allowing completion with unresolved issues`);
        appendFileSync(join(this.workDir, 'feedback.md'),
          `\n\n# ⚠️ 强制完成 — 迭代 ${iterNum}\n\n达到最大迭代次数 ${MAX_ITERATIONS}，带未解决问题完成项目。\n`);
        this.setPhase('completing');
      } else {
        this.log('🚫 Leader declared PROJECT_COMPLETE but Verifier/Critic have unresolved issues — forcing next iteration');
        appendFileSync(join(this.workDir, 'feedback.md'),
          `\n\n# 🚫 完成被阻断 — 迭代 ${iterNum}\n\n` +
          `Leader 试图声明 PROJECT_COMPLETE，但被完成守卫阻断：\n` +
          `- Verifier 通过: ${iter?.verifierPassed ? '✅' : '❌ 有未修复问题'}\n` +
          `- Critic 清除: ${iter?.criticCleared ? '✅' : '❌ 有关键问题未解决'}\n\n` +
          `必须先解决上述问题才能声明完成。剩余迭代配额: ${MAX_ITERATIONS - iterNum} 轮。\n`);
        this.setPhase('planning');
      }
    } else {
      if (iterNum >= MAX_ITERATIONS) {
        this.log(`⚠️ Max iterations (${MAX_ITERATIONS}) reached without PROJECT_COMPLETE — auto-completing`);
        this.setPhase('completing');
      } else {
        this.setPhase('planning');
      }
    }
  }

  // ========== Completion ==========

  private async runCompletion(): Promise<void> {
    this.log('Spawning packager agent to organize deliverables...');

    const task: ForgeTask = {
      id: `packager-${this.state.currentIteration}`,
      role: 'packager',
      description: '整理产出并生成报告',
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const iter = this.currentIter();
    if (iter) { iter.tasks.push(task); this.persist(); }

    const result = await forgeRun({
      workDir: this.workDir,
      model: this.project.model,
      effort: this.project.effort,
      systemPrompt: this.packagerPrompt(),
      userPrompt: this.packagerTask(),
      env: this.getEnv(),
      taskId: task.id,
      roleName: 'packager',
      taskDescription: task.description,
      timeoutMs: 60 * 60 * 1000,
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.addCost(result.costUsd);
    this.persist();

    const nId = `complete-${this.project.id}-${Date.now()}`;
    const notification: ForgeNotification = {
      id: nId,
      from: 'packager',
      type: 'action_needed',
      title: `项目完成: ${this.project.title}`,
      detail: `项目已完成全部迭代（共 ${this.state.currentIteration} 轮）。\n` +
        `Packager 已整理产出至 deliverables/ 目录。\n\n` +
        `请选择:\n1. 确认完成\n2. 继续迭代 — 注入反馈让 Leader 继续`,
      blocking: true,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      join(this.workDir, 'notifications', 'pending', `${nId}.json`),
      JSON.stringify(notification, null, 2),
    );

    this.setPhase('completed');
    this.log('Project completed. Packager has organized deliverables.');
  }

  private packagerPrompt(): string {
    return `你是产出整理员（Packager），负责在项目完成后整理所有产出。

## 你的职责
分析工作目录，区分"产物"和"过程文件"，将产物整理到 deliverables/ 目录并生成专业报告。

## 文件分类规则

### 产物（需要保留）：
- artifacts/ 下的所有文件（代码、文档、数据、图表）
- reports/ 下的最终版本报告
- 用户明确要求的输出文件

### 过程文件（不需要复制到 deliverables/，但不要删除）：
- forge-state.json（状态持久化）
- task-logs/（执行日志）
- iterations/（迭代计划）
- notifications/（通知）
- feedback.md, status.md, index.md（过程文件）
- brief.md（任务描述）

## 输出要求
1. 将产物复制到 deliverables/ 目录，按类别分文件夹整理
2. 在 deliverables/ 下生成 report.html — 专业的项目报告
3. 将 deliverables/ 打包成 zip 压缩包
4. 在 reports/packager-report.md 写汇报

## report.html 设计要求
- 静态 HTML，深色简约风格（参考 Anthropic 官网的克制美学，不要五彩斑斓）
- 包含：项目概述、迭代历程、产出清单（文件名+大小+相对路径）、关键成果总结
- 字体用系统字体栈，不依赖外部资源
- 中文`;
  }

  private packagerTask(): string {
    const indexPath = join(this.workDir, 'index.md');
    const indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '（空）';
    const iterLogPath = join(this.workDir, 'iteration-log.md');
    const iterLog = existsSync(iterLogPath)
      ? readFileSync(iterLogPath, 'utf-8').substring(0, 3000)
      : '（空）';

    return `项目 "${this.project.title}" 已完成 ${this.state.currentIteration} 轮迭代。

工作目录：${this.workDir}

## index.md（产出索引）
${indexContent}

## 迭代日志（摘要）
${iterLog}

请开始整理产出：
1. 读取工作目录，理解文件结构
2. 将产物复制到 deliverables/ 目录
3. 生成 report.html
4. 执行 zip 打包：cd deliverables && zip -r ../${this.project.id}-deliverables.zip .
5. 写 reports/packager-report.md 汇报`;
  }

  // ========== Middleware Pipeline ==========

  /** Register all 6 v2 middleware modules on the pipeline. */
  private registerMiddleware(): void {
    const { pipeline } = this.subsystems;

    // 1. Context enrichment (priority 50) — enriches context with project info
    const contextEnrichment = new ContextEnrichmentMiddleware();
    pipeline.use(contextEnrichment.execute.bind(contextEnrichment), {
      name: 'context-enrichment', priority: 50, continueOnError: true, timeout: 5_000,
    });

    // 2. Progress tracking (priority 60) — tracks iteration progress
    const progress = new ProgressMiddleware(null);
    pipeline.use(progress.execute.bind(progress), {
      name: 'progress', priority: 60, continueOnError: true,
    });

    // 3. Artifact tracking (priority 65) — tracks file artifacts
    const artifactTracking = new ArtifactTrackingMiddleware({ projectRoot: this.workDir });
    pipeline.use(artifactTracking.execute.bind(artifactTracking), {
      name: 'artifact-tracking', priority: 65, continueOnError: true, timeout: 10_000,
    });

    // 4. Summarization (priority 70) — summarizes large outputs
    const summarization = new SummarizationMiddleware();
    pipeline.use(summarization.execute.bind(summarization), {
      name: 'summarization', priority: 70, continueOnError: true, timeout: 10_000,
    });

    // 5. Quality gate (priority 110) — validates quality criteria (blocking: failure halts pipeline)
    const qualityGate = new QualityGateMiddleware();
    pipeline.use(qualityGate.execute.bind(qualityGate), {
      name: 'quality-gate', priority: 110, continueOnError: false, timeout: 60_000,
    });

    // 6. Loop detection (priority 115) — detects repeated patterns (blocking: failure halts pipeline)
    const loopDetection = new LoopDetectionMiddleware();
    pipeline.use(loopDetection.execute.bind(loopDetection), {
      name: 'loop-detection', priority: 115, continueOnError: false,
    });

    // Register iteration lifecycle hooks so fireBeforeIteration/fireAfterIteration are not no-ops
    pipeline.onBeforeIteration(async (ctx) => {
      const iterNum = ctx.config.iteration ?? this.state.currentIteration;
      this.log(`[pipeline] beforeIteration: iteration ${iterNum}, ${ctx.iteration?.taskCount ?? 0} tasks planned`);
      // Reset per-iteration pipeline state
      ctx.state.iterationStartedAt = new Date().toISOString();
      ctx.state.pipelinePhase = 'pre-execution';
    });

    pipeline.onAfterIteration(async (ctx) => {
      const iterNum = ctx.config.iteration ?? this.state.currentIteration;
      const completed = ctx.iteration?.completedCount ?? 0;
      const failed = ctx.iteration?.failedCount ?? 0;
      const total = ctx.iteration?.taskCount ?? 0;
      this.log(`[pipeline] afterIteration: iteration ${iterNum}, ${completed}/${total} completed, ${failed} failed`);
    });

    this.log(`Registered ${pipeline.size} middleware: ${pipeline.chain.join(', ')}`);
  }

  /** Build a MiddlewareContext from current engine state. */
  private buildMiddlewareContext(phase: string): MiddlewareContext {
    const iter = this.currentIter();
    const tasks = iter?.tasks ?? [];
    return createMiddlewareContext({
      config: {
        projectId: this.project.id,
        model: this.project.model,
        effort: this.project.effort || 'medium',
        maxConcurrent: this.project.maxConcurrent,
        phase: phase as any,
        iteration: this.state.currentIteration,
      },
      iteration: iter ? {
        number: iter.number,
        taskCount: tasks.length,
        completedCount: tasks.filter(t => t.status === 'completed').length,
        failedCount: tasks.filter(t => t.status === 'failed').length,
        previousCriticCleared: this.state.iterations.length > 1
          ? this.state.iterations[this.state.iterations.length - 2]?.criticCleared
          : undefined,
      } : undefined,
      state: {},
    });
  }

  /** Run the middleware pipeline for a given phase. Returns the result so callers can react to failures. */
  private async runPipeline(phase: string): Promise<MiddlewareResult | null> {
    const ctx = this.buildMiddlewareContext(phase);
    try {
      const result = await this.subsystems.pipeline.execute(ctx);
      if (!result.success) {
        this.log(`Pipeline halted (${phase}): ${result.error || result.shortCircuitedBy || 'middleware failure'}`);
      }
      // Log middleware step results
      for (const step of result.steps) {
        if (step.status === 'error' || step.status === 'timeout') {
          this.log(`  middleware ${step.name}: ${step.status} (${step.durationMs}ms) — ${step.error}`);
        }
      }
      return result;
    } catch (err) {
      this.log(`Pipeline error (${phase}): ${(err as Error).message}`);
      return null;
    }
  }

  // ========== Helpers ==========

  private initWorkspace(): void {
    for (const d of ['', 'reports', 'artifacts', 'iterations',
      'notifications/pending', 'notifications/sent', 'notifications/resolved']) {
      mkdirSync(join(this.workDir, d), { recursive: true });
    }
  }

  private processPendingNotifications(): void {
    const pending = this.notifier.getPending();
    for (const n of pending) {
      this.log(`Notification from ${n.from}: ${n.title}`);
      this.onNotify?.(n);
      this.notifier.markSent(n.id);
    }
  }

  private setPhase(phase: LegacyForgePhase): void {
    const oldPhase = this.state.phase;
    this.state.phase = phase;
    this.persist();
    this.emit('phase', `Phase → ${phase}`);

    // Emit v2 phase_transition event
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'phase_transition' as const,
      message: `Phase transition: ${oldPhase} → ${phase}`,
      from: oldPhase,
      to: phase,
    }));
  }

  private addCost(usd: number): void {
    this.state.totalCostUsd += usd;
    const iter = this.currentIter();
    if (iter) iter.costUsd += usd;
    this.persist();
  }

  private currentIter(): ForgeIteration | undefined {
    return this.state.iterations[this.state.iterations.length - 1];
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    const tmpPath = this.statePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    renameSync(tmpPath, this.statePath);
  }

  /** Emit legacy event (v1 callback) */
  private emit(type: LegacyForgeEvent['type'], message: string, role?: string, taskId?: string): void {
    this.log(message);
    this.onEvent?.({ type, message, role, taskId, timestamp: new Date().toISOString() });
  }

  /** Emit v2 alert event */
  private emitV2Alert(severity: 'info' | 'warn' | 'error', message: string): void {
    void this.subsystems.eventBus.emit(createForgeEvent({
      type: 'alert' as const,
      message,
      severity,
    }));
  }

  /** Map v2 event types to legacy event types */
  private mapEventType(v2Type: string): LegacyForgeEvent['type'] | null {
    const mapping: Record<string, LegacyForgeEvent['type']> = {
      'phase_transition': 'phase',
      'task_start': 'task_start',
      'task_done': 'task_done',
      'task_fail': 'task_fail',
      'critic_review': 'critic',
      'alert': 'alert',
      'error': 'alert',
    };
    return mapping[v2Type] ?? null;
  }

  /** Build ForgeConfig from ForgeProject settings */
  private buildForgeConfig(project: ForgeProject): ForgeConfig {
    return {
      ...DEFAULT_CONFIG,
      project: {
        ...DEFAULT_CONFIG.project,
        model: project.model,
        effort: (project.effort === 'low' || project.effort === 'medium' || project.effort === 'high')
          ? project.effort : DEFAULT_CONFIG.project.effort,
        maxConcurrent: project.maxConcurrent,
      },
      concurrency: {
        ...DEFAULT_CONFIG.concurrency,
        maxWorkers: project.maxConcurrent,
      },
    };
  }

  private reloadConfig(): void {
    for (const cfgName of ['deepforge.json', 'forge-project.json']) {
      const cfgPath = join(this.workDir, cfgName);
      if (existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.maxConcurrent && cfg.maxConcurrent !== this.project.maxConcurrent) {
            this.log(`maxConcurrent changed: ${this.project.maxConcurrent} → ${cfg.maxConcurrent}`);
            this.project.maxConcurrent = cfg.maxConcurrent;
          }
        } catch { /* ignore */ }
        break;
      }
    }
  }

  private getEnv(): Record<string, string> {
    return {
      ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
      ...(process.env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN } : {}),
      ...(process.env.ANTHROPIC_CUSTOM_HEADERS ? { ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS } : {}),
    };
  }

  private parseTasks(output: string, iterNum: number): ForgeTask[] {
    const match = output.match(/```json\s*([\s\S]*?)```/);
    if (!match) return this.fallbackTasks(iterNum);
    try {
      const parsed = JSON.parse(match[1]);
      return (parsed.tasks || []).map((t: any) => ({
        id: t.id || `${t.role}-${iterNum}-${Math.random().toString(36).slice(2, 6)}`,
        role: t.role,
        description: t.description,
        priority: t.priority || 'medium',
        status: 'pending' as const,
      }));
    } catch {
      return this.fallbackTasks(iterNum);
    }
  }

  private fallbackTasks(iterNum: number): ForgeTask[] {
    const tasks: ForgeTask[] = [];

    if (iterNum > 1) {
      const prevIter = this.state.iterations.find(i => i.number === iterNum - 1);
      if (prevIter) {
        const failed = prevIter.tasks.filter(t => t.status === 'failed' && !['leader', 'critic', 'verifier'].includes(t.role));
        for (const ft of failed) {
          if (this.project.roles.some(r => r.name === ft.role)) {
            tasks.push({
              id: `${ft.role}-${iterNum}-retry`,
              role: ft.role,
              description: `[重试] ${ft.description}${ft.error ? ` (上轮失败: ${ft.error.substring(0, 80)})` : ''}`,
              priority: 'high' as const,
              status: 'pending' as const,
            });
          }
        }
        if (prevIter.verifierResult?.includes('❌')) {
          const first = this.project.roles[0];
          if (first) {
            tasks.push({
              id: `${first.name}-${iterNum}-fix-verifier`,
              role: first.name,
              description: `修复 Verifier 发现的问题。查看 reports/verifier-report.md 获取详情。`,
              priority: 'high' as const,
              status: 'pending' as const,
            });
          }
        }
      }
    }

    if (tasks.length === 0) {
      const criticPath = join(this.workDir, 'reports', 'critic-report.md');
      const verifierPath = join(this.workDir, 'reports', 'verifier-report.md');
      const feedbackPath = join(this.workDir, 'feedback.md');
      const criticContent = existsSync(criticPath) ? readFileSync(criticPath, 'utf-8') : '';
      const verifierContent = existsSync(verifierPath) ? readFileSync(verifierPath, 'utf-8') : '';
      const feedbackContent = existsSync(feedbackPath) ? readFileSync(feedbackPath, 'utf-8') : '';

      const hasCriticIssues = /关键问题|CRITICAL|必须解决|严重问题/i.test(criticContent);
      const hasVerifierIssues = /❌\s*CRITICAL|CRITICAL.*❌|编译失败|compile.*(fail|error)|test.*fail|测试失败|功能缺失|代码不能跑/i.test(verifierContent);
      const hasTimeoutWarning = /超时|timed out/i.test(feedbackContent);

      if (hasVerifierIssues && this.project.roles[0]) {
        const snippet = verifierContent.substring(0, 200).replace(/\n/g, ' ');
        tasks.push({
          id: `${this.project.roles[0].name}-${iterNum}-fix-verifier`,
          role: this.project.roles[0].name,
          description: `修复 Verifier 发现的问题: ${snippet}。详见 reports/verifier-report.md。`,
          priority: 'high' as const,
          status: 'pending' as const,
        });
      }

      if (hasCriticIssues && this.project.roles[0]) {
        const snippet = criticContent.substring(0, 200).replace(/\n/g, ' ');
        tasks.push({
          id: `${this.project.roles[0].name}-${iterNum}-fix-critic`,
          role: this.project.roles[0].name,
          description: `解决 Critic 关键问题: ${snippet}。详见 reports/critic-report.md。`,
          priority: 'high' as const,
          status: 'pending' as const,
        });
      }

      if (tasks.length === 0) {
        const first = this.project.roles[0];
        const roleName = first?.name || 'writer';
        const context = hasTimeoutWarning
          ? '上轮有任务超时，请将工作拆分为更小的步骤执行。'
          : `继续推进项目。查看 feedback.md 和 reports/ 了解当前状态。`;
        tasks.push({
          id: `${roleName}-${iterNum}-fallback`,
          role: roleName,
          description: `${context} 项目: ${this.project.title}`,
          priority: 'medium' as const,
          status: 'pending' as const,
        });
      }
    }

    this.log(`⚠️ Leader 未输出有效任务 JSON，根据上轮结果自动生成 ${tasks.length} 个 fallback 任务`);
    return tasks;
  }

  private validateIndex(): string[] {
    const indexPath = join(this.workDir, 'index.md');
    if (!existsSync(indexPath)) return [];
    const content = readFileSync(indexPath, 'utf-8');
    const broken: string[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(/→\s*(.+?\.\w+)\s*$/);
      if (m && !existsSync(join(this.workDir, m[1]))) {
        broken.push(m[1]);
      }
    }
    return broken;
  }

  private reportTaskError(task: ForgeTask, error?: string): void {
    const errMsg = error || '未知错误';
    this.log(`❌ 任务失败 [${task.id}]: ${errMsg}`);

    appendFileSync(join(this.workDir, 'feedback.md'),
      `\n\n# ❌ 任务执行失败 — ${task.id}\n\n` +
      `- **角色**: ${task.role}\n` +
      `- **描述**: ${task.description}\n` +
      `- **错误**: ${errMsg}\n` +
      `- **耗时**: ${task.durationMs || 0}ms\n` +
      `- **时间**: ${new Date().toISOString()}\n\n` +
      `Leader 请注意此失败并在下轮规划中处理。\n`);

    const nId = `err-${task.id}-${Date.now()}`;
    const notification: ForgeNotification = {
      id: nId,
      from: task.role,
      type: 'info',
      title: `任务失败: ${task.id}`,
      detail: `角色 ${task.role} 执行失败\n描述: ${task.description}\n错误: ${errMsg}`,
      blocking: false,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      join(this.workDir, 'notifications', 'pending', `${nId}.json`),
      JSON.stringify(notification, null, 2),
    );
  }

  private canCompleteProject(iterNum: number): boolean {
    const iter = this.currentIter();
    if (!iter) return true;

    const verifierOk = this.project.noVerifier || (iter.verifierPassed === true);
    const criticOk = this.project.noCritic || (iter.criticCleared === true);

    if (!verifierOk) this.log(`⚠️ Completion blocked: Verifier found unresolved issues in iteration ${iterNum}`);
    if (!criticOk) this.log(`⚠️ Completion blocked: Critic has critical issues in iteration ${iterNum}`);

    return verifierOk && criticOk;
  }

  private fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
