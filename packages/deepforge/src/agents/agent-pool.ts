/**
 * DeepForge — Agent Pool
 *
 * Manages concurrent agent execution with a semaphore.
 */
import { runAgent, type RunAgentOpts } from './agent-runner.js';
import type { AgentRunResult, TaskState, AgentRole, DeepForgeConfig } from '../types.js';
import { zeroCost } from '../types.js';
import { getSystemPrompt } from './roles.js';
import { buildPrompt } from './prompt-builder.js';
import type { ForgeStateManager } from '../state/forge-state.js';

export class AgentPool {
  private running = 0;
  private maxConcurrent: number;
  private config: DeepForgeConfig;

  constructor(config: DeepForgeConfig) {
    this.config = config;
    this.maxConcurrent = config.limits.maxConcurrentAgents;
  }

  /**
   * Execute a task by spawning a CC instance for the appropriate role.
   */
  async executeTask(
    task: TaskState,
    stateManager: ForgeStateManager,
  ): Promise<AgentRunResult> {
    // Wait for semaphore slot
    while (this.running >= this.maxConcurrent) {
      await new Promise(r => setTimeout(r, 1000));
    }

    this.running++;

    try {
      const agentConfig = this.config.agents[task.role];
      if (!agentConfig?.enabled) {
        return {
          output: '',
          cost: zeroCost(),
          success: false,
          error: `Agent role ${task.role} is disabled`,
          durationMs: 0,
        };
      }

      const systemPrompt = getSystemPrompt(task.role, this.config);
      const userPrompt = buildPrompt(task, stateManager);

      const result = await runAgent({
        claudePath: this.config.claude.binaryPath || '',
        workDir: this.config.research.workDir,
        model: agentConfig.model,
        effort: agentConfig.effort,
        systemPrompt,
        userPrompt,
        env: this.config.claude.env,
        timeoutMs: agentConfig.timeoutMs,
      });

      return result;
    } finally {
      this.running--;
    }
  }

  /**
   * Execute multiple tasks in parallel (respecting concurrency limit).
   */
  async executeTasks(
    tasks: TaskState[],
    stateManager: ForgeStateManager,
    onTaskComplete?: (task: TaskState, result: AgentRunResult) => void,
  ): Promise<Map<string, AgentRunResult>> {
    const results = new Map<string, AgentRunResult>();

    await Promise.all(
      tasks.map(async (task) => {
        const result = await this.executeTask(task, stateManager);
        results.set(task.id, result);
        onTaskComplete?.(task, result);
      })
    );

    return results;
  }

  get activeCount(): number {
    return this.running;
  }
}
