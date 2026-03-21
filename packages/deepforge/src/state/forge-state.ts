/**
 * DeepForge — State Manager
 *
 * Persists research state to forge-state.json after every transition.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ForgeState, ResearchPhase, IterationState, TaskState,
  CostSummary, DeepForgeConfig, ForgeEvent,
} from '../types.js';
import { zeroCost, addCost } from '../types.js';

export class ForgeStateManager {
  state: ForgeState;
  readonly outputDir: string;
  private statePath: string;
  private listeners: ((event: ForgeEvent) => void)[] = [];

  constructor(config: DeepForgeConfig) {
    this.outputDir = config.research.outputDir;
    this.statePath = join(this.outputDir, 'forge-state.json');

    if (existsSync(this.statePath)) {
      // Resume from saved state
      const raw = readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw);
      // Reset any 'running' tasks to 'pending' (crash recovery)
      for (const iter of this.state.iterations) {
        for (const task of iter.tasks) {
          if (task.status === 'running') {
            task.status = 'pending';
          }
        }
      }
      this.emit('phase_change', `Resumed from ${this.state.phase}, iteration ${this.state.currentIteration}`);
    } else {
      // Initialize fresh
      this.state = {
        id: randomUUID(),
        phase: 'initializing',
        currentIteration: 0,
        iterations: [],
        totalCost: zeroCost(),
        consecutiveFailures: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /** Subscribe to forge events (for CLI dashboard) */
  onEvent(listener: (event: ForgeEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(type: ForgeEvent['type'], message: string, data?: Record<string, unknown>): void {
    const event: ForgeEvent = {
      type,
      timestamp: new Date().toISOString(),
      message,
      ...data,
    };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  /** Transition to a new phase */
  setPhase(phase: ResearchPhase): void {
    this.state.phase = phase;
    this.state.updatedAt = new Date().toISOString();
    this.persist();
    this.emit('phase_change', `Phase → ${phase}`);
  }

  /** Start a new iteration */
  startIteration(plan?: string): void {
    this.state.currentIteration++;
    const iter: IterationState = {
      number: this.state.currentIteration,
      phase: 'planning',
      tasks: [],
      leaderPlan: plan,
      cost: zeroCost(),
      startedAt: new Date().toISOString(),
    };
    this.state.iterations.push(iter);
    this.persist();
    this.emit('iteration_start', `Iteration ${this.state.currentIteration} started`);
  }

  /** Get current iteration */
  currentIteration(): IterationState | undefined {
    return this.state.iterations[this.state.iterations.length - 1];
  }

  /** Add tasks to current iteration */
  addTasks(tasks: TaskState[]): void {
    const iter = this.currentIteration();
    if (!iter) throw new Error('No active iteration');
    iter.tasks.push(...tasks);
    this.persist();
  }

  /** Update a task's status */
  updateTask(taskId: string, updates: Partial<TaskState>): void {
    const iter = this.currentIteration();
    if (!iter) return;
    const task = iter.tasks.find(t => t.id === taskId);
    if (!task) return;
    Object.assign(task, updates);
    if (updates.status === 'running') {
      task.startedAt = new Date().toISOString();
      this.emit('task_start', `${task.role}:${task.id} started`, { role: task.role, taskId });
    }
    if (updates.status === 'completed') {
      task.completedAt = new Date().toISOString();
      if (updates.cost) {
        iter.cost = addCost(iter.cost, updates.cost);
        this.state.totalCost = addCost(this.state.totalCost, updates.cost);
      }
      this.state.consecutiveFailures = 0;
      this.emit('task_complete', `${task.role}:${task.id} completed`, { role: task.role, taskId });
    }
    if (updates.status === 'failed') {
      this.state.consecutiveFailures++;
      this.emit('task_fail', `${task.role}:${task.id} failed: ${updates.error}`, { role: task.role, taskId });
    }
    this.persist();
  }

  /** Get pending tasks for a specific phase/role */
  getPendingTasks(role?: string): TaskState[] {
    const iter = this.currentIteration();
    if (!iter) return [];
    return iter.tasks.filter(t => t.status === 'pending' && (!role || t.role === role));
  }

  /** Record cost */
  addCost(cost: CostSummary): void {
    this.state.totalCost = addCost(this.state.totalCost, cost);
    this.persist();
    this.emit('cost_update', `Total cost: $${this.state.totalCost.totalCostUsd.toFixed(2)}`);
  }

  /** Check if cost limit exceeded */
  isCostExceeded(config: DeepForgeConfig): boolean {
    if (this.state.totalCost.totalCostUsd >= config.limits.maxTotalCostUsd) return true;
    const iter = this.currentIteration();
    if (iter && iter.cost.totalCostUsd >= config.limits.maxIterationCostUsd) return true;
    return false;
  }

  /** Initialize workspace directory structure */
  initWorkspace(): void {
    const dirs = [
      '', 'tasks/pending', 'tasks/running', 'tasks/completed',
      'reports', 'research', 'ideas', 'code/results',
      'data', 'figures', 'paper', 'iterations',
    ];
    for (const d of dirs) {
      mkdirSync(join(this.outputDir, d), { recursive: true });
    }
  }

  /** Validate findings-index.md links */
  validateIndex(): string[] {
    const indexPath = join(this.outputDir, 'findings-index.md');
    if (!existsSync(indexPath)) return [];

    const content = readFileSync(indexPath, 'utf-8');
    const broken: string[] = [];
    for (const line of content.split('\n')) {
      const match = line.match(/→\s*(.+\.md)\s*$/);
      if (match) {
        const filePath = join(this.outputDir, match[1]);
        if (!existsSync(filePath)) {
          broken.push(match[1]);
        }
      }
    }
    return broken;
  }

  /** Persist state to disk */
  persist(): void {
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
