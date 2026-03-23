/**
 * DeepForge 2.0 — ForgeEventBus
 *
 * Structured event stream with publish/subscribe, wildcard listeners,
 * event filtering, async handler support, error isolation, once-listeners,
 * history ring buffer, and optional JSONL persistence.
 *
 * Improvements over v1:
 * - Types imported from types/event.ts (no inline definitions)
 * - Dedicated 'error' event type with special handling
 * - emitErrorEvents option to auto-emit error events on handler failures
 * - Iteration lifecycle events (iteration_start / iteration_end)
 * - waitFor() utility for promise-based one-shot consumption
 * - removeAllListeners() for cleanup
 * - Typed getHistoryByType with proper narrowing
 *
 * Zero external dependencies beyond Node.js fs/path.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ForgeEventType,
  ForgeEvent,
  ForgeEventInput,
  ForgeEventHandler,
  ForgeEventFilter,
  ForgeEventBusConfig,
} from './types/event';

// Re-export types for convenience
export type {
  ForgeEventType,
  ForgeEvent,
  ForgeEventHandler,
  ForgeEventFilter,
  ForgeEventBusConfig,
} from './types/event';

export type {
  ForgeEventBase,
  ForgeEventSeverity,
  PhaseTransitionEvent,
  IterationStartEvent,
  IterationEndEvent,
  TaskStartEvent,
  TaskDoneEvent,
  TaskFailEvent,
  TaskRetryEvent,
  MiddlewareEnterEvent,
  MiddlewareExitEvent,
  MiddlewareErrorEvent,
  MemoryUpdateEvent,
  MemoryPruneEvent,
  CriticReviewEvent,
  VerifierCheckEvent,
  QualityGateEvent,
  SemaphoreAcquireEvent,
  SemaphoreReleaseEvent,
  SemaphoreTimeoutEvent,
  ConfigChangeEvent,
  DashboardUpdateEvent,
  AlertEvent,
  ErrorEvent,
  ForgeEventPattern,
  ForgeSubscriptionOptions,
  ForgeSubscription,
  ForgeEventByType,
  ForgeEventMap,
} from './types/event';

// ============ Internal Types ============

/** Internal subscription record. */
interface Subscription {
  /** Event type pattern — concrete type string or '*' for all. */
  pattern: ForgeEventType | '*';
  handler: ForgeEventHandler;
  filter?: ForgeEventFilter;
  once: boolean;
}

// ============ ForgeEventBus ============

export class ForgeEventBus {
  // --- singleton ---
  private static instance: ForgeEventBus | null = null;

  /** Get (or create) the singleton bus. */
  static shared(opts?: ForgeEventBusConfig): ForgeEventBus {
    if (!ForgeEventBus.instance) {
      ForgeEventBus.instance = new ForgeEventBus(opts);
    }
    return ForgeEventBus.instance;
  }

  /** Create a fresh, non-singleton bus (useful for tests / sub-systems). */
  static create(opts?: ForgeEventBusConfig): ForgeEventBus {
    return new ForgeEventBus(opts);
  }

  /** Reset the singleton (for testing). */
  static resetShared(): void {
    ForgeEventBus.instance = null;
  }

  // --- instance state ---
  private subs: Subscription[] = [];
  private history: ForgeEvent[] = [];
  private readonly historyLimit: number;
  private readonly jsonlPath: string | undefined;
  private readonly emitErrorEvents: boolean;

