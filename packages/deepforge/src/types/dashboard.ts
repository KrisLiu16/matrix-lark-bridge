/**
 * DeepForge 2.0 — Dashboard State Types
 *
 * Aggregated state types for the GUI dashboard layer.
 * Derives computed views from ForgeState + ForgeEvent, providing
 * a unified snapshot for real-time UI rendering.
 *
 * This is a v2-only module (no v1 equivalent exists).
 *
 * Dependencies: ForgePhase from ./middleware, ForgeTask defined locally
 * (minimal interface mirroring the source ForgeTask for dashboard use).
 *
 * @module types/dashboard
 */

import type { ForgePhase } from './middleware';

/**
 * Minimal ForgeTask interface for dashboard consumption.
 * Mirrors the canonical ForgeTask from the DeepForge source types.ts.
 * When integrated with the engine, replace with: import type { ForgeTask } from '../../types.js';
 */
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

// ============ Task Summary ============

/** Aggregate task counts for a single iteration or the entire run. */
export interface TaskSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

// ============ Iteration Summary ============

/** Condensed view of one iteration for dashboard display. */
export interface IterationSummary {
  /** Iteration number (0-based). */
  number: number;
  /** Phase when this summary was captured. */
  phase: ForgePhase;
  /** Aggregate task counts. */
  taskSummary: TaskSummary;
  /** Cumulative cost for this iteration in USD. */
  costUsd: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the Critic cleared this iteration. */
  criticCleared?: boolean;
  /** Whether the Verifier passed this iteration. */
  verifierPassed?: boolean;
}

// ============ Phase Progress ============

/** Progress tracking for the current phase. */
export interface PhaseProgress {
  /** Current phase. */
  phase: ForgePhase;
  /** 0–1 completion fraction (e.g. 3 of 5 tasks done = 0.6). */
  progress: number;
  /** Human-readable status message. */
  message: string;
  /** Phase start time ISO-8601. */
  startedAt: string;
  /** Estimated completion time ISO-8601, if available. */
  estimatedEndAt?: string;
}

// ============ Agent Status ============

/** Real-time status of a single agent/role in the system. */
export interface AgentStatus {
  /** Role name (e.g. "core-dev", "critic"). */
  role: string;
  /** Display label (e.g. "Core Developer"). */
  label: string;
  /** Current agent state. */
  state: 'idle' | 'running' | 'completed' | 'failed' | 'waiting';
  /** ID of the task currently being executed, if any. */
  currentTaskId?: string;
  /** Number of tasks completed by this agent in the current iteration. */
  tasksCompleted: number;
  /** Number of tasks failed by this agent in the current iteration. */
  tasksFailed: number;
  /** Cost incurred by this agent in USD. */
  costUsd: number;
  /** Last activity time ISO-8601. */
  lastActivityAt?: string;
}

// ============ Notification Item ============

/** A notification entry for the dashboard notification feed. */
export interface NotificationItem {
  /** Unique notification ID. */
  id: string;
  /** Notification severity / visual style. */
  severity: 'info' | 'success' | 'warning' | 'error';
  /** Short title. */
  title: string;
  /** Detailed message body. */
  message: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Source role that triggered this notification. */
  source?: string;
  /** Whether the user has dismissed/read this notification. */
  read: boolean;
}

// ============ Dashboard Event ============

/** Simplified event record for the real-time event feed in the UI. */
export interface DashboardEvent {
  /** Event type string (matches ForgeEventType). */
  type: string;
  /** Human-readable event description. */
  message: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Visual severity for UI styling. */
  severity: 'info' | 'success' | 'warning' | 'error';
}

// ============ Dashboard Config ============

/** Configuration for dashboard behavior. */
export interface DashboardConfig {
  /** Maximum number of recent events to keep in the feed. */
  maxRecentEvents: number;
  /** Maximum number of notifications to retain. */
  maxNotifications: number;
  /** Auto-refresh interval in milliseconds (0 = manual only). */
  refreshIntervalMs: number;
  /** Whether to show cost information. */
  showCosts: boolean;
  /** Whether to show agent-level detail. */
  showAgentDetail: boolean;
}

// ============ Dashboard State ============

/** Top-level aggregated state for the dashboard UI. */
export interface DashboardState {
  /** Project ID. */
  projectId: string;
  /** Project title. */
  title: string;
  /** Current phase. */
  phase: ForgePhase;
  /** Current iteration number. */
  currentIteration: number;
  /** Total cost incurred in USD. */
  totalCostUsd: number;
  /** Total elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
  /** Per-iteration summaries. */
  iterations: IterationSummary[];
  /** Currently active tasks. */
  activeTasks: ForgeTask[];
  /** Current phase progress. */
  phaseProgress: PhaseProgress;
  /** Per-agent status. */
  agents: AgentStatus[];
  /** Recent events for the live feed. */
  recentEvents: DashboardEvent[];
  /** Notification items. */
  notifications: NotificationItem[];
  /** Consecutive failure count (circuit-breaker indicator). */
  consecutiveFailures: number;
  /** Last updated ISO-8601. */
  updatedAt: string;
}

// ============ Dashboard Update Hook ============

/** Callback invoked whenever the dashboard state changes. */
export type DashboardUpdateFn = (state: DashboardState) => void;

// ============ Dashboard Defaults ============

/** Default dashboard configuration values. */
export const DEFAULT_DASHBOARD_CONFIG: Readonly<DashboardConfig> = {
  maxRecentEvents: 50,
  maxNotifications: 100,
  refreshIntervalMs: 2000,
  showCosts: true,
  showAgentDetail: true,
};
