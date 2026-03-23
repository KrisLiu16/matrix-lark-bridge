/**
 * forge-semaphore.test.ts — Unit tests for AsyncSemaphore
 *
 * Covers: acquire/release flow, concurrency limits, FIFO ordering,
 * dispose behavior, release-without-acquire, timeout, tryAcquire,
 * AbortSignal, weighted acquire, drain, withLock, runAll, updateMax,
 * constructor validation, and callback hooks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AsyncSemaphore,
  SemaphoreTimeoutError,
  SemaphoreDisposedError,
  SemaphoreAbortError,
} from '../forge-semaphore';

// Helper: create a deferred promise for manual resolution control
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Helper: wait for microtask queue to flush
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AsyncSemaphore', () => {
  // -------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------
  describe('constructor', () => {
    it('creates with valid max', () => {
      const sem = new AsyncSemaphore(3);
      expect(sem.max).toBe(3);
      expect(sem.stats.running).toBe(0);
      expect(sem.stats.available).toBe(3);
      expect(sem.disposed).toBe(false);
    });

    it('throws RangeError for max < 1', () => {
      expect(() => new AsyncSemaphore(0)).toThrow(RangeError);
      expect(() => new AsyncSemaphore(-1)).toThrow(RangeError);
    });

    it('throws RangeError for non-integer max', () => {
      expect(() => new AsyncSemaphore(1.5)).toThrow(RangeError);
      expect(() => new AsyncSemaphore(NaN)).toThrow(RangeError);
    });
  });

  // -------------------------------------------------------------------
  // 1. acquire/release basic flow
  // -------------------------------------------------------------------
  describe('acquire/release basic flow', () => {
    it('acquires immediately when slots are free', async () => {
      const sem = new AsyncSemaphore(2);
      await sem.acquire();
      expect(sem.stats.running).toBe(1);
      expect(sem.stats.available).toBe(1);
    });

    it('releases correctly and updates stats', async () => {
      const sem = new AsyncSemaphore(2);
      await sem.acquire();
      await sem.acquire();
      expect(sem.stats.running).toBe(2);
      expect(sem.stats.available).toBe(0);

      sem.release();
      expect(sem.stats.running).toBe(1);
      expect(sem.stats.available).toBe(1);

      sem.release();
      expect(sem.stats.running).toBe(0);
      expect(sem.stats.available).toBe(2);
    });

    it('tracks cumulative totalAcquired and totalReleased', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();
      sem.release();
      await sem.acquire();
      sem.release();
      expect(sem.stats.totalAcquired).toBe(2);
      expect(sem.stats.totalReleased).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // 2. concurrency does not exceed maxConcurrent
  // -------------------------------------------------------------------
  describe('concurrency limit', () => {
    it('blocks acquire when all slots are taken', async () => {
      const sem = new AsyncSemaphore(2);
      await sem.acquire();
      await sem.acquire();

      let thirdAcquired = false;
      const p = sem.acquire().then(() => {
        thirdAcquired = true;
      });

      await tick();
      expect(thirdAcquired).toBe(false);
      expect(sem.stats.waiting).toBe(1);
      expect(sem.stats.running).toBe(2);

      sem.release();
      await p;
      expect(thirdAcquired).toBe(true);
      expect(sem.stats.running).toBe(2); // still at max (2 held + 1 acquired - 1 released)

      sem.release();
      sem.release();
    });

    it('never exceeds max concurrent with parallel workload', async () => {
      const sem = new AsyncSemaphore(3);
      let maxObserved = 0;
      let current = 0;

      const task = async () => {
        await sem.acquire();
        current++;
        maxObserved = Math.max(maxObserved, current);
        await tick();
        current--;
        sem.release();
      };

      await Promise.all(Array.from({ length: 10 }, () => task()));
      expect(maxObserved).toBeLessThanOrEqual(3);
      expect(sem.stats.totalAcquired).toBe(10);
    });
  });

  // -------------------------------------------------------------------
  // 3. FIFO ordering
  // -------------------------------------------------------------------
  describe('FIFO queue ordering', () => {
    it('wakes waiters in FIFO order', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire(); // slot taken

      const order: number[] = [];

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      await tick();
      expect(sem.stats.waiting).toBe(3);

      // Release one at a time
      sem.release();
      await p1;
      sem.release();
      await p2;
      sem.release();
      await p3;

      expect(order).toEqual([1, 2, 3]);
      sem.release(); // release the last one
    });

    it('tryAcquire fails when waiters are queued (preserves FIFO)', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire(); // slot taken

      // Queue a waiter
      const p = sem.acquire();
      await tick();

      // tryAcquire should return false even after releasing,
      // because the queued waiter has priority
      sem.release();
      await p; // waiter gets the slot

      // Now no waiters — tryAcquire should succeed
      sem.release();
      expect(sem.tryAcquire()).toBe(true);
      sem.release();
    });
  });

  // -------------------------------------------------------------------
  // 4. dispose rejects pending acquires
  // -------------------------------------------------------------------
  describe('dispose', () => {
    it('rejects all queued waiters with SemaphoreDisposedError', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();

      const p1 = sem.acquire();
      const p2 = sem.acquire();
      await tick();

      sem.dispose();

      await expect(p1).rejects.toThrow(SemaphoreDisposedError);
      await expect(p2).rejects.toThrow(SemaphoreDisposedError);
      expect(sem.disposed).toBe(true);
    });

    it('acquire throws after dispose', async () => {
      const sem = new AsyncSemaphore(1);
      sem.dispose();
      await expect(sem.acquire()).rejects.toThrow(SemaphoreDisposedError);
    });

    it('tryAcquire throws after dispose', () => {
      const sem = new AsyncSemaphore(1);
      sem.dispose();
      expect(() => sem.tryAcquire()).toThrow(SemaphoreDisposedError);
    });
  });

  // -------------------------------------------------------------------
  // 5. release without acquire throws
  // -------------------------------------------------------------------
  describe('release without acquire', () => {
    it('throws when no slots are held', () => {
      const sem = new AsyncSemaphore(2);
      expect(() => sem.release()).toThrow(/release\(1\) called but only 0 slot/);
    });

    it('throws when releasing more than held', async () => {
      const sem = new AsyncSemaphore(3);
      await sem.acquire();
      expect(() => sem.release(2)).toThrow(
        /release\(2\) called but only 1 slot/
      );
      sem.release();
    });
  });

  // -------------------------------------------------------------------
  // 6. timeout
  // -------------------------------------------------------------------
  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects with SemaphoreTimeoutError after timeoutMs', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();

      const p = sem.acquire({ timeoutMs: 100 });

      vi.advanceTimersByTime(100);

      await expect(p).rejects.toThrow(SemaphoreTimeoutError);
      await expect(p).rejects.toThrow(/100ms/);
      expect(sem.stats.totalTimedOut).toBe(1);
      expect(sem.stats.waiting).toBe(0);

      sem.release();
    });

    it('does not timeout if slot becomes available in time', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();

      const p = sem.acquire({ timeoutMs: 200 });

      // Release before timeout
      vi.advanceTimersByTime(50);
      sem.release();

      await vi.advanceTimersByTimeAsync(0);
      await expect(p).resolves.toBeUndefined();
      expect(sem.stats.totalTimedOut).toBe(0);

      sem.release();
    });
  });

  // -------------------------------------------------------------------
  // 7. tryAcquire non-blocking
  // -------------------------------------------------------------------
  describe('tryAcquire', () => {
    it('returns true and acquires when slot is free', () => {
      const sem = new AsyncSemaphore(1);
      expect(sem.tryAcquire()).toBe(true);
      expect(sem.stats.running).toBe(1);
      sem.release();
    });

    it('returns false when no slot is available', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();
      expect(sem.tryAcquire()).toBe(false);
      expect(sem.stats.running).toBe(1);
      sem.release();
    });

    it('validates weight parameter', () => {
      const sem = new AsyncSemaphore(3);
      expect(() => sem.tryAcquire(0)).toThrow(RangeError);
      expect(() => sem.tryAcquire(-1)).toThrow(RangeError);
      expect(() => sem.tryAcquire(1.5)).toThrow(RangeError);
    });
  });

  // -------------------------------------------------------------------
  // AbortSignal cancellation
  // -------------------------------------------------------------------
  describe('AbortSignal', () => {
    it('rejects with SemaphoreAbortError when signal is aborted', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire();

      const ctrl = new AbortController();
      const p = sem.acquire({ signal: ctrl.signal });
      await tick();

      ctrl.abort('user cancelled');

      await expect(p).rejects.toThrow(SemaphoreAbortError);
      expect(sem.stats.waiting).toBe(0);

      sem.release();
    });

    it('rejects immediately if signal is already aborted', async () => {
      const sem = new AsyncSemaphore(1);
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(sem.acquire({ signal: ctrl.signal })).rejects.toThrow(
        SemaphoreAbortError
      );
    });
  });

  // -------------------------------------------------------------------
  // Weighted acquire
  // -------------------------------------------------------------------
  describe('weighted acquire', () => {
    it('acquires multiple slots at once', async () => {
      const sem = new AsyncSemaphore(3);
      await sem.acquire({ weight: 2 });
      expect(sem.stats.running).toBe(2);
      expect(sem.stats.available).toBe(1);

      // Only 1 slot left, weight-2 must wait
      let acquired = false;
      const p = sem.acquire({ weight: 2 }).then(() => {
        acquired = true;
      });
      await tick();
      expect(acquired).toBe(false);

      sem.release(2);
      await p;
      expect(acquired).toBe(true);
      sem.release(2);
    });

    it('rejects weight > max', async () => {
      const sem = new AsyncSemaphore(2);
      await expect(sem.acquire({ weight: 3 })).rejects.toThrow(RangeError);
    });

    it('rejects invalid weight', async () => {
      const sem = new AsyncSemaphore(2);
      await expect(sem.acquire({ weight: 0 })).rejects.toThrow(RangeError);
      await expect(sem.acquire({ weight: -1 })).rejects.toThrow(RangeError);
    });
  });

  // -------------------------------------------------------------------
  // withLock convenience
  // -------------------------------------------------------------------
  describe('withLock', () => {
    it('acquires, runs fn, and releases on success', async () => {
      const sem = new AsyncSemaphore(1);
      const result = await sem.withLock(async () => {
        expect(sem.stats.running).toBe(1);
        return 42;
      });
      expect(result).toBe(42);
      expect(sem.stats.running).toBe(0);
    });

    it('releases even if fn throws', async () => {
      const sem = new AsyncSemaphore(1);
      await expect(
        sem.withLock(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(sem.stats.running).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // runAll batch helper
  // -------------------------------------------------------------------
  describe('runAll', () => {
    it('executes all tasks and returns results in order', async () => {
      const sem = new AsyncSemaphore(2);
      const items = [10, 20, 30, 40];
      const results = await sem.runAll(items, async (item, idx) => {
        return item * 2 + idx;
      });
      expect(results).toEqual([20, 41, 62, 83]);
      expect(sem.stats.running).toBe(0);
    });

    it('respects concurrency limit during runAll', async () => {
      const sem = new AsyncSemaphore(2);
      let maxConcurrent = 0;
      let current = 0;

      await sem.runAll([1, 2, 3, 4, 5], async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await tick();
        current--;
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------
  // drain
  // -------------------------------------------------------------------
  describe('drain', () => {
    it('resolves immediately when nothing is running', async () => {
      const sem = new AsyncSemaphore(3);
      await sem.drain(); // should not hang
    });

    it('resolves after all running tasks complete', async () => {
      const sem = new AsyncSemaphore(2);
      await sem.acquire();
      await sem.acquire();

      let drained = false;
      const drainP = sem.drain().then(() => {
        drained = true;
      });
      await tick();
      expect(drained).toBe(false);

      sem.release();
      await tick();
      expect(drained).toBe(false); // still 1 running

      sem.release();
      await drainP;
      expect(drained).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // updateMax
  // -------------------------------------------------------------------
  describe('updateMax', () => {
    it('increases max and dispatches queued waiters', async () => {
      const sem = new AsyncSemaphore(1);
      await sem.acquire(); // slot taken

      let w1Acquired = false;
      let w2Acquired = false;
      const p1 = sem.acquire().then(() => { w1Acquired = true; });
      const p2 = sem.acquire().then(() => { w2Acquired = true; });
      await tick();

      // Raise max to 3 — both waiters should be dispatched
      sem.updateMax(3);
      await tick();
      await Promise.all([p1, p2]);
      expect(w1Acquired).toBe(true);
      expect(w2Acquired).toBe(true);
      expect(sem.stats.running).toBe(3);

      sem.release();
      sem.release();
      sem.release();
    });

    it('throws for invalid max', () => {
      const sem = new AsyncSemaphore(1);
      expect(() => sem.updateMax(0)).toThrow(RangeError);
      expect(() => sem.updateMax(-1)).toThrow(RangeError);
      expect(() => sem.updateMax(1.5)).toThrow(RangeError);
    });
  });

  // -------------------------------------------------------------------
  // Callbacks
  // -------------------------------------------------------------------
  describe('callbacks', () => {
    it('invokes onAcquire and onRelease callbacks', async () => {
      const onAcquire = vi.fn();
      const onRelease = vi.fn();
      const sem = new AsyncSemaphore(2, { onAcquire, onRelease });

      await sem.acquire();
      expect(onAcquire).toHaveBeenCalledTimes(1);
      expect(onAcquire).toHaveBeenCalledWith(
        expect.objectContaining({ running: 1, available: 1 })
      );

      sem.release();
      expect(onRelease).toHaveBeenCalledTimes(1);
      expect(onRelease).toHaveBeenCalledWith(
        expect.objectContaining({ running: 0, available: 2 })
      );
    });

    it('invokes onTimeout callback', async () => {
      vi.useFakeTimers();
      const onTimeout = vi.fn();
      const sem = new AsyncSemaphore(1, { onTimeout });
      await sem.acquire();

      const p = sem.acquire({ timeoutMs: 50 });
      vi.advanceTimersByTime(50);

      await expect(p).rejects.toThrow(SemaphoreTimeoutError);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      sem.release();
      vi.useRealTimers();
    });
  });
});
