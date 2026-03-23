/**
 * Forge — Multi-Agent Orchestration Module (within bridge)
 * Generic types for dynamic team composition and iterative execution.
 */

// ============ Dynamic Role ============

export interface ForgeRoleConfig {
  name: string;           // e.g., "market_researcher", "backend_dev"
  label: string;          // Display name: "市场调研员", "后端开发"
  description: string;    // What this role does
  systemPrompt: string;   // Full system prompt for this role's CC
}

// Framework-enforced roles (always present, cannot be skipped)
export const FORCED_ROLES = ['leader', 'critic', 'verifier'] as const;
export type ForcedRole = typeof FORCED_ROLES[number];

// ============ Forge Project ============

export interface ForgeProject {
  id: string;
  title: string;
  description: string;
  roles: ForgeRoleConfig[];
  model: string;
  effort: string;
  maxConcurrent: number;       // 默认 5
  createdAt: string;
  createdBy: string;
  chatId: string;
  noCritic?: boolean;          // 跳过 Critic（默认 false，即默认有 Critic）
  noVerifier?: boolean;        // 跳过 Verifier（默认 false）
}

// ============ State ============

/** @deprecated Use `import type { ForgePhase } from './types/middleware'` instead */
export type ForgePhase =
  | 'setup'         // Leader designs team (only iteration 0)
  | 'planning'      // Leader plans this iteration
  | 'executing'     // Dynamic roles execute in sequence
  | 'critiquing'    // Critic reviews all output (forced)
  | 'verifying'     // Verifier checks facts (forced)
  | 'iterating'     // Leader summarizes and decides next
  | 'completing'    // Packaging deliverables and generating report
  | 'paused'
  | 'completed';

/** @deprecated Use `import type { ForgeTask } from './types/dashboard'` instead */
export interface ForgeTask {
  id: string;
  role: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  costUsd?: number;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ForgeIteration {
  number: number;
  tasks: ForgeTask[];
  criticFeedback?: string;
  verifierResult?: string;
  leaderSummary?: string;
  verifierPassed?: boolean;
  criticCleared?: boolean;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
}

export interface ForgeState {
  projectId: string;
  phase: ForgePhase;
  currentIteration: number;
  iterations: ForgeIteration[];
  totalCostUsd: number;
  consecutiveFailures: number;
  updatedAt: string;
}

// ============ Events ============

/** @deprecated Use `import type { ForgeEvent } from './types/event'` instead */
export interface ForgeEvent {
  type: 'phase' | 'task_start' | 'task_done' | 'task_fail' | 'critic' | 'alert';
  message: string;
  role?: string;
  taskId?: string;
  timestamp: string;
}

// ============ v2 Type Re-exports (non-conflicting) ============
// For types that conflict with v1 definitions above (ForgeEvent, ForgePhase, ForgeTask),
// import directly from the specific module:
//   import type { ForgeEvent } from './types/event';       // 22-member discriminated union
//   import type { ForgePhase } from './types/middleware';   // identical to v1, with middleware context
//   import type { ForgeTask } from './types/dashboard';    // identical to v1, with dashboard context

export * from './types/config';
export * from './types/memory';
export * from './types/quality';

// Aliased re-exports for v2 conflicting types — use these for gradual migration
export { ForgeEvent as ForgeEventV2 } from './types/event';
export { ForgePhase as ForgePhaseV2 } from './types/middleware';
