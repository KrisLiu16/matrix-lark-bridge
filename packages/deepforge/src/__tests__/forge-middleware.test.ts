/**
 * DeepForge 2.0 — Middleware Pipeline Unit Tests
 *
 * Covers:
 * 1. Empty pipeline returns original input
 * 2. Single middleware normal execution
 * 3. Multiple middleware onion-model execution order
 * 4. Priority-based sorting
 * 5. Abort mechanism
 * 6. Error bubbling
 * 7. Lifecycle hooks (beforeRun / afterRun)
 * 8. use / remove / has / clear API
 * 9. shouldRun conditional skip
 * 10. continueOnError isolation
 * 11. Timeout handling
 * 12. EventEmitter integration
 * 13. Max middleware limit
 * 14. Duplicate name replacement
 *
 * @module tests/forge-middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MiddlewarePipeline,
  createMiddlewareContext,
  createAbortHandle,
  type MiddlewareContext,
  type MiddlewareFn,
  type MiddlewareEventEmitter,
} from '../forge-middleware';
import type { HookError } from '../types/middleware';

// ─── Test Helpers ───

/** Create a minimal valid context for testing */
function makeCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return createMiddlewareContext({
    messages: [{ role: 'user', content: 'hello' }],
    config: {
      projectId: 'test-project',
      model: 'test-model',
      effort: 'medium',
      maxConcurrent: 5,
      phase: 'executing',
    },
    ...overrides,
  });
}

/** A pass-through middleware that just calls next() */
const passthrough: MiddlewareFn = async (ctx, next) => next();

/** A middleware that appends a marker to state.log array */
function loggerMiddleware(marker: string): MiddlewareFn {
  return async (ctx, next) => {
    const log = (ctx.state['log'] as string[]) ?? [];
    log.push(`${marker}:before`);
    ctx.state['log'] = log;
    const result = await next();
    const log2 = (result.state['log'] as string[]) ?? [];
    log2.push(`${marker}:after`);
    result.state['log'] = log2;
    return result;
  };
}

// ─── Tests ───

