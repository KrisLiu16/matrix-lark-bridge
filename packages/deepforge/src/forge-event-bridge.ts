/**
 * DeepForge 2.0 — Event System Bridge Adapter
 *
 * Bridges the legacy onEvent(type, data) callback pattern used in
 * forge-engine.ts to the structured ForgeEventBus system.
 *
 * Provides helpers to emit well-typed phase_transition and iteration
 * events using the createForgeEvent() factory.
 *
 * Zero external dependencies. No unchecked type assertions.
 */

import type { ForgeEventBus } from './forge-events';
import { createForgeEvent } from './forge-events';
import type {
  ForgeEvent,
  PhaseTransitionEvent,
  IterationStartEvent,
  IterationEndEvent,
  TaskStartEvent,
  TaskDoneEvent,
  TaskFailEvent,
  CriticReviewEvent,
  AlertEvent,
} from './types/event';

// ============ Legacy Types ============

/**
 * The legacy ForgeEvent shape from v1 (src/types.ts).
 * Used only for bridging — new code should use the typed ForgeEvent union.
 */
export interface LegacyForgeEvent {
  type: 'phase' | 'task_start' | 'task_done' | 'task_fail' | 'critic' | 'alert';
  message: string;
  role?: string;
  taskId?: string;
  timestamp: string;
}

/** Legacy onEvent callback signature from v1 ForgeEngine constructor. */
export type LegacyOnEventCallback = (event: LegacyForgeEvent) => void;

// ============ Legacy → New Type Mapping ============

/**
 * Convert a new ForgeEvent into a legacy ForgeEvent for the old callback.
 *
 * Maps new event types back to the v1 type set. Unknown types are
 * mapped to 'alert' as a safe fallback.
 */
function toLegacyEvent(event: ForgeEvent): LegacyForgeEvent {
  const base: LegacyForgeEvent = {
    type: 'alert',
    message: event.message,
    timestamp: event.timestamp,
  };

  switch (event.type) {
    case 'phase_transition':
      base.type = 'phase';
      break;
    case 'task_start':
      base.type = 'task_start';
      base.role = event.role;
      base.taskId = event.taskId;
      break;
    case 'task_done':
      base.type = 'task_done';
      base.role = event.role;
      base.taskId = event.taskId;
      break;
    case 'task_fail':
      base.type = 'task_fail';
      base.role = event.role;
      base.taskId = event.taskId;
      break;
    case 'task_retry':
      base.type = 'task_start'; // retry maps to task_start in legacy
      base.role = event.role;
      base.taskId = event.taskId;
      break;
    case 'critic_review':
      base.type = 'critic';
      break;
    case 'verifier_check':
      base.type = 'critic'; // verifier maps to critic in legacy
      break;
    case 'alert':
    case 'error':
      base.type = 'alert';
      break;
    default:
      // All other new event types (middleware, memory, semaphore, etc.)
      // have no legacy equivalent — map to 'alert'
      base.type = 'alert';
      break;
  }

  return base;
}

// ============ Bridge Functions ============

/**
 * Bridge a legacy onEvent callback to ForgeEventBus.
 *
 * Subscribes to all events on the bus via wildcard ('*') and converts
 * each structured event into the flat legacy format before forwarding
 * to the callback.
 *
 * Returns an unsubscribe function so the bridge can be torn down.
 *
 * @example
 * ```ts
 * const unsub = bridgeOnEventCallback(eventBus, (event) => {
 *   console.log(`[${event.type}] ${event.message}`);
 * });
 * // later: unsub();
 * ```
 */
export function bridgeOnEventCallback(
  eventBus: ForgeEventBus,
  onEvent: LegacyOnEventCallback,
): () => void {
  return eventBus.on('*', (event: ForgeEvent) => {
    onEvent(toLegacyEvent(event));
  });
}

/**
 * Emit a structured phase_transition event.
 *
 * @param eventBus - The event bus to emit on.
 * @param toPhase  - The phase being entered.
 * @param fromPhase - The phase being left (defaults to 'unknown').
 */
export async function emitPhaseTransition(
  eventBus: ForgeEventBus,
  toPhase: string,
  fromPhase: string = 'unknown',
): Promise<void> {
  const event = createForgeEvent<PhaseTransitionEvent>({
    type: 'phase_transition',
    from: fromPhase,
    to: toPhase,
    message: `Phase → ${toPhase}`,
    source: 'ForgeEngine',
  });
  await eventBus.emit(event);
}

