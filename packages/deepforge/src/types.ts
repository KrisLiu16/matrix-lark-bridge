/**
 * DeepForge — Type Definitions
 */

// ============ Agent Roles ============

export const AGENT_ROLES = ['leader', 'scout', 'ideator', 'coder', 'bench', 'writer', 'verifier', 'reviewer'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

// ============ Configuration ============

export interface AgentConfig {
  enabled: boolean;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  timeoutMs?: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  apiBaseUrl?: string;
  reportChatId: string;
  reportIntervalMinutes: number;
}

export interface DeepForgeConfig {
  research: {
    topic: string;
    description: string;
    maxIterations: number;
    outputDir: string;
    workDir: string;
  };
  agents: Record<AgentRole, AgentConfig>;
  limits: {
    maxTotalCostUsd: number;
    maxIterationCostUsd: number;
    maxConcurrentAgents: number;
  };
  feishu?: FeishuConfig;
  claude: {
    binaryPath?: string;
    env?: Record<string, string>;
  };
}

// ============ Research State ============

export type ResearchPhase =
  | 'initializing'
  | 'planning'
  | 'researching'
  | 'ideating'
  | 'coding'
  | 'benchmarking'
  | 'writing'
  | 'verifying'
  | 'reviewing'
  | 'iterating'
  | 'completed'
  | 'paused'
  | 'failed';

export interface CostSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalCostUsd: number;
}

export interface TaskState {
  id: string;
  role: AgentRole;
  description: string;
  priority: 'high' | 'medium' | 'low';
  context: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: string;
  cost?: CostSummary;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
}

export interface IterationState {
  number: number;
  phase: ResearchPhase;
  tasks: TaskState[];
  leaderPlan?: string;
  leaderSummary?: string;
  reviewFeedback?: string;
  cost: CostSummary;
  startedAt: string;
  completedAt?: string;
}

export interface ForgeState {
  id: string;
  phase: ResearchPhase;
  currentIteration: number;
  iterations: IterationState[];
  totalCost: CostSummary;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// ============ Agent Runner ============

export interface AgentRunResult {
  output: string;
  cost: CostSummary;
  sessionId?: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

// ============ Events (for CLI dashboard) ============

export type ForgeEventType =
  | 'phase_change'
  | 'task_start'
  | 'task_complete'
  | 'task_fail'
  | 'iteration_start'
  | 'iteration_complete'
  | 'alert'
  | 'report_sent'
  | 'cost_update';

export interface ForgeEvent {
  type: ForgeEventType;
  timestamp: string;
  role?: AgentRole;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export function zeroCost(): CostSummary {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalCostUsd: 0 };
}

export function addCost(a: CostSummary, b: CostSummary): CostSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
  };
}
