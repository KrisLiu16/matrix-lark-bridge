/**
 * DeepForge 2.0 — Event System Types
 *
 * Defines all event-related types for the ForgeEventBus:
 * - ForgeEventType: all recognised event categories
 * - ForgeEvent: discriminated union of typed event payloads
 * - Handler, filter, subscription, and bus configuration types
 *
 * Improvements over v1:
 * - Each event type has its own interface (better type narrowing)
 * - Added correlationId for cross-event tracing
 * - Added quality_gate, memory_prune, semaphore_timeout, dashboard_update events
 * - Subscription options and internal subscription record types
 * - Utility types: ForgeEventByType, ForgeEventMap
 *
 * @module types/event
 */

// ============ Event Type Enum ============

/**
 * All recognised event categories in the Forge system.
 *
 * Naming convention: `domain_action` (snake_case).
 */
export type ForgeEventType =
  // Phase lifecycle
  | 'phase_transition'
  // Iteration lifecycle
  | 'iteration_start'
  | 'iteration_end'
  // Task lifecycle
  | 'task_start'
  | 'task_done'
  | 'task_fail'
  | 'task_retry'
  // Middleware pipeline
  | 'middleware_enter'
  | 'middleware_exit'
  | 'middleware_error'
  // Memory system
  | 'memory_update'
  | 'memory_prune'
  // Quality & feedback
  | 'critic_review'
  | 'verifier_check'
  | 'quality_gate'
  // Concurrency control
  | 'semaphore_acquire'
  | 'semaphore_release'
  | 'semaphore_timeout'
  // Configuration
  | 'config_change'
  // Dashboard / reporting
  | 'dashboard_update'
  // System-level
  | 'alert'
  | 'error';

// ============ Severity ============

/** Alert and error severity levels, ordered from least to most severe. */
export type ForgeEventSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ============ Base Event ============

/**
 * Fields shared by every Forge event.
 *
 * All concrete event interfaces extend this base.
 * The `type` field acts as the discriminant for the `ForgeEvent` union.
 */
export interface ForgeEventBase {
  /** Event category — used as discriminant for the union. */
  type: ForgeEventType;
  /** ISO-8601 timestamp of when the event was created. */
  timestamp: string;
  /** Human-readable summary of the event. */
  message: string;
  /** Optional correlation ID for tracing related events across a pipeline run. */
  correlationId?: string;
  /** Source subsystem or component that emitted the event. */
  source?: string;
}

// ============ Concrete Event Interfaces ============

/** Emitted when the forge transitions between phases. */
export interface PhaseTransitionEvent extends ForgeEventBase {
  type: 'phase_transition';
  /** Phase being left. */
  from: string;
  /** Phase being entered. */
  to: string;
}

/** Emitted at the start of a new iteration. */
export interface IterationStartEvent extends ForgeEventBase {
  type: 'iteration_start';
  /** Zero-based iteration number. */
  iteration: number;
  /** Number of tasks planned for this iteration. */
  plannedTaskCount: number;
}

/** Emitted when an iteration completes. */
export interface IterationEndEvent extends ForgeEventBase {
  type: 'iteration_end';
  /** Zero-based iteration number. */
  iteration: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the iteration was considered successful. */
  success: boolean;
}

/** Emitted when a task begins execution. */
export interface TaskStartEvent extends ForgeEventBase {
  type: 'task_start';
  /** Unique task identifier. */
  taskId: string;
  /** Role responsible for this task. */
  role: string;
}

/** Emitted when a task completes successfully. */
export interface TaskDoneEvent extends ForgeEventBase {
  type: 'task_done';
  /** Unique task identifier. */
  taskId: string;
  /** Role responsible for this task. */
  role: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Cost incurred (USD). */
  costUsd?: number;
}

/** Emitted when a task fails. */
export interface TaskFailEvent extends ForgeEventBase {
  type: 'task_fail';
  /** Unique task identifier. */
  taskId: string;
  /** Role responsible for this task. */
  role: string;
  /** Error description. */
  error: string;
}

/** Emitted when a task is being retried. */
export interface TaskRetryEvent extends ForgeEventBase {
  type: 'task_retry';
  /** Unique task identifier. */
  taskId: string;
  /** Role responsible for this task. */
  role: string;
  /** Current retry attempt (1-based). */
  attempt: number;
  /** Reason for retry. */
  reason: string;
}

/** Emitted when a middleware begins processing. */
export interface MiddlewareEnterEvent extends ForgeEventBase {
  type: 'middleware_enter';
  /** Registered middleware name. */
  middlewareName: string;
  /** Hook point at which the middleware is running. */
  hook: string;
}