// ============ Iteration Events ============

/**
 * Emit an iteration_start event.
 *
 * @param eventBus       - The event bus to emit on.
 * @param iteration      - Zero-based iteration number.
 * @param plannedTaskCount - Number of tasks planned for this iteration.
 * @param correlationId  - Optional correlation ID for tracing.
 */
export async function emitIterationStart(
  eventBus: ForgeEventBus,
  iteration: number,
  plannedTaskCount: number,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<IterationStartEvent>({
    type: 'iteration_start',
    iteration,
    plannedTaskCount,
    message: `Iteration ${iteration} started (${plannedTaskCount} tasks)`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

/**
 * Emit an iteration_end event.
 *
 * @param eventBus      - The event bus to emit on.
 * @param iteration     - Zero-based iteration number.
 * @param durationMs    - Wall-clock duration in milliseconds.
 * @param success       - Whether the iteration was considered successful.
 * @param correlationId - Optional correlation ID for tracing.
 */
export async function emitIterationEnd(
  eventBus: ForgeEventBus,
  iteration: number,
  durationMs: number,
  success: boolean,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<IterationEndEvent>({
    type: 'iteration_end',
    iteration,
    durationMs,
    success,
    message: `Iteration ${iteration} ${success ? 'completed' : 'failed'} (${durationMs}ms)`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

/**
 * Convenience: emit both iteration_start at the beginning and return
 * a finalizer that emits iteration_end with timing.
 *
 * @example
 * ```ts
 * const finalize = await emitIterationLifecycle(eventBus, 0, 5);
 * // ... run iteration tasks ...
 * await finalize(true); // emits iteration_end with duration
 * ```
 */
export async function emitIterationLifecycle(
  eventBus: ForgeEventBus,
  iteration: number,
  plannedTaskCount: number,
  correlationId?: string,
): Promise<(success: boolean) => Promise<void>> {
  const startTime = Date.now();
  await emitIterationStart(eventBus, iteration, plannedTaskCount, correlationId);

  return async (success: boolean): Promise<void> => {
    const durationMs = Date.now() - startTime;
    await emitIterationEnd(eventBus, iteration, durationMs, success, correlationId);
  };
}

// ============ Task Events ============

/**
 * Emit a task_start event.
 */
export async function emitTaskStart(
  eventBus: ForgeEventBus,
  taskId: string,
  role: string,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<TaskStartEvent>({
    type: 'task_start',
    taskId,
    role,
    message: `${role}: ${taskId}`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

/**
 * Emit a task_done event.
 */
export async function emitTaskDone(
  eventBus: ForgeEventBus,
  taskId: string,
  role: string,
  durationMs: number,
  costUsd?: number,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<TaskDoneEvent>({
    type: 'task_done',
    taskId,
    role,
    durationMs,
    costUsd,
    message: `${role}: ${taskId} completed (${durationMs}ms)`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

/**
 * Emit a task_fail event.
 */
export async function emitTaskFail(
  eventBus: ForgeEventBus,
  taskId: string,
  role: string,
  error: string,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<TaskFailEvent>({
    type: 'task_fail',
    taskId,
    role,
    error,
    message: `${role}: ${taskId} failed — ${error}`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

// ============ Review Events ============

/**
 * Emit a critic_review event.
 */
export async function emitCriticReview(
  eventBus: ForgeEventBus,
  iteration: number,
  passed: boolean,
  feedback: string,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<CriticReviewEvent>({
    type: 'critic_review',
    iteration,
    passed,
    feedback,
    message: `Critic: ${passed ? 'PASS' : 'FAIL'} (iteration ${iteration})`,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}

// ============ Alert Helper ============

/**
 * Emit a structured alert event.
 */
export async function emitAlert(
  eventBus: ForgeEventBus,
  message: string,
  severity: AlertEvent['severity'] = 'info',
  detail?: string,
  correlationId?: string,
): Promise<void> {
  const event = createForgeEvent<AlertEvent>({
    type: 'alert',
    severity,
    message,
    detail,
    source: 'ForgeEngine',
    correlationId,
  });
  await eventBus.emit(event);
}
