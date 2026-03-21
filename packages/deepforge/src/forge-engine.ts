/**
 * Forge Engine — Generic multi-agent orchestration loop.
 *
 * Flow: setup → [plan → execute(dynamic) → critic(forced) → verify(forced) → iterate]
 * Critic and Verifier are framework-enforced, cannot be skipped.
 * Index validation is done automatically by the framework (validateIndex), not a separate agent.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
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
  private state!: ForgeState;
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
    this.log = opts?.log || ((m) => {
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      console.log(`[${t}] [forge:${project.id}] ${m}`);
    });
    this.onEvent = opts?.onEvent;
    this.onNotify = opts?.onNotify;
    this.notifier = new ForgeNotifier(this.workDir);

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
        console.error(`[forge] corrupt state file, resetting: ${(err as Error).message}`);
        // Back up the corrupt file for debugging
        try {
          const { copyFileSync: cpSync } = require('node:fs');
          cpSync(this.statePath, this.statePath + '.corrupt');
        } catch { /* ignore */ }
        this.state = undefined!; // fall through to init below
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
        if (this.state.consecutiveFailures >= 3) {
          this.log('Circuit breaker — pausing');
          this.sendFeishuSummary(this.state.currentIteration,
            `⚠️ 项目已暂停（连续 3 次错误）\n\n错误: ${(err as Error).message}\n\n阶段: ${this.state.phase}\n迭代: ${this.state.currentIteration}`
          ).catch(() => {});
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
      timeoutMs: 60 * 60 * 1000, // 1 hour
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist(); // Persist immediately so GUI sees Leader plan completed

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
          effort: 'medium', // Dynamic roles use medium to avoid long execution
          systemPrompt: dynamicRolePrompt(roleConfig, this.project),
          userPrompt: buildForgePrompt(task.role, task, this.project, this.workDir, this.state.currentIteration),
          env: this.getEnv(),
          taskId: task.id,
          timeoutMs: 60 * 60 * 1000, // 1 hour
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

        if (!result.success) this.reportTaskError(task, result.error);
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
      timeoutMs: 60 * 60 * 1000, // 1 hour // Critic: 15 min max
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
    this.persist(); // Persist immediately so GUI sees Critic completed

    this.addCost(result.costUsd);
    if (iter) iter.criticFeedback = result.output;
    this.log(`Critic: ${result.success ? '✅' : '❌'} (${this.fmtDuration(result.durationMs)})`);
    this.emit('critic', `Critic completed`, 'critic');

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
      timeoutMs: 60 * 60 * 1000, // 1 hour // Verifier: 15 min max
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist(); // Persist immediately so GUI sees Verifier completed

    this.addCost(result.costUsd);
    if (iter) iter.verifierResult = result.output;
    writeFileSync(join(this.workDir, 'reports', 'verifier-report.md'), result.output || '');

    if (result.output?.includes('❌')) {
      this.log('❌ Verifier found issues — appending to feedback');
      appendFileSync(join(this.workDir, 'feedback.md'),
        `\n\n# Verifier 问题 — 迭代 ${iterNum}\n\n${result.output}`);
    }

    this.log(`Verifier: ${result.success ? '✅' : '❌'} (${this.fmtDuration(result.durationMs)})`);

    if (!result.success) this.reportTaskError(task, result.error);

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
      timeoutMs: 5 * 60 * 1000, // Leader iterate: 5 min max (summarize + decide, not execute)
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.persist(); // Persist immediately so GUI sees iterate completed

    this.addCost(result.costUsd);

    // Append to iteration log
    appendFileSync(join(this.workDir, 'iteration-log.md'),
      `\n## 迭代 ${iterNum}\n${result.output?.substring(0, 2000) || ''}\n`);

    // Update status
    writeFileSync(join(this.workDir, 'status.md'),
      `# 状态\n\n阶段：迭代 ${iterNum} 完成\n迭代：${iterNum}\n`);

    if (iter) {
      iter.leaderSummary = result.output;
      iter.completedAt = new Date().toISOString();
    }

    this.log(`Iteration ${iterNum} complete`);
    this.state.consecutiveFailures = 0;

    // Send iteration summary to Feishu (non-blocking)
    if (result.output) {
      this.sendFeishuSummary(iterNum, result.output).catch(() => {});
    }

    // Check if Leader declared project complete (anywhere in output)
    if (result.output?.includes('PROJECT_COMPLETE')) {
      this.log('Leader declared PROJECT_COMPLETE — entering completion phase');
      this.setPhase('completing');
    } else {
      this.setPhase('planning'); // Next iteration
    }
  }

  // ========== Completion ==========

  /** Package deliverables using a dedicated CC agent */
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
      timeoutMs: 60 * 60 * 1000, // 1 hour
    });

    task.status = result.success ? 'completed' : 'failed';
    task.costUsd = result.costUsd;
    task.durationMs = result.durationMs;
    task.completedAt = new Date().toISOString();
    task.error = result.error;
    this.addCost(result.costUsd);
    this.persist();

    // Send notification
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
    // Read index.md and iteration-log for context
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

  /** Collect all files recursively from a directory */
  private collectFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const result: string[] = [];
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) result.push(...this.collectFiles(full));
        else result.push(full);
      } catch { /* skip */ }
    }
    return result;
  }

  /** Generate an Anthropic-style HTML report */
  private generateReport(files: string[]): string {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const iterCount = this.state.currentIteration;
    const totalCost = this.state.totalCostUsd.toFixed(2);
    const elapsed = Date.now() - new Date(this.state.iterations[0]?.startedAt || Date.now()).getTime();
    const hours = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);

    // Read index.md for artifact listing
    const indexPath = join(this.workDir, 'index.md');
    const indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';

    // Read iteration log for summary
    const iterLogPath = join(this.workDir, 'iteration-log.md');
    const iterLog = existsSync(iterLogPath) ? readFileSync(iterLogPath, 'utf-8') : '';

    // Parse file listing
    const fileRows = files.map(f => {
      const rel = f.startsWith(this.workDir) ? f.slice(this.workDir.length + 1) : f;
      const st = statSync(f);
      const size = st.size > 1024 * 1024
        ? `${(st.size / 1024 / 1024).toFixed(1)} MB`
        : st.size > 1024
          ? `${(st.size / 1024).toFixed(1)} KB`
          : `${st.size} B`;
      return `<tr><td>${rel}</td><td>${size}</td></tr>`;
    }).join('\n');

    // Iteration summary rows
    const iterRows = this.state.iterations.map(iter => {
      const taskCount = iter.tasks.length;
      const completed = iter.tasks.filter(t => t.status === 'completed').length;
      const failed = iter.tasks.filter(t => t.status === 'failed').length;
      return `<tr>
        <td>${iter.number}</td>
        <td>${completed}/${taskCount} 完成${failed > 0 ? `，${failed} 失败` : ''}</td>
        <td>${iter.completedAt ? new Date(iter.completedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '进行中'}</td>
      </tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this.project.title} — DeepForge Report</title>
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --accent: #d97706; --border: #e7e5e4; --card: #fff; --muted: #78716c; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
  .container { max-width: 900px; margin: 0 auto; padding: 3rem 2rem; }
  header { border-bottom: 1px solid var(--border); padding-bottom: 2rem; margin-bottom: 2rem; }
  header h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; }
  header .meta { color: var(--muted); font-size: 0.875rem; margin-top: 0.5rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2.5rem; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
  .stat-card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .stat-card .value { font-size: 1.5rem; font-weight: 600; margin-top: 0.25rem; }
  section { margin-bottom: 2.5rem; }
  section h2 { font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.625rem 0.75rem; border-bottom: 1px solid var(--border); }
  th { font-weight: 500; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .index-block { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; font-size: 0.875rem; white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace; }
  footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; text-align: center; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${this.project.title}</h1>
    <div class="meta">${this.project.description}</div>
    <div class="meta">生成于 ${now} · DeepForge Multi-Agent Framework</div>
  </header>

  <div class="stats">
    <div class="stat-card"><div class="label">迭代轮次</div><div class="value">${iterCount}</div></div>
    <div class="stat-card"><div class="label">总耗时</div><div class="value">${hours}h ${mins}m</div></div>
    <div class="stat-card"><div class="label">团队规模</div><div class="value">${this.project.roles.length + 3} 角色</div></div>
    <div class="stat-card"><div class="label">产出文件</div><div class="value">${files.length} 个</div></div>
  </div>

  <section>
    <h2>迭代历程</h2>
    <table>
      <thead><tr><th>轮次</th><th>任务</th><th>完成时间</th></tr></thead>
      <tbody>${iterRows}</tbody>
    </table>
  </section>

  <section>
    <h2>产出索引</h2>
    <div class="index-block">${indexContent || '暂无索引'}</div>
  </section>

  <section>
    <h2>产出文件清单</h2>
    <table>
      <thead><tr><th>路径</th><th>大小</th></tr></thead>
      <tbody>${fileRows || '<tr><td colspan="2">暂无文件</td></tr>'}</tbody>
    </table>
  </section>

  <footer>
    Powered by <a href="#">DeepForge</a> · Multi-Agent Orchestration Framework
  </footer>
</div>
</body>
</html>`;
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

  /** Hot-reload mutable config fields (e.g. maxConcurrent changed via GUI) */
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

  /** Report task error: write to feedback.md + create Feishu notification */
  private reportTaskError(task: ForgeTask, error?: string): void {
    const errMsg = error || '未知错误';
    this.log(`❌ 任务失败 [${task.id}]: ${errMsg}`);

    // 1. Write to feedback.md so Leader sees the error
    appendFileSync(join(this.workDir, 'feedback.md'),
      `\n\n# ❌ 任务执行失败 — ${task.id}\n\n` +
      `- **角色**: ${task.role}\n` +
      `- **描述**: ${task.description}\n` +
      `- **错误**: ${errMsg}\n` +
      `- **耗时**: ${task.durationMs || 0}ms\n` +
      `- **时间**: ${new Date().toISOString()}\n\n` +
      `Leader 请注意此失败并在下轮规划中处理。\n`);

    // 2. Create notification for Feishu delivery
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

  /** Send iteration summary to Feishu chat via bot (fire-and-forget) */
  private async sendFeishuSummary(iterNum: number, summary: string): Promise<void> {
    const { feishuAppId, feishuAppSecret, chatId, feishuApiBaseUrl } = this.project;
    if (!feishuAppId || !feishuAppSecret || !chatId) return;

    const baseUrl = (feishuApiBaseUrl || 'https://open.feishu.cn').replace(/\/+$/, '');
    try {
      // Get tenant_access_token
      const tokenResp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: feishuAppId, app_secret: feishuAppSecret }),
      });
      const tokenData = await tokenResp.json() as any;
      if (tokenData.code !== 0) {
        this.log(`Feishu token error: ${tokenData.msg}`);
        return;
      }

      // Send message
      const title = `DeepForge · ${this.project.title} · 迭代 ${iterNum}`;
      const content = summary.substring(0, 3000);
      await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            type: 'template',
            data: {
              template_variable: {},
              template_id: undefined,
            },
            // Fallback: use raw card
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
            elements: [{ tag: 'markdown', content }],
          }),
        }),
      });

      this.log(`Feishu summary sent for iteration ${iterNum}`);
    } catch (err) {
      this.log(`Feishu send failed: ${(err as Error).message}`);
    }
  }
}
