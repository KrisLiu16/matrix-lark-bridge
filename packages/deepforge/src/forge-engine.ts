/**
 * Forge Engine — Generic multi-agent orchestration loop.
 *
 * Flow: setup → [plan → execute(dynamic) → critic(forced) → verify(forced) → iterate]
 * Critic and Verifier are framework-enforced, cannot be skipped.
 * Index validation is done automatically by the framework (validateIndex), not a separate agent.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgeRun } from './forge-runner.js';
import { leaderPrompt, criticPrompt, verifierPrompt, dynamicRolePrompt } from './forge-roles.js';
import { ForgeNotifier, type ForgeNotification } from './forge-notify.js';
import { buildForgePrompt } from './forge-context.js';
import type {
  ForgeProject, ForgeState, ForgeTask, ForgeIteration, ForgePhase, ForgeEvent,
} from './types.js';

export class ForgeEngine {
  private project: ForgeProject;
  private state: ForgeState;
  private workDir: string;
  private statePath: string;
  private stopped = false;
  private log: (msg: string) => void;
  private onEvent?: (event: ForgeEvent) => void;
  private onNotify?: (n: ForgeNotification) => void;
  private notifier: ForgeNotifier;

  constructor(
    project: ForgeProject,
    opts?: {
      log?: (msg: string) => void;
      onEvent?: (event: ForgeEvent) => void;
      onNotify?: (n: ForgeNotification) => void;
    },
  ) {
    this.project = project;
    this.workDir = join(process.env.HOME || '/tmp', '.deepforge', 'projects', project.id);
    this.statePath = join(this.workDir, 'forge-state.json');
    this.log = opts?.log || ((m) => console.log(`[forge:${project.id}] ${m}`));
    this.onEvent = opts?.onEvent;
    this.onNotify = opts?.onNotify;
    this.notifier = new ForgeNotifier(this.workDir);

    // Load or init state
    if (existsSync(this.statePath)) {
      this.state = JSON.parse(readFileSync(this.statePath, 'utf-8'));
      // Crash recovery: running → pending
      for (const iter of this.state.iterations) {
        for (const task of iter.tasks) {
          if (task.status === 'running') task.status = 'pending';
        }
      }
    } else {
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
          case 'paused':
          case 'completed':
            return;
        }

        // Scan & send pending notifications (non-blocking)
        this.processPendingNotifications();

      } catch (err) {
        this.state.consecutiveFailures++;
        this.log(`Error: ${(err as Error).message}`);
        if (this.state.consecutiveFailures >= 3) {
          this.log('Circuit breaker — pausing');
          this.setPhase('paused');
          return;
        }
        await this.sleep(30_000);
      }
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
    // Write brief.md
    writeFileSync(join(this.workDir, 'brief.md'),
      `# ${this.project.title}\n\n${this.project.description}\n`);
    writeFileSync(join(this.workDir, 'index.md'), '# 产出索引\n\n');
    writeFileSync(join(this.workDir, 'status.md'),
      `# 状态\n\n阶段：初始化\n迭代：0\n`);
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

    const task: ForgeTask = {
      id: `leader-plan-${iterNum}`,
      role: 'leader',
      description: `规划第 ${iterNum} 轮迭代`,
      priority: 'high',
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    // Add leader task to iteration so it's visible in GUI
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
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;

    writeFileSync(join(iterDir, 'plan.md'), result.output);
    this.addCost(result.costUsd);

    // Parse tasks from leader output and add to iteration
    const newTasks = this.parseTasks(result.output, iterNum);
    iter.tasks.push(...newTasks);

    this.log(`Planned ${newTasks.length} tasks`);
    this.setPhase('executing');
  }

  private async executeDynamic(): Promise<void> {
    const iter = this.currentIter()!;
    const pending = iter.tasks.filter(t => t.status === 'pending');

    if (pending.length === 0) {
      this.log('No dynamic tasks, moving to critic');
      this.setPhase('critiquing');
      return;
    }

    this.log(`Executing ${pending.length} tasks in parallel (max ${this.project.maxConcurrent} concurrent)...`);

    // Semaphore for concurrency control
    let running = 0;
    const waitSlot = () => new Promise<void>(r => {
      const check = () => {
        if (running < this.project.maxConcurrent) { running++; r(); }
        else setTimeout(check, 500);
      };
      check();
    });

    // Execute all tasks in parallel with concurrency limit
    await Promise.all(pending.map(async (task) => {
      const roleConfig = this.project.roles.find(r => r.name === task.role);
      if (!roleConfig) {
        this.log(`Unknown role ${task.role}, skipping`);
        task.status = 'failed';
        task.error = `Role ${task.role} not found`;
        return;
      }

      await waitSlot();

      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.persist();
      this.emit('task_start', `${task.role}: ${task.id}`, task.role, task.id);

      try {
        const result = await forgeRun({
          workDir: this.workDir,
          model: this.project.model,
          effort: this.project.effort,
          systemPrompt: dynamicRolePrompt(roleConfig, this.project),
          userPrompt: buildForgePrompt(task.role, task, this.project, this.workDir, this.state.currentIteration),
          env: this.getEnv(),
      taskId: task.id,
        });

        task.status = result.success ? 'completed' : 'failed';
        task.output = result.output;
        task.costUsd = result.costUsd;
        task.durationMs = result.durationMs;
        task.completedAt = new Date().toISOString();
        task.error = result.error;
        this.addCost(result.costUsd);

        const icon = result.success ? '✅' : '❌';
        this.log(`  ${task.id}: ${icon} (${result.durationMs}ms, $${result.costUsd.toFixed(2)})`);
        this.emit(result.success ? 'task_done' : 'task_fail', `${task.role}: ${task.id}`, task.role, task.id);
      } finally {
        running--;
      }
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

    this.addCost(result.costUsd);
    if (iter) iter.criticFeedback = result.output;
    this.log(`Critic: ${result.success ? '✅' : '❌'} ($${result.costUsd.toFixed(2)})`);
    this.emit('critic', `Critic completed`, 'critic');

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
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;

    this.addCost(result.costUsd);
    if (iter) iter.verifierResult = result.output;
    writeFileSync(join(this.workDir, 'reports', 'verifier-report.md'), result.output || '');

    if (result.output?.includes('❌')) {
      this.log('❌ Verifier found issues — appending to feedback');
      appendFileSync(join(this.workDir, 'feedback.md'),
        `\n\n# Verifier 问题 — 迭代 ${iterNum}\n\n${result.output}`);
    }

    this.log(`Verifier: ${result.success ? '✅' : '❌'} ($${result.costUsd.toFixed(2)})`);
    this.setPhase('iterating');
  }

  private async iterate(): Promise<void> {
    const iterNum = this.state.currentIteration;

    // Leader reviews and summarizes
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
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;

    this.addCost(result.costUsd);

    // Append to iteration log
    appendFileSync(join(this.workDir, 'iteration-log.md'),
      `\n## 迭代 ${iterNum}\n${result.output?.substring(0, 2000) || ''}\n`);

    // Update status
    writeFileSync(join(this.workDir, 'status.md'),
      `# 状态\n\n阶段：迭代 ${iterNum} 完成\n迭代：${iterNum}\n费用：$${this.state.totalCostUsd.toFixed(2)}\n`);

    if (iter) {
      iter.leaderSummary = result.output;
      iter.completedAt = new Date().toISOString();
    }

    this.log(`Iteration ${iterNum} complete`);
    this.state.consecutiveFailures = 0;
    this.setPhase('planning'); // Next iteration
  }

  // ========== Helpers ==========

  private initWorkspace(): void {
    for (const d of ['', 'reports', 'artifacts', 'iterations',
      'notifications/pending', 'notifications/sent', 'notifications/resolved']) {
      mkdirSync(join(this.workDir, d), { recursive: true });
    }
  }

  /** Scan pending notifications, fire callback, mark as sent */
  private processPendingNotifications(): void {
    const pending = this.notifier.getPending();
    for (const n of pending) {
      this.log(`Notification from ${n.from}: ${n.title}`);
      this.onNotify?.(n);
      this.notifier.markSent(n.id);
    }
  }

  private setPhase(phase: ForgePhase): void {
    this.state.phase = phase;
    this.persist();
    this.emit('phase', `Phase → ${phase}`);
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
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private emit(type: ForgeEvent['type'], message: string, role?: string, taskId?: string): void {
    this.log(message);
    this.onEvent?.({ type, message, role, taskId, timestamp: new Date().toISOString() });
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
    // Always return at least one task to prevent empty iteration loops
    const first = this.project.roles[0];
    const roleName = first?.name || 'writer';
    return [{
      id: `${roleName}-${iterNum}-fallback`,
      role: roleName,
      description: `继续推进项目 ${this.project.title}`,
      priority: 'medium' as const,
      status: 'pending' as const,
    }];
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

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
