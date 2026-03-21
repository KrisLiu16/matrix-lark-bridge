/**
 * DeepForge — Main Orchestrator (Forge)
 *
 * The Forge is the "body" — Leader CC is the "brain".
 * Forge keeps Leader alive, dispatches tasks, collects results.
 */
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeepForgeConfig, TaskState, AgentRunResult, ResearchPhase } from './types.js';
import { zeroCost } from './types.js';
import { ForgeStateManager } from './state/forge-state.js';
import { AgentPool } from './agents/agent-pool.js';
import { runAgent } from './agents/agent-runner.js';
import { getSystemPrompt } from './agents/roles.js';
import { buildPrompt } from './agents/prompt-builder.js';

export class Forge {
  private config: DeepForgeConfig;
  private state: ForgeStateManager;
  private pool: AgentPool;
  private stopped = false;
  private lastReportTime = 0;
  private logger: (msg: string) => void;

  constructor(config: DeepForgeConfig, logger?: (msg: string) => void) {
    this.config = config;
    this.state = new ForgeStateManager(config);
    this.pool = new AgentPool(config);
    this.logger = logger || ((msg) => console.log(`[forge] ${msg}`));
  }

  get stateManager(): ForgeStateManager {
    return this.state;
  }

  /** Main loop — self-driving, never stops until completed or aborted */
  async run(): Promise<void> {
    this.logger(`DeepForge started — topic: ${this.config.research.topic}`);
    this.logger(`Output: ${this.config.research.outputDir}`);
    this.logger(`Max iterations: ${this.config.research.maxIterations}`);

    while (!this.stopped) {
      try {
        // Cost check
        if (this.state.isCostExceeded(this.config)) {
          this.logger(`Cost limit exceeded ($${this.state.state.totalCost.totalCostUsd.toFixed(2)})`);
          this.state.setPhase('paused');
          break;
        }

        const phase = this.state.state.phase;
        this.logger(`Phase: ${phase}, Iteration: ${this.state.state.currentIteration}`);

        switch (phase) {
          case 'initializing':
            await this.initialize();
            break;
          case 'planning':
            await this.runLeaderPlanning();
            break;
          case 'researching':
            await this.executeRoleTasks('scout');
            this.state.setPhase('ideating');
            break;
          case 'ideating':
            await this.executeRoleTasks('ideator');
            this.state.setPhase('coding');
            break;
          case 'coding':
            await this.executeRoleTasks('coder');
            this.state.setPhase('benchmarking');
            break;
          case 'benchmarking':
            await this.executeRoleTasks('bench');
            this.state.setPhase('writing');
            break;
          case 'writing':
            await this.executeRoleTasks('writer');
            this.state.setPhase('verifying');
            break;
          case 'verifying':
            await this.runVerification();
            break;
          case 'reviewing':
            await this.runReview();
            this.state.setPhase('iterating');
            break;
          case 'iterating':
            await this.runLeaderIteration();
            break;
          case 'completed':
            this.logger('Research completed!');
            return;
          case 'paused':
            this.logger('Research paused. Use resume to continue.');
            return;
          case 'failed':
            this.logger(`Research failed: ${this.state.state.error}`);
            return;
        }

        // Periodic report check
        await this.checkReport();

      } catch (err) {
        const errMsg = (err as Error).message;
        this.logger(`Error in ${this.state.state.phase}: ${errMsg}`);
        this.state.state.consecutiveFailures++;

        if (this.state.state.consecutiveFailures >= 3) {
          this.logger('Circuit breaker: 3 consecutive failures');
          this.state.setPhase('paused');
          break;
        }

        // Short rest before retry
        await this.sleep(30_000);
      }
    }
  }