/** Emitted when a middleware completes processing. */
export interface MiddlewareExitEvent extends ForgeEventBase {
  type: 'middleware_exit';
  /** Registered middleware name. */
  middlewareName: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/** Emitted when a middleware throws an error. */
export interface MiddlewareErrorEvent extends ForgeEventBase {
  type: 'middleware_error';
  /** Registered middleware name. */
  middlewareName: string;
  /** Error description. */
  error: string;
  /** Whether the pipeline continued after this error. */
  recovered: boolean;
}

/** Emitted when the memory store is updated. */
export interface MemoryUpdateEvent extends ForgeEventBase {
  type: 'memory_update';
  /** Total number of entries after the update. */
  entryCount: number;
  /** The subsystem that triggered the update. */
  updateSource: string;
}

/** Emitted when memory entries are pruned. */
export interface MemoryPruneEvent extends ForgeEventBase {
  type: 'memory_prune';
  /** Number of entries removed. */
  prunedCount: number;
  /** Number of entries remaining. */
  remainingCount: number;
}

/** Emitted when the critic reviews iteration output. */
export interface CriticReviewEvent extends ForgeEventBase {
  type: 'critic_review';
  /** Iteration being reviewed. */
  iteration: number;
  /** Whether the output passed review. */
  passed: boolean;
  /** Critic's feedback text. */
  feedback: string;
}

/** Emitted when the verifier checks facts/quality. */
export interface VerifierCheckEvent extends ForgeEventBase {
  type: 'verifier_check';
  /** Iteration being verified. */
  iteration: number;
  /** Whether verification passed. */
  passed: boolean;
  /** Verifier's result text. */
  result: string;
}

/** Emitted when a quality gate is evaluated. */
export interface QualityGateEvent extends ForgeEventBase {
  type: 'quality_gate';
  /** Name of the quality gate (e.g. 'accuracy', 'completeness'). */
  gateName: string;
  /** Whether the gate passed. */
  passed: boolean;
  /** Numeric score (0–1), if applicable. */
  score?: number;
  /** Reason for pass/fail. */
  reason: string;
}

/** Emitted when the semaphore grants a permit. */
export interface SemaphoreAcquireEvent extends ForgeEventBase {
  type: 'semaphore_acquire';
  /** Task that acquired the permit. */
  taskId: string;
  /** Number of permits currently in use. */
  activeCount: number;
  /** Maximum permits available. */
  maxPermits: number;
}

/** Emitted when the semaphore releases a permit. */
export interface SemaphoreReleaseEvent extends ForgeEventBase {
  type: 'semaphore_release';
  /** Task that released the permit. */
  taskId: string;
  /** Number of permits currently in use after release. */
  activeCount: number;
}

/** Emitted when a semaphore acquire times out. */
export interface SemaphoreTimeoutEvent extends ForgeEventBase {
  type: 'semaphore_timeout';
  /** Task that timed out waiting. */
  taskId: string;
  /** How long it waited before timing out (ms). */
  waitedMs: number;
}

/** Emitted when a configuration value changes. */
export interface ConfigChangeEvent extends ForgeEventBase {
  type: 'config_change';
  /** Dot-separated config key that changed. */
  key: string;
  /** Previous value. */
  oldValue: unknown;
  /** New value. */
  newValue: unknown;
}

/** Emitted when dashboard state is refreshed. */
export interface DashboardUpdateEvent extends ForgeEventBase {
  type: 'dashboard_update';
  /** Snapshot of key metrics (name → numeric value). */
  metrics: Record<string, number>;
}

/** Generic alert for operational notifications. */
export interface AlertEvent extends ForgeEventBase {
  type: 'alert';
  /** Alert severity. */
  severity: ForgeEventSeverity;
  /** Additional detail text. */
  detail?: string;
}

/** System error event. */
export interface ErrorEvent extends ForgeEventBase {
  type: 'error';
  /** Error severity. */
  severity: ForgeEventSeverity;
  /** Error message or stack trace. */
  error: string;
  /** Whether the system can continue operating. */
  fatal: boolean;
}

// ============ Discriminated Union ============

/**
 * Discriminated union of all Forge event shapes.
 *
 * Use `event.type` to narrow to a specific interface:
 *
 * @example
 * ```ts
 * function handle(event: ForgeEvent) {
 *   switch (event.type) {
 *     case 'task_done':
 *       console.log(event.durationMs); // narrowed to TaskDoneEvent
 *       break;
 *     case 'phase_transition':
 *       console.log(event.from, event.to); // narrowed to PhaseTransitionEvent
 *       break;
 *   }
 * }
 * ```
 */
export type ForgeEvent =
  | PhaseTransitionEvent
  | IterationStartEvent
  | IterationEndEvent
  | TaskStartEvent
  | TaskDoneEvent
  | TaskFailEvent
  | TaskRetryEvent
  | MiddlewareEnterEvent
  | MiddlewareExitEvent
  | MiddlewareErrorEvent
  | MemoryUpdateEvent
  | MemoryPruneEvent
  | CriticReviewEvent
  | VerifierCheckEvent
  | QualityGateEvent
  | SemaphoreAcquireEvent
  | SemaphoreReleaseEvent
  | SemaphoreTimeoutEvent
  | ConfigChangeEvent
  | DashboardUpdateEvent
  | AlertEvent
  | ErrorEvent;

// ============ Handler & Filter Types ============

/**
 * Async-compatible event handler function.
 *
 * Handlers may return void (sync) or Promise<void> (async).
 * Errors thrown by handlers are caught by the event bus and do not
 * propagate to the emitter.
 */
export type ForgeEventHandler<T extends ForgeEvent = ForgeEvent> = (
  event: T,
) => void | Promise<void>;

/**
 * Predicate function to filter events before they reach a handler.
 *
 * Return `true` to allow the event through, `false` to skip it.
 */
export type ForgeEventFilter<T extends ForgeEvent = ForgeEvent> = (
  event: T,
) => boolean;

// ============ Subscription Types ============

/** Event pattern for matching — a concrete type or wildcard. */
export type ForgeEventPattern = ForgeEventType | '*';

/**
 * Options when creating a subscription via `eventBus.on()` or `eventBus.once()`.
 */
export interface ForgeSubscriptionOptions<T extends ForgeEvent = ForgeEvent> {
  /** Event type to listen for, or '*' for all events. */
  pattern: ForgeEventPattern;
  /** The handler to invoke on matching events. */
  handler: ForgeEventHandler<T>;
  /** Optional filter predicate applied before the handler. */
  filter?: ForgeEventFilter<T>;
  /** If true, the subscription is removed after the first matching event. */
  once?: boolean;
}

/**
 * Internal subscription record stored by the event bus.
 */
export interface ForgeSubscription {
  /** Unique subscription ID for tracking. */
  id: string;
  /** Event type pattern — concrete type or '*'. */
  pattern: ForgeEventPattern;
  /** The handler function reference. */
  handler: ForgeEventHandler;
  /** Optional filter predicate. */
  filter?: ForgeEventFilter;
  /** Whether this is a one-shot subscription. */
  once: boolean;
}

// ============ Event Bus Configuration ============

/**
 * Configuration for the ForgeEventBus.
 */
export interface ForgeEventBusConfig {
  /** Maximum events kept in the in-memory ring buffer. Default: 500. */
  historyLimit?: number;
  /** Path to append-only JSONL persistence file. Undefined = no persistence. */
  jsonlPath?: string;
  /** Whether to log events to console for debugging. Default: false. */
  debugLog?: boolean;
  /** Event types to exclude from history/persistence (e.g. high-frequency types). */
  excludeFromHistory?: ForgeEventType[];
  /** Whether to emit 'error' events when handlers throw. Default: true. */
  emitHandlerErrors?: boolean;
}

// ============ Utility Types ============

/**
 * Extract the event interface for a given event type string.
 *
 * @example
 * ```ts
 * type T = ForgeEventByType<'task_done'>; // TaskDoneEvent
 * ```
 */
export type ForgeEventByType<K extends ForgeEventType> = Extract<
  ForgeEvent,
  { type: K }
>;

/**
 * Map from event type to its event interface.
 *
 * Useful for building typed event factories or type-safe emit wrappers.
 */
export type ForgeEventMap = {
  [K in ForgeEventType]: ForgeEventByType<K>;
};

// ============ Distributive Input Type ============

/**
 * Distributive Omit that works correctly on union types.
 *
 * Standard `Omit<Union, K>` collapses the union to its common properties.
 * This distributes `Omit` across each member of the union individually.
 */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/**
 * Input type for `createForgeEvent()`.
 *
 * Each union member has `timestamp` made optional while preserving all
 * domain-specific fields (taskId, middlewareName, prunedCount, etc.).
 * This fixes TS2353 errors that occur when the non-distributive
 * `Omit<ForgeEvent, 'timestamp'>` strips domain fields.
 */
export type ForgeEventInput = DistributiveOmit<ForgeEvent, 'timestamp'> & { timestamp?: string };
