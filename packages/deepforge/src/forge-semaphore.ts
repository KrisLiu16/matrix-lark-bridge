/**
 * forge-semaphore.ts — Event-driven AsyncSemaphore for DeepForge 2.0
 *
 * Replaces the polling-based concurrency limiter in forge-engine.ts
 * with a proper FIFO queue and instant wake-up via Promise resolution.
 *
 * Improvements over v1:
 * - AbortSignal support for cancellable acquire
 * - Weighted acquire (consume multiple slots at once)
 * - drain() to wait for all running tasks to finish
 * - Cumulative stats (totalAcquired, totalReleased, totalTimedOut)
 * - runAll() batch helper
 *
 * Zero external dependencies. Pure TypeScript.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback hooks for semaphore lifecycle events. */
export interface SemaphoreCallbacks {
  onAcquire?: (stats: SemaphoreStats) => void;
  onRelease?: (stats: SemaphoreStats) => void;
  onTimeout?: (stats: SemaphoreStats) => void;
}

/** Snapshot of semaphore state at a point in time. */
export interface SemaphoreStats {
  /** Number of slots currently held. */
  running: number;
  /** Number of callers waiting in the queue. */
  waiting: number;
  /** Number of slots available right now. */
  available: number;
  /** Maximum concurrent slots. */
  max: number;
  /** Total successful acquisitions since creation. */
  totalAcquired: number;
  /** Total releases since creation. */
  totalReleased: number;
  /** Total timeouts since creation. */
  totalTimedOut: number;
}