  /** Initialize workspace */
  private async initialize(): Promise<void> {
    this.state.initWorkspace();

    // Create research-brief.md if not exists
    const briefPath = join(this.config.research.outputDir, 'research-brief.md');
    if (!existsSync(briefPath)) {
      writeFileSync(briefPath, `# Research Brief\n\n## Topic\n${this.config.research.topic}\n\n## Description\n${this.config.research.description}\n`);
    }

    // Create empty findings-index.md if not exists
    const indexPath = join(this.config.research.outputDir, 'findings-index.md');
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, '# Findings Index\n\n');
    }

    // Create research-status.md
    const statusPath = join(this.config.research.outputDir, 'research-status.md');
    writeFileSync(statusPath, `# Research Status\n\nPhase: INITIALIZING\nIteration: 0\nPaper: Not started\n`);

    // Create iteration-log.md
    const logPath = join(this.config.research.outputDir, 'iteration-log.md');
    if (!existsSync(logPath)) {
      writeFileSync(logPath, '# Iteration Log\n\n');
    }

    this.logger('Workspace initialized');
    this.state.setPhase('planning');
  }

  /** Run Leader CC to plan the next iteration */
  private async runLeaderPlanning(): Promise<void> {
    this.state.startIteration();
    const iterNum = this.state.state.currentIteration;

    // Ensure iteration directory exists
    const iterDir = join(this.config.research.outputDir, 'iterations', String(iterNum).padStart(3, '0'));
    const { mkdirSync: mkd } = await import('node:fs');
    mkd(iterDir, { recursive: true });

    this.logger(`Leader planning iteration ${iterNum}...`);

    const leaderTask: TaskState = {
      id: `leader-plan-${iterNum}`,
      role: 'leader',
      description: `Plan iteration ${iterNum} of the research. Read all member reports, assess progress, and output task assignments for this iteration.`,
      priority: 'high',
      context: `This is iteration ${iterNum} of ${this.config.research.maxIterations}.`,
      status: 'running',
      retryCount: 0,
    };

    const result = await this.pool.executeTask(leaderTask, this.state);

    if (!result.success) {
      throw new Error(`Leader planning failed: ${result.error}`);
    }

    // Save plan (iterDir already created above)
    writeFileSync(join(iterDir, 'plan.md'), result.output);

    // Parse tasks from Leader's JSON output
    const tasks = this.parseLeaderTasks(result.output, iterNum);
    this.state.addTasks(tasks);

    this.state.addCost(result.cost);
    this.logger(`Leader planned ${tasks.length} tasks for iteration ${iterNum}`);

    // Determine first phase based on assigned roles
    const roles = new Set(tasks.map(t => t.role));
    if (roles.has('scout')) this.state.setPhase('researching');
    else if (roles.has('ideator')) this.state.setPhase('ideating');
    else if (roles.has('coder')) this.state.setPhase('coding');
    else if (roles.has('bench')) this.state.setPhase('benchmarking');
    else if (roles.has('writer')) this.state.setPhase('writing');
    else this.state.setPhase('iterating');
  }

  /** Execute all pending tasks for a specific role */
  private async executeRoleTasks(role: string): Promise<void> {
    const tasks = this.state.getPendingTasks(role);
    if (tasks.length === 0) {
      this.logger(`No ${role} tasks this iteration, skipping`);
      return;
    }

    this.logger(`Executing ${tasks.length} ${role} tasks...`);

    const results = await this.pool.executeTasks(
      tasks,
      this.state,
      (task, result) => {
        this.state.updateTask(task.id, {
          status: result.success ? 'completed' : 'failed',
          output: result.output,
          cost: result.cost,
          error: result.error,
        });
        this.logger(`  ${task.id}: ${result.success ? '✅' : '❌'} (${result.durationMs}ms, $${result.cost.totalCostUsd.toFixed(2)})`);
      }
    );
  }

  /** Run Verifier — can BLOCK the pipeline */
  private async runVerification(): Promise<void> {
    // Also validate index
    const brokenLinks = this.state.validateIndex();
    if (brokenLinks.length > 0) {
      this.logger(`⚠️ ${brokenLinks.length} broken index links: ${brokenLinks.join(', ')}`);
    }

    const verifierTask: TaskState = {
      id: `verifier-${this.state.state.currentIteration}`,
      role: 'verifier',
      description: 'Verify all citations and data in the current paper draft. Check paper/main.tex and paper/bibliography.bib.',
      priority: 'high',
      context: brokenLinks.length > 0
        ? `⚠️ Index has ${brokenLinks.length} broken links: ${brokenLinks.join(', ')}. Report these as well.`
        : 'No known index issues.',
      status: 'pending',
      retryCount: 0,
    };

    this.state.addTasks([verifierTask]);
    const result = await this.pool.executeTask(verifierTask, this.state);

    this.state.updateTask(verifierTask.id, {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      cost: result.cost,
    });

    // Check for FALSE findings
    if (result.output.includes('❌ FALSE') || result.output.includes('❌')) {
      this.logger('❌ Verifier found issues — creating fix task for Writer');
      // Write feedback for Writer to fix
      writeFileSync(
        join(this.config.research.outputDir, 'review-feedback.md'),
        `# Verifier BLOCK\n\n${result.output}`
      );
      // Create a writer fix task so there's something to execute when we go back
      const fixTask: TaskState = {
        id: `writer-fix-${this.state.state.currentIteration}-${Date.now()}`,
        role: 'writer',
        description: `Fix issues found by Verifier. Read review-feedback.md for details. Correct any FALSE citations, inaccurate data references, or fabricated content in paper/main.tex.`,
        priority: 'high',
        context: 'Verifier found errors that must be fixed before the paper can proceed.',
        status: 'pending',
        retryCount: 0,
      };
      this.state.addTasks([fixTask]);
      this.state.setPhase('writing');
    } else {
      this.logger('✅ Verification passed');
      this.state.setPhase('reviewing');
    }
  }

  /** Run strict Reviewer — always creates a review task */
  private async runReview(): Promise<void> {
    const iterNum = this.state.state.currentIteration;
    const reviewTask: TaskState = {
      id: `reviewer-${iterNum}`,
      role: 'reviewer',
      description: `严格审阅论文 paper/main.tex 全文。作为匿名审稿人 Reviewer #2，找出所有弱点，给出 Strong Reject 到 Strong Accept 的评分，列出 Top 3 Weaknesses。将审阅意见同时写入 reports/reviewer-report.md 和 review-feedback.md。`,
      priority: 'high',
      context: `这是第 ${iterNum} 轮迭代后的审稿。论文经过 ${iterNum} 轮打磨，你要找出仍然存在的问题。`,
      status: 'pending',
      retryCount: 0,
    };
    this.state.addTasks([reviewTask]);

    const result = await this.pool.executeTask(reviewTask, this.state);
    this.state.updateTask(reviewTask.id, {
      status: result.success ? 'completed' : 'failed',
      output: result.output,
      cost: result.cost,
    });

    // Append review feedback (preserve user feedback already in the file)
    if (result.success && result.output) {
      const feedbackPath = join(this.config.research.outputDir, 'review-feedback.md');
      const existing = existsSync(feedbackPath) ? readFileSync(feedbackPath, 'utf-8') : '';
      // Keep lines containing BINDING (user's hard requirements)
      const userBindings = existing.split('\n').filter(l =>
        l.includes('BINDING') || l.includes('强制要求') || l.includes('必须')
      ).join('\n');
      const newContent = `# Reviewer #2 Feedback — Iteration ${iterNum}\n\n${result.output}`
        + (userBindings ? `\n\n---\n# 用户强制要求（保留）\n${userBindings}\n` : '');
      writeFileSync(feedbackPath, newContent);
    }

    this.logger(`Reviewer: ${result.success ? '✅' : '❌'} ($${result.cost.totalCostUsd.toFixed(2)})`);
  }

  /** Leader reviews iteration and decides next steps */
  private async runLeaderIteration(): Promise<void> {
    const iterNum = this.state.state.currentIteration;

    const leaderTask: TaskState = {
      id: `leader-iterate-${iterNum}`,
      role: 'leader',
      description: `Review iteration ${iterNum} results. Read all reports and the current paper. Write a reflection to iteration-log.md. Decide: continue to iteration ${iterNum + 1} or complete?`,
      priority: 'high',
      context: `Max iterations: ${this.config.research.maxIterations}. Current: ${iterNum}.`,
      status: 'running',
      retryCount: 0,
    };

    const result = await this.pool.executeTask(leaderTask, this.state);
    this.state.addCost(result.cost);

    // Append to iteration log
    const logPath = join(this.config.research.outputDir, 'iteration-log.md');
    const summary = `\n## Iteration ${iterNum} — ${new Date().toISOString()}\n${result.output.substring(0, 2000)}\n`;
    appendFileSync(logPath, summary);

    // Update research status
    const statusPath = join(this.config.research.outputDir, 'research-status.md');
    writeFileSync(statusPath, `# Research Status\n\nPhase: ITERATION ${iterNum} COMPLETE\nIteration: ${iterNum}/${this.config.research.maxIterations}\nCost: $${this.state.state.totalCost.totalCostUsd.toFixed(2)}\n`);

    // Decide: continue or complete
    if (iterNum >= this.config.research.maxIterations) {
      this.logger('Max iterations reached — completing');
      this.state.setPhase('completed');
    } else {
      this.logger(`Iteration ${iterNum} complete — starting next`);
      this.state.setPhase('planning');
    }
  }

  /** Parse Leader's task assignments from JSON block in output */
  private parseLeaderTasks(output: string, iterNum: number): TaskState[] {
    const match = output.match(/```json\s*([\s\S]*?)```/);
    if (!match) {
      this.logger('Warning: Leader output has no JSON task block, using fallback');
      return this.fallbackTasks(iterNum);
    }

    try {
      const parsed = JSON.parse(match[1]);
      const rawTasks = parsed.tasks || [];
      return rawTasks.map((t: any) => ({
        id: t.id || `${t.role}-${iterNum}-${Math.random().toString(36).slice(2, 6)}`,
        role: t.role,
        description: t.description,
        priority: t.priority || 'medium',
        context: t.context || '',
        status: 'pending' as const,
        retryCount: 0,
      }));
    } catch (err) {
      this.logger(`Warning: Failed to parse Leader tasks JSON: ${(err as Error).message}`);
      return this.fallbackTasks(iterNum);
    }
  }

  /** Fallback tasks if Leader doesn't produce valid JSON */
  private fallbackTasks(iterNum: number): TaskState[] {
    return [
      {
        id: `scout-${iterNum}-fallback`,
        role: 'scout',
        description: 'Search for new relevant papers on the research topic.',
        priority: 'medium',
        context: 'Fallback task — Leader did not produce valid task assignments.',
        status: 'pending',
        retryCount: 0,
      },
      {
        id: `writer-${iterNum}-fallback`,
        role: 'writer',
        description: 'Review and improve the current paper draft.',
        priority: 'medium',
        context: 'Fallback task.',
        status: 'pending',
        retryCount: 0,
      },
    ];
  }

  /** Check if it's time to send a report */
  private async checkReport(): Promise<void> {
    const intervalMs = (this.config.feishu?.reportIntervalMinutes || 90) * 60_000;
    if (Date.now() - this.lastReportTime >= intervalMs) {
      this.lastReportTime = Date.now();
      this.logger(`Report interval reached — sending progress update`);
      // TODO: FeishuReporter.sendUpdate()
    }
  }

  /** Stop the forge gracefully */
  stop(): void {
    this.stopped = true;
    this.logger('Stop requested — will finish current task');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