  private constructor(opts?: ForgeEventBusConfig) {
    this.historyLimit = opts?.historyLimit ?? 500;
    this.jsonlPath = opts?.jsonlPath;
    this.emitErrorEvents = opts?.emitHandlerErrors ?? true;

    if (this.jsonlPath) {
      const dir = dirname(this.jsonlPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  // ---- publish ----

  /**
   * Emit an event to all matching listeners.
   *
   * Handlers execute sequentially in registration order.
   * If a handler throws, the error is isolated — remaining handlers still run.
   * When `emitErrorEvents` is true, handler failures auto-emit an 'error' event
   * (guarded against infinite recursion).
   */
  async emit(event: ForgeEvent): Promise<void> {
    // Persist first so nothing is lost even if handlers throw
    this.pushHistory(event);
    this.persistEvent(event);

    // Snapshot subscriptions (handlers may call off() during iteration)
    const snapshot = [...this.subs];
    const toRemove: Subscription[] = [];

    for (const sub of snapshot) {
      if (!this.matches(sub, event)) continue;

      try {
        await sub.handler(event);
      } catch (err) {
        // Error isolation: log but never propagate
        console.error(
          `[ForgeEventBus] handler error for "${event.type}":`,
          err,
        );

        // Auto-emit error event (only if enabled and the failing event
        // is not itself an 'error' event, to prevent infinite recursion)
        if (this.emitErrorEvents && event.type !== 'error') {
          const errorEvent: ForgeEvent = {
            type: 'error',
            timestamp: new Date().toISOString(),
            message: `Event handler failed for "${event.type}"`,
            source: 'ForgeEventBus',
            severity: 'error',
            error: err instanceof Error ? err.message : String(err),
            fatal: false,
          };
          // Fire error event but don't await (prevent cascade blocking)
          this.emit(errorEvent).catch(() => {
            // Swallow — last resort, already logged above
          });
        }
      }

      if (sub.once) {
        toRemove.push(sub);
      }
    }

    // Clean up once-listeners
    for (const sub of toRemove) {
      const idx = this.subs.indexOf(sub);
      if (idx !== -1) this.subs.splice(idx, 1);
    }
  }

  // ---- subscribe ----

  /**
   * Register a listener for a specific event type (or '*' for all).
   * Returns an unsubscribe function.
   */
  on<T extends ForgeEvent = ForgeEvent>(
    pattern: ForgeEventType | '*',
    handler: ForgeEventHandler<T>,
    filter?: ForgeEventFilter<T>,
  ): () => void {
    const sub: Subscription = {
      pattern,
      handler: handler as ForgeEventHandler,
      filter: filter as ForgeEventFilter | undefined,
      once: false,
    };
    this.subs.push(sub);
    return () => this.removeSub(sub);
  }

  /**
   * Register a one-shot listener — automatically removed after first match.
   * Returns an unsubscribe function (in case you want to cancel before it fires).
   */
  once<T extends ForgeEvent = ForgeEvent>(
    pattern: ForgeEventType | '*',
    handler: ForgeEventHandler<T>,
    filter?: ForgeEventFilter<T>,
  ): () => void {
    const sub: Subscription = {
      pattern,
      handler: handler as ForgeEventHandler,
      filter: filter as ForgeEventFilter | undefined,
      once: true,
    };
    this.subs.push(sub);
    return () => this.removeSub(sub);
  }

  /**
   * Wait for the next event matching a pattern (and optional filter).
   * Returns a promise that resolves with the matching event.
   * Useful for async coordination: `await bus.waitFor('task_done')`.
   */
  waitFor<T extends ForgeEvent = ForgeEvent>(
    pattern: ForgeEventType | '*',
    filter?: ForgeEventFilter<T>,
    timeoutMs?: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const unsub = this.once<T>(pattern, (event) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      }, filter);

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          unsub();
          reject(new Error(`waitFor("${pattern}") timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /** Remove a previously registered handler by reference. */
  off(
    pattern: ForgeEventType | '*',
    handler: ForgeEventHandler,
  ): void {
    const idx = this.subs.findIndex(
      (s) => s.pattern === pattern && s.handler === handler,
    );
    if (idx !== -1) this.subs.splice(idx, 1);
  }

  /** Remove all listeners, optionally filtered by pattern. */
  removeAllListeners(pattern?: ForgeEventType | '*'): void {
    if (pattern === undefined) {
      this.subs = [];
    } else {
      this.subs = this.subs.filter((s) => s.pattern !== pattern);
    }
  }

  // ---- history ----

  /** Return the last `n` events (default: all in buffer). */
  getHistory(n?: number): ReadonlyArray<ForgeEvent> {
    if (n === undefined) return [...this.history];
    return this.history.slice(-n);
  }

  /** Return history entries that match a type (and optional filter). */
  getHistoryByType<T extends ForgeEvent>(
    type: ForgeEventType,
    filter?: ForgeEventFilter<T>,
  ): T[] {
    const typed = this.history.filter((e) => e.type === type) as T[];
    return filter ? typed.filter(filter) : typed;
  }

  /** Clear the in-memory history buffer. */
  clearHistory(): void {
    this.history = [];
  }

  // ---- introspection ----

  /** Current number of active subscriptions. */
  get listenerCount(): number {
    return this.subs.length;
  }

  /** Number of listeners for a specific pattern. */
  listenerCountFor(pattern: ForgeEventType | '*'): number {
    return this.subs.filter((s) => s.pattern === pattern).length;
  }

  /** Number of events in the history buffer. */
  get historySize(): number {
    return this.history.length;
  }

  // ---- internals ----

  private matches(sub: Subscription, event: ForgeEvent): boolean {
    if (sub.pattern !== '*' && sub.pattern !== event.type) return false;
    if (sub.filter && !sub.filter(event)) return false;
    return true;
  }

  private removeSub(sub: Subscription): void {
    const idx = this.subs.indexOf(sub);
    if (idx !== -1) this.subs.splice(idx, 1);
  }

  private pushHistory(event: ForgeEvent): void {
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }

  private persistEvent(event: ForgeEvent): void {
    if (!this.jsonlPath) return;
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ForgeEventBus] JSONL write error:', err);
    }
  }
}

// ============ Helper: create typed events ============

/** Convenience factory — fills in timestamp automatically. */
export function createForgeEvent<T extends ForgeEvent = ForgeEvent>(
  partial: ForgeEventInput,
): T {
  return {
    ...partial,
    timestamp: partial.timestamp ?? new Date().toISOString(),
  } as T;
}