/** Options for acquire(). */
export interface AcquireOptions {
  /** Timeout in ms. 0 = no timeout (default). */
  timeoutMs?: number;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
  /** Number of slots to acquire. Default 1. */
  weight?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Semaphore acquire timed out after ${timeoutMs}ms`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export class SemaphoreDisposedError extends Error {
  constructor() {
    super('Semaphore has been disposed');
    this.name = 'SemaphoreDisposedError';
  }
}

export class SemaphoreAbortError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Semaphore acquire was aborted');
    this.name = 'SemaphoreAbortError';
  }
}

// ---------------------------------------------------------------------------
// Internal waiter entry
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
  weight: number;
}

// ---------------------------------------------------------------------------
// AsyncSemaphore
// ---------------------------------------------------------------------------

/**
 * Promise-driven async semaphore with FIFO queue.
 *
 * Drop-in replacement for the polling-based `waitSlot()` pattern
 * found in forge-engine.ts. Provides instant wake-up, timeout support,
 * AbortSignal cancellation, and dynamic concurrency adjustment.
 *
 * @example
 * ```ts
 * const sem = new AsyncSemaphore(3);
 *
 * // Basic usage
 * await sem.acquire();
 * try { await doWork(); } finally { sem.release(); }
 *
 * // Convenience wrapper
 * const result = await sem.withLock(() => doWork());
 *
 * // With timeout
 * await sem.acquire({ timeoutMs: 5000 });
 *
 * // With AbortSignal
 * const ctrl = new AbortController();
 * await sem.acquire({ signal: ctrl.signal });
 *
 * // Non-blocking
 * if (sem.tryAcquire()) { ... sem.release(); }
 *
 * // Batch execution with concurrency limit
 * const results = await sem.runAll(tasks, task => task.execute());
 * ```
 */
export class AsyncSemaphore {
  private _max: number;
  private _running = 0;
  private _queue: Waiter[] = [];
  private _disposed = false;
  private _callbacks: SemaphoreCallbacks;

  // Cumulative counters
  private _totalAcquired = 0;
  private _totalReleased = 0;
  private _totalTimedOut = 0;

  // Drain support
  private _drainResolvers: Array<() => void> = [];

  constructor(max: number, callbacks: SemaphoreCallbacks = {}) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`max must be a positive integer, got ${max}`);
    }
    this._max = max;
    this._callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Acquire one or more slots. Resolves immediately if slots are free,
   * otherwise enqueues the caller (FIFO) until slots are released.
   *
   * @throws {SemaphoreTimeoutError} if `timeoutMs > 0` and the slot
   *   is not acquired within that window.
   * @throws {SemaphoreDisposedError} if the semaphore is disposed while
   *   the caller is waiting.
   * @throws {SemaphoreAbortError} if the provided AbortSignal is triggered.
   */
  async acquire(opts: AcquireOptions = {}): Promise<void> {
    this._ensureNotDisposed();

    const weight = opts.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1) {
      throw new RangeError(`weight must be a positive integer, got ${weight}`);
    }
    if (weight > this._max) {
      throw new RangeError(
        `weight (${weight}) cannot exceed max (${this._max})`
      );
    }

    // Check if already aborted
    if (opts.signal?.aborted) {
      throw new SemaphoreAbortError(
        opts.signal.reason?.toString?.() ?? undefined
      );
    }

    // Fast path: slots available and no one waiting (to preserve FIFO)
    if (this._queue.length === 0 && this._running + weight <= this._max) {
      this._running += weight;
      this._totalAcquired++;
      this._callbacks.onAcquire?.(this.stats);
      return;
    }

    // Must wait — create a queued promise
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        weight,
        resolve: () => {
          this._running += weight;
          this._totalAcquired++;
          this._callbacks.onAcquire?.(this.stats);
          resolve();
        },
        reject,
      };

      // Optional timeout
      const timeoutMs = opts.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this._removeWaiter(waiter);
          this._totalTimedOut++;
          const err = new SemaphoreTimeoutError(timeoutMs);
          this._callbacks.onTimeout?.(this.stats);
          reject(err);
        }, timeoutMs);
      }

      // Optional AbortSignal
      if (opts.signal) {
        waiter.signal = opts.signal;
        waiter.abortHandler = () => {
          this._removeWaiter(waiter);
          reject(
            new SemaphoreAbortError(
              opts.signal!.reason?.toString?.() ?? undefined
            )
          );
        };
        opts.signal.addEventListener('abort', waiter.abortHandler, {
          once: true,
        });
      }

      this._queue.push(waiter);
    });
  }

  /**
   * Non-blocking attempt to acquire a slot.
   * Returns `true` if acquired, `false` if no slot available.
   */
  tryAcquire(weight = 1): boolean {
    this._ensureNotDisposed();
    if (!Number.isInteger(weight) || weight < 1) {
      throw new RangeError(`weight must be a positive integer, got ${weight}`);
    }
    // Only succeed if no one is waiting (preserve FIFO) and slots are free
    if (this._queue.length === 0 && this._running + weight <= this._max) {
      this._running += weight;
      this._totalAcquired++;
      this._callbacks.onAcquire?.(this.stats);
      return true;
    }
    return false;
  }

  /**
   * Release one or more previously acquired slots. Wakes the next
   * waiter(s) (FIFO) if the queue is non-empty.
   *
   * @throws if called more times than acquire (running would go below 0).
   */
  release(weight = 1): void {
    if (!Number.isInteger(weight) || weight < 1) {
      throw new RangeError(`weight must be a positive integer, got ${weight}`);
    }
    if (this._running < weight) {
      throw new Error(
        `release(${weight}) called but only ${this._running} slot(s) held`
      );
    }
    this._running -= weight;
    this._totalReleased++;
    this._callbacks.onRelease?.(this.stats);
    this._dispatch();
    this._checkDrain();
  }

  /**
   * Convenience wrapper: acquire → run fn → release (even on error).
   */
  async withLock<T>(
    fn: () => Promise<T>,
    opts: AcquireOptions = {}
  ): Promise<T> {
    const weight = opts.weight ?? 1;
    await this.acquire(opts);
    try {
      return await fn();
    } finally {
      this.release(weight);
    }
  }

  /**
   * Execute an array of tasks with the semaphore controlling concurrency.
   * Returns results in the same order as the input items.
   */
  async runAll<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    opts: AcquireOptions = {}
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    const promises = items.map(async (item, i) => {
      await this.acquire(opts);
      try {
        results[i] = await fn(item, i);
      } finally {
        this.release(opts.weight ?? 1);
      }
    });
    await Promise.all(promises);
    return results;
  }

  /**
   * Returns a promise that resolves when all acquired slots have been
   * released (running === 0 and queue is empty).
   * If already drained, resolves immediately.
   */
  drain(): Promise<void> {
    if (this._running === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  /**
   * Dynamically adjust the maximum concurrency.
   * If the new max is higher, queued waiters are dispatched immediately.
   * If lower, no running tasks are interrupted — the limit takes effect
   * as tasks complete.
   */
  updateMax(newMax: number): void {
    if (!Number.isInteger(newMax) || newMax < 1) {
      throw new RangeError(`max must be a positive integer, got ${newMax}`);
    }
    this._max = newMax;
    // If we raised the ceiling, wake up as many waiters as possible
    this._dispatch();
  }

  /** Current snapshot of semaphore state. */
  get stats(): SemaphoreStats {
    return {
      running: this._running,
      waiting: this._queue.length,
      available: Math.max(0, this._max - this._running),
      max: this._max,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
      totalTimedOut: this._totalTimedOut,
    };
  }

  /** Current max concurrency. */
  get max(): number {
    return this._max;
  }

  /** Whether the semaphore has been disposed. */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose the semaphore. All queued waiters are rejected with
   * `SemaphoreDisposedError`. No further acquire/release is allowed.
   */
  dispose(): void {
    this._disposed = true;
    const err = new SemaphoreDisposedError();
    for (const w of this._queue) {
      this._cleanupWaiter(w);
      w.reject(err);
    }
    this._queue.length = 0;
    // Resolve any drain waiters — nothing more will happen
    this._resolveDrainWaiters();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Wake queued waiters while slots are available (FIFO, weight-aware). */
  private _dispatch(): void {
    while (this._queue.length > 0) {
      const head = this._queue[0];
      if (this._running + head.weight > this._max) {
        break; // Not enough slots for the next waiter
      }
      this._queue.shift();
      this._cleanupWaiter(head);
      head.resolve();
    }
  }

  /** Remove a waiter from the queue (for timeout/abort). */
  private _removeWaiter(waiter: Waiter): void {
    const idx = this._queue.indexOf(waiter);
    if (idx !== -1) {
      this._queue.splice(idx, 1);
    }
    this._cleanupWaiter(waiter);
  }

  /** Clear timer and abort listener from a waiter. */
  private _cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
      waiter.abortHandler = undefined;
    }
  }

  /** Check if drain condition is met and resolve waiters. */
  private _checkDrain(): void {
    if (this._running === 0 && this._queue.length === 0) {
      this._resolveDrainWaiters();
    }
  }

  /** Resolve all pending drain() promises. */
  private _resolveDrainWaiters(): void {
    if (this._drainResolvers.length > 0) {
      const resolvers = this._drainResolvers.splice(0);
      for (const r of resolvers) {
        r();
      }
    }
  }

  private _ensureNotDisposed(): void {
    if (this._disposed) {
      throw new SemaphoreDisposedError();
    }
  }
}