describe('MiddlewarePipeline', () => {
  let pipeline: MiddlewarePipeline;

  beforeEach(() => {
    pipeline = new MiddlewarePipeline();
  });

  // ────────────────────────────────────────────
  // 1. Empty pipeline
  // ────────────────────────────────────────────
  describe('empty pipeline', () => {
    it('returns original context unchanged', async () => {
      const ctx = makeCtx();
      const result = await pipeline.execute(ctx);

      expect(result.success).toBe(true);
      expect(result.steps).toEqual([]);
      expect(result.totalDurationMs).toBe(0);
      expect(result.context.messages).toEqual(ctx.messages);
    });
  });

  // ────────────────────────────────────────────
  // 2. Single middleware
  // ────────────────────────────────────────────
  describe('single middleware execution', () => {
    it('executes and returns modified context', async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        ctx.state['touched'] = true;
        return next();
      };
      pipeline.use(mw, { name: 'touch' });

      const result = await pipeline.execute(makeCtx());

      expect(result.success).toBe(true);
      expect(result.context.state['touched']).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe('touch');
      expect(result.steps[0].status).toBe('executed');
    });

    it('records timing in metadata', async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        await new Promise((r) => setTimeout(r, 10));
        return next();
      };
      pipeline.use(mw, { name: 'slow' });

      const result = await pipeline.execute(makeCtx());

      expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(5);
      expect(result.context.metadata.timing['slow']).toBeGreaterThanOrEqual(5);
    });
  });

  // ────────────────────────────────────────────
  // 3. Onion model execution order
  // ────────────────────────────────────────────
  describe('onion model execution order', () => {
    it('executes before/after in correct onion order', async () => {
      pipeline.use(loggerMiddleware('A'), { name: 'A', priority: 10 });
      pipeline.use(loggerMiddleware('B'), { name: 'B', priority: 20 });
      pipeline.use(loggerMiddleware('C'), { name: 'C', priority: 30 });

      const ctx = makeCtx();
      ctx.state['log'] = [];
      const result = await pipeline.execute(ctx);

      // Onion: A:before → B:before → C:before → C:after → B:after → A:after
      expect(result.context.state['log']).toEqual([
        'A:before',
        'B:before',
        'C:before',
        'C:after',
        'B:after',
        'A:after',
      ]);
    });
  });

  // ────────────────────────────────────────────
  // 4. Priority sorting
  // ────────────────────────────────────────────
  describe('priority sorting', () => {
    it('sorts middleware by priority (lower first)', async () => {
      pipeline.use(passthrough, { name: 'low', priority: 100 });
      pipeline.use(passthrough, { name: 'high', priority: 1 });
      pipeline.use(passthrough, { name: 'mid', priority: 50 });

      const result = await pipeline.execute(makeCtx());

      // Onion model: steps are recorded when middleware completes (innermost first)
      expect(result.steps.map((s) => s.name)).toEqual(['low', 'mid', 'high']);
    });

    it('preserves insertion order for equal priority', async () => {
      pipeline.use(passthrough, { name: 'first', priority: 50 });
      pipeline.use(passthrough, { name: 'second', priority: 50 });
      pipeline.use(passthrough, { name: 'third', priority: 50 });

      const result = await pipeline.execute(makeCtx());

      // Onion model: steps are recorded when middleware completes (innermost first)
      expect(result.steps.map((s) => s.name)).toEqual(['third', 'second', 'first']);
    });

    it('chain getter returns names in priority order', () => {
      pipeline.use(passthrough, { name: 'z', priority: 99 });
      pipeline.use(passthrough, { name: 'a', priority: 1 });

      expect(pipeline.chain).toEqual(['a', 'z']);
    });
  });

  // ────────────────────────────────────────────
  // 5. Abort mechanism
  // ────────────────────────────────────────────
  describe('abort mechanism', () => {
    it('skips subsequent middleware after abort', async () => {
      const aborter: MiddlewareFn = async (ctx, next) => {
        const abort = createAbortHandle(ctx);
        abort('test-abort');
        return next();
      };

      pipeline.use(aborter, { name: 'aborter', priority: 10 });
      pipeline.use(passthrough, { name: 'skipped', priority: 20 });

      const result = await pipeline.execute(makeCtx());

      // Onion model: 'skipped' abort-step is recorded during descent,
      // 'aborter' executed-step is recorded when the outer middleware returns
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].name).toBe('skipped');
      expect(result.steps[0].status).toBe('aborted');
      expect(result.steps[1].name).toBe('aborter');
      expect(result.steps[1].status).toBe('executed');
      expect(result.context.metadata.aborted).toBe(true);
      expect(result.context.metadata.abortReason).toBe('test-abort');
    });

    it('abort with default reason', async () => {
      const aborter: MiddlewareFn = async (ctx, next) => {
        const abort = createAbortHandle(ctx);
        abort();
        return next();
      };
      pipeline.use(aborter, { name: 'aborter' });

      const result = await pipeline.execute(makeCtx());
      expect(result.context.metadata.abortReason).toBe('abort() called');
    });
  });

  // ────────────────────────────────────────────
  // 6. Error bubbling
  // ────────────────────────────────────────────
  describe('error handling', () => {
    it('propagates middleware errors to pipeline result', async () => {
      const failing: MiddlewareFn = async () => {
        throw new Error('middleware-boom');
      };
      pipeline.use(failing, { name: 'failing' });

      const result = await pipeline.execute(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('middleware-boom');
      expect(result.steps[0].status).toBe('error');
      expect(result.steps[0].error).toBe('middleware-boom');
    });

    it('stops executing subsequent middleware on error', async () => {
      const failing: MiddlewareFn = async () => {
        throw new Error('fail');
      };
      pipeline.use(failing, { name: 'failing', priority: 10 });
      pipeline.use(passthrough, { name: 'never-reached', priority: 20 });

      const result = await pipeline.execute(makeCtx());

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe('failing');
    });

    it('continueOnError per-middleware allows chain to proceed', async () => {
      const failing: MiddlewareFn = async () => {
        throw new Error('soft-fail');
      };
      const marker: MiddlewareFn = async (ctx, next) => {
        ctx.state['reached'] = true;
        return next();
      };

      pipeline.use(failing, { name: 'soft', priority: 10, continueOnError: true });
      pipeline.use(marker, { name: 'after', priority: 20 });

      const result = await pipeline.execute(makeCtx());

      expect(result.success).toBe(true);
      expect(result.steps[0].status).toBe('error');
      expect(result.steps[1].status).toBe('executed');
      expect(result.context.state['reached']).toBe(true);
    });

    it('pipeline-level continueOnError allows chain to proceed', async () => {
      const p = new MiddlewarePipeline({ continueOnError: true });
      const failing: MiddlewareFn = async () => {
        throw new Error('fail');
      };
      p.use(failing, { name: 'failing', priority: 10 });
      p.use(passthrough, { name: 'after', priority: 20 });

      const result = await p.execute(makeCtx());

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────
  // 7. Lifecycle hooks
  // ────────────────────────────────────────────
  describe('lifecycle hooks', () => {
    it('fires beforeRun hook before middleware execution', async () => {
      const order: string[] = [];
      pipeline.onBeforeRun(async () => {
        order.push('beforeRun');
      });
      pipeline.use(
        async (ctx, next) => {
          order.push('middleware');
          return next();
        },
        { name: 'mw' },
      );

      await pipeline.execute(makeCtx());

      expect(order).toEqual(['beforeRun', 'middleware']);
    });

    it('fires afterRun hook after middleware execution with result', async () => {
      const hookFn = vi.fn();
      pipeline.onAfterRun(hookFn);
      pipeline.use(passthrough, { name: 'mw' });

      await pipeline.execute(makeCtx());

      expect(hookFn).toHaveBeenCalledTimes(1);
      const result = hookFn.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
    });

    it('fires afterRun even on pipeline error', async () => {
      const hookFn = vi.fn();
      pipeline.onAfterRun(hookFn);
      pipeline.use(
        async () => {
          throw new Error('boom');
        },
        { name: 'fail' },
      );

      await pipeline.execute(makeCtx());

      expect(hookFn).toHaveBeenCalledTimes(1);
      expect(hookFn.mock.calls[0][0].success).toBe(false);
    });

    it('hook errors do not crash the pipeline', async () => {
      pipeline.onBeforeRun(async () => {
        throw new Error('hook-crash');
      });
      pipeline.use(passthrough, { name: 'mw' });

      const result = await pipeline.execute(makeCtx());
      expect(result.success).toBe(true);
    });

    it('fires beforeIteration / afterIteration hooks', async () => {
      const order: string[] = [];
      pipeline.onBeforeIteration(async () => { order.push('beforeIter'); });
      pipeline.onAfterIteration(async () => { order.push('afterIter'); });

      const ctx = makeCtx();
      await pipeline.fireBeforeIteration(ctx);
      await pipeline.fireAfterIteration(ctx);

      expect(order).toEqual(['beforeIter', 'afterIter']);
    });

    it('beforeRun hook error is logged and propagated to ctx.state.hookErrors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const order: string[] = [];

      pipeline.onBeforeRun(async () => {
        order.push('hook-before-throw');
        throw new Error('before-hook-fail');
      });
      pipeline.onBeforeRun(async () => {
        order.push('hook-after-throw');
      });
      pipeline.use(
        async (ctx, next) => {
          order.push('middleware');
          return next();
        },
        { name: 'mw' },
      );

      const result = await pipeline.execute(makeCtx());

      // Pipeline succeeds despite hook error
      expect(result.success).toBe(true);
      // Error was logged via console.error
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      // Second hook and middleware still execute (hook errors don't abort subsequent hooks)
      expect(order).toEqual(['hook-before-throw', 'hook-after-throw', 'middleware']);
      // Error propagated to ctx.state.hookErrors
      const hookErrors = result.context.state['hookErrors'] as HookError[];
      expect(hookErrors).toBeDefined();
      expect(hookErrors).toHaveLength(1);
      expect(hookErrors[0].message).toBe('before-hook-fail');

      consoleSpy.mockRestore();
    });

    it('afterRun hook error is logged and propagated to result.context.state.hookErrors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      pipeline.onAfterRun(async () => {
        throw new Error('after-hook-fail');
      });
      pipeline.onAfterRun(async (r) => {
        // Second afterRun hook still receives the result
        expect(r.success).toBe(true);
      });
      pipeline.use(passthrough, { name: 'mw' });

      const result = await pipeline.execute(makeCtx());

      // Result is unaffected by afterRun hook error
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('executed');
      // Error was logged
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      // Error propagated to result.context.state.hookErrors
      const hookErrors = result.context.state['hookErrors'] as HookError[];
      expect(hookErrors).toBeDefined();
      expect(hookErrors).toHaveLength(1);
      expect(hookErrors[0].message).toBe('after-hook-fail');

      consoleSpy.mockRestore();
    });

    it('fires onComplete hook', async () => {
      const hookFn = vi.fn();
      pipeline.onComplete(hookFn);
      pipeline.use(passthrough, { name: 'mw' });

      const result = await pipeline.execute(makeCtx());
      await pipeline.fireOnComplete(result);

      expect(hookFn).toHaveBeenCalledTimes(1);
      expect(hookFn.mock.calls[0][0]).toBe(result);
    });
  });

  // ────────────────────────────────────────────
  // 8. use / remove / has / clear API
  // ────────────────────────────────────────────
  describe('registration API', () => {
    it('use() registers middleware', () => {
      pipeline.use(passthrough, { name: 'a' });
      expect(pipeline.has('a')).toBe(true);
      expect(pipeline.size).toBe(1);
    });

    it('use() replaces middleware with same name', async () => {
      const first: MiddlewareFn = async (ctx, next) => {
        ctx.state['version'] = 1;
        return next();
      };
      const second: MiddlewareFn = async (ctx, next) => {
        ctx.state['version'] = 2;
        return next();
      };

      pipeline.use(first, { name: 'versioned' });
      pipeline.use(second, { name: 'versioned' });

      expect(pipeline.size).toBe(1);
      const result = await pipeline.execute(makeCtx());
      expect(result.context.state['version']).toBe(2);
    });

    it('use() is chainable', () => {
      const ret = pipeline
        .use(passthrough, { name: 'a' })
        .use(passthrough, { name: 'b' });
      expect(ret).toBe(pipeline);
      expect(pipeline.size).toBe(2);
    });

    it('remove() returns true and removes existing middleware', () => {
      pipeline.use(passthrough, { name: 'a' });
      expect(pipeline.remove('a')).toBe(true);
      expect(pipeline.has('a')).toBe(false);
      expect(pipeline.size).toBe(0);
    });

    it('remove() returns false for non-existent middleware', () => {
      expect(pipeline.remove('nonexistent')).toBe(false);
    });

    it('has() returns false for unregistered names', () => {
      expect(pipeline.has('nope')).toBe(false);
    });

    it('clear() removes all middleware and hooks', async () => {
      pipeline.use(passthrough, { name: 'a' });
      pipeline.use(passthrough, { name: 'b' });
      const hookFn = vi.fn();
      pipeline.onBeforeRun(hookFn);
      pipeline.onAfterRun(hookFn);

      pipeline.clear();

      expect(pipeline.size).toBe(0);
      expect(pipeline.has('a')).toBe(false);

      // Hooks should also be cleared — execute with a new middleware, hooks should not fire
      pipeline.use(passthrough, { name: 'c' });
      await pipeline.execute(makeCtx());
      expect(hookFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // 9. shouldRun conditional skip
  // ────────────────────────────────────────────
  describe('shouldRun predicate', () => {
    it('skips middleware when shouldRun returns false', async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        ctx.state['ran'] = true;
        return next();
      };
      pipeline.use(mw, {
        name: 'conditional',
        shouldRun: (ctx) => ctx.config.phase === 'planning',
      });

      const ctx = makeCtx(); // phase = 'executing'
      const result = await pipeline.execute(ctx);

      expect(result.steps[0].status).toBe('skipped');
      expect(result.context.state['ran']).toBeUndefined();
    });

    it('executes middleware when shouldRun returns true', async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        ctx.state['ran'] = true;
        return next();
      };
      pipeline.use(mw, {
        name: 'conditional',
        shouldRun: (ctx) => ctx.config.phase === 'executing',
      });

      const result = await pipeline.execute(makeCtx());

      expect(result.steps[0].status).toBe('executed');
      expect(result.context.state['ran']).toBe(true);
    });
  });

  // ────────────────────────────────────────────
  // 10. Disabled middleware
  // ────────────────────────────────────────────
  describe('disabled middleware', () => {
    it('skips disabled middleware', async () => {
      pipeline.use(passthrough, { name: 'disabled', enabled: false });

      const result = await pipeline.execute(makeCtx());

      expect(result.steps[0].status).toBe('skipped');
    });
  });

  // ────────────────────────────────────────────
  // 11. Timeout handling
  // ────────────────────────────────────────────
  describe('timeout', () => {
    it('marks timed-out middleware as timeout status', async () => {
      const slow: MiddlewareFn = async (ctx, next) => {
        await new Promise((r) => setTimeout(r, 200));
        return next();
      };
      pipeline.use(slow, { name: 'slow', timeout: 50 });

      const result = await pipeline.execute(makeCtx());

      expect(result.success).toBe(false);
      expect(result.steps[0].status).toBe('timeout');
      expect(result.steps[0].error).toContain('timed out');
    });

    it('timeout 0 disables per-middleware timeout', async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        await new Promise((r) => setTimeout(r, 10));
        return next();
      };
      pipeline.use(mw, { name: 'no-timeout', timeout: 0 });

      const result = await pipeline.execute(makeCtx());
      expect(result.success).toBe(true);
    });

    it('global timeout aborts entire pipeline', async () => {
      const p = new MiddlewarePipeline({ globalTimeout: 50 });
      const slow: MiddlewareFn = async (ctx, next) => {
        await new Promise((r) => setTimeout(r, 200));
        return next();
      };
      p.use(slow, { name: 'slow', timeout: 0 });

      const result = await p.execute(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  // ────────────────────────────────────────────
  // 12. EventEmitter integration
  // ────────────────────────────────────────────
  describe('event emitter integration', () => {
    it('emits middleware_enter and middleware_exit events', async () => {
      const events: Array<{ type: string; middlewareName: string }> = [];
      const emitter: MiddlewareEventEmitter = {
        emit: (e) => {
          events.push({ type: e.type, middlewareName: e.middlewareName });
        },
      };
      const p = new MiddlewarePipeline({}, emitter);
      p.use(passthrough, { name: 'test-mw' });

      await p.execute(makeCtx());

      expect(events).toEqual([
        { type: 'middleware_enter', middlewareName: 'test-mw' },
        { type: 'middleware_exit', middlewareName: 'test-mw' },
      ]);
    });

    it('emits middleware_error event on failure', async () => {
      const events: Array<{ type: string; error?: string }> = [];
      const emitter: MiddlewareEventEmitter = {
        emit: (e) => { events.push({ type: e.type, error: e.error }); },
      };
      const p = new MiddlewarePipeline({}, emitter);
      p.use(
        async () => {
          throw new Error('emit-test');
        },
        { name: 'fail' },
      );

      await p.execute(makeCtx());

      const errorEvent = events.find((e) => e.type === 'middleware_error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error).toBe('emit-test');
    });

    it('emitter errors do not crash the pipeline', async () => {
      const emitter: MiddlewareEventEmitter = {
        emit: () => {
          throw new Error('emitter-crash');
        },
      };
      const p = new MiddlewarePipeline({}, emitter);
      p.use(passthrough, { name: 'mw' });

      const result = await p.execute(makeCtx());
      expect(result.success).toBe(true);
    });
  });

  // ────────────────────────────────────────────
  // 13. Max middleware limit
  // ────────────────────────────────────────────
  describe('max middleware limit', () => {
    it('throws when exceeding maxMiddleware', () => {
      const p = new MiddlewarePipeline({ maxMiddleware: 2 });
      p.use(passthrough, { name: 'a' });
      p.use(passthrough, { name: 'b' });

      expect(() => p.use(passthrough, { name: 'c' })).toThrow('Pipeline limit reached');
    });
  });

  // ────────────────────────────────────────────
  // 14. Metadata population
  // ────────────────────────────────────────────
  describe('metadata population', () => {
    it('populates runId and chain on execution', async () => {
      pipeline.use(passthrough, { name: 'a', priority: 10 });
      pipeline.use(passthrough, { name: 'b', priority: 20 });

      const result = await pipeline.execute(makeCtx());

      expect(result.context.metadata.runId).toMatch(/^run-/);
      expect(result.context.metadata.chain).toEqual(['a', 'b']);
      expect(result.context.metadata.startedAt).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────
  // 15. createMiddlewareContext helper
  // ────────────────────────────────────────────
  describe('createMiddlewareContext', () => {
    it('creates context with defaults', () => {
      const ctx = createMiddlewareContext();
      expect(ctx.messages).toEqual([]);
      expect(ctx.config.effort).toBe('medium');
      expect(ctx.state).toEqual({});
      expect(ctx.metadata.aborted).toBe(false);
    });

    it('applies overrides', () => {
      const ctx = createMiddlewareContext({
        messages: [{ role: 'user', content: 'test' }],
        state: { key: 'value' },
      });
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.state['key']).toBe('value');
    });
  });

  // ────────────────────────────────────────────
  // 16. next() called multiple times guard
  // ────────────────────────────────────────────
  describe('next() guard', () => {
    it('throws if next() is called multiple times', async () => {
      const doubleNext: MiddlewareFn = async (ctx, next) => {
        await next();
        return next(); // second call — should throw
      };
      pipeline.use(doubleNext, { name: 'double-next' });

      const result = await pipeline.execute(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('next() called multiple times');
    });
  });
});
