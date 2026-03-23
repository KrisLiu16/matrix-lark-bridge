/**
 * ForgeEventBus — Unit Tests
 *
 * 覆盖：构造/单例、on/off 订阅取消、emit 事件分发、
 * 通配符匹配、事件历史、once 一次性订阅、waitFor、
 * filter、错误隔离、removeAllListeners、createForgeEvent。
 *
 * 框架：vitest
 * 用例数：24
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeEventBus, createForgeEvent } from '../forge-events';
import type { ForgeEvent, ForgeEventHandler } from '../types/event';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('node:path', () => ({
  dirname: vi.fn((p: string) => p.replace(/\/[^/]+$/, '')),
}));

// ---- helpers ----

function makeEvent(
  type: ForgeEvent['type'],
  overrides: Record<string, unknown> = {},
): ForgeEvent {
  const base = {
    type,
    timestamp: new Date().toISOString(),
    message: `test ${type}`,
  };
  // Each event type needs its required fields
  const defaults: Record<string, Record<string, unknown>> = {
    task_done: { taskId: 't1', role: 'dev', durationMs: 100 },
    task_start: { taskId: 't1', role: 'dev' },
    task_fail: { taskId: 't1', role: 'dev', error: 'boom' },
    phase_transition: { from: 'init', to: 'running' },
    iteration_start: { iteration: 0, plannedTaskCount: 3 },
    iteration_end: { iteration: 0, durationMs: 500, success: true },
    error: { severity: 'error', error: 'err', fatal: false },
    alert: { severity: 'warn' },
    middleware_enter: { middlewareName: 'mw1', hook: 'before' },
    middleware_exit: { middlewareName: 'mw1', durationMs: 10 },
    middleware_error: { middlewareName: 'mw1', error: 'fail', recovered: true },
    memory_update: { entryCount: 5, updateSource: 'test' },
    memory_prune: { prunedCount: 2, remainingCount: 3 },
    config_change: { key: 'a.b', oldValue: 1, newValue: 2 },
    quality_gate: { gateName: 'acc', passed: true, reason: 'ok' },
    semaphore_acquire: { taskId: 't1', activeCount: 1, maxPermits: 3 },
    semaphore_release: { taskId: 't1', activeCount: 0 },
    semaphore_timeout: { taskId: 't1', waitedMs: 1000 },
    critic_review: { iteration: 0, passed: true, feedback: 'good' },
    verifier_check: { iteration: 0, passed: true, result: 'ok' },
    dashboard_update: { metrics: { tasks: 5 } },
    task_retry: { taskId: 't1', role: 'dev', attempt: 1, reason: 'retry' },
  };
  return { ...base, ...(defaults[type] ?? {}), ...overrides } as ForgeEvent;
}

// ---- tests ----

describe('ForgeEventBus', () => {
  let bus: ForgeEventBus;

  beforeEach(() => {
    ForgeEventBus.resetShared();
    bus = ForgeEventBus.create();
  });

  afterEach(() => {
    ForgeEventBus.resetShared();
  });

  // ======== 1. 构造 & 单例 ========

  describe('constructor & shared singleton', () => {
    it('shared() returns the same instance', () => {
      const a = ForgeEventBus.shared();
      const b = ForgeEventBus.shared();
      expect(a).toBe(b);
    });

    it('create() returns distinct instances', () => {
      const a = ForgeEventBus.create();
      const b = ForgeEventBus.create();
      expect(a).not.toBe(b);
    });

    it('resetShared() clears the singleton', () => {
      const a = ForgeEventBus.shared();
      ForgeEventBus.resetShared();
      const b = ForgeEventBus.shared();
      expect(a).not.toBe(b);
    });
  });

  // ======== 2. on / off 订阅取消 ========

  describe('on / off subscription', () => {
    it('on() registers a handler that receives matching events', async () => {
      const handler = vi.fn();
      bus.on('task_done', handler);

      const evt = makeEvent('task_done');
      await bus.emit(evt);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(evt);
    });

    it('on() returns an unsubscribe function', async () => {
      const handler = vi.fn();
      const unsub = bus.on('task_done', handler);

      unsub();
      await bus.emit(makeEvent('task_done'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('off() removes a handler by reference', async () => {
      const handler = vi.fn();
      bus.on('task_done', handler);
      bus.off('task_done', handler);

      await bus.emit(makeEvent('task_done'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('off() only removes matching pattern+handler pair', async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('task_done', h1);
      bus.on('task_done', h2);

      bus.off('task_done', h1);
      await bus.emit(makeEvent('task_done'));

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  // ======== 3. emit 事件分发 ========

  describe('emit dispatch', () => {
    it('calls handlers sequentially in registration order', async () => {
      const order: number[] = [];
      bus.on('task_start', async () => { order.push(1); });
      bus.on('task_start', async () => { order.push(2); });
      bus.on('task_start', async () => { order.push(3); });

      await bus.emit(makeEvent('task_start'));
      expect(order).toEqual([1, 2, 3]);
    });

    it('does not call handlers for non-matching event types', async () => {
      const handler = vi.fn();
      bus.on('task_done', handler);

      await bus.emit(makeEvent('task_start'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ======== 4. 通配符 ========

  describe('wildcard pattern (*)', () => {
    it('* handler receives all event types', async () => {
      const handler = vi.fn();
      bus.on('*', handler);

      await bus.emit(makeEvent('task_start'));
      await bus.emit(makeEvent('task_done'));
      await bus.emit(makeEvent('error'));

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('* handler and specific handler both fire', async () => {
      const wildcard = vi.fn();
      const specific = vi.fn();
      bus.on('*', wildcard);
      bus.on('task_done', specific);

      await bus.emit(makeEvent('task_done'));

      expect(wildcard).toHaveBeenCalledOnce();
      expect(specific).toHaveBeenCalledOnce();
    });
  });

  // ======== 5. 事件历史 ========

  describe('event history', () => {
    it('getHistory() returns all emitted events', async () => {
      await bus.emit(makeEvent('task_start'));
      await bus.emit(makeEvent('task_done'));

      const history = bus.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('task_start');
      expect(history[1].type).toBe('task_done');
    });

    it('getHistory(n) returns the last n events', async () => {
      await bus.emit(makeEvent('task_start'));
      await bus.emit(makeEvent('task_done'));
      await bus.emit(makeEvent('task_fail'));

      const last2 = bus.getHistory(2);
      expect(last2).toHaveLength(2);
      expect(last2[0].type).toBe('task_done');
      expect(last2[1].type).toBe('task_fail');
    });

    it('getHistoryByType() filters by event type', async () => {
      await bus.emit(makeEvent('task_start'));
      await bus.emit(makeEvent('task_done'));
      await bus.emit(makeEvent('task_start'));

      const starts = bus.getHistoryByType('task_start');
      expect(starts).toHaveLength(2);
      starts.forEach((e) => expect(e.type).toBe('task_start'));
    });

    it('clearHistory() empties the buffer', async () => {
      await bus.emit(makeEvent('task_start'));
      expect(bus.historySize).toBe(1);

      bus.clearHistory();
      expect(bus.historySize).toBe(0);
      expect(bus.getHistory()).toEqual([]);
    });

    it('history respects historyLimit (ring buffer)', async () => {
      const small = ForgeEventBus.create({ historyLimit: 3 });

      for (let i = 0; i < 5; i++) {
        await small.emit(makeEvent('task_start', { taskId: `t${i}` }));
      }

      const history = small.getHistory();
      expect(history).toHaveLength(3);
      // Should keep the last 3
      expect((history[0] as any).taskId).toBe('t2');
      expect((history[2] as any).taskId).toBe('t4');
    });
  });

  // ======== 6. once 一次性订阅 ========

  describe('once() one-shot subscription', () => {
    it('fires only once then auto-removes', async () => {
      const handler = vi.fn();
      bus.once('task_done', handler);

      await bus.emit(makeEvent('task_done'));
      await bus.emit(makeEvent('task_done'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('can be manually unsubscribed before firing', async () => {
      const handler = vi.fn();
      const unsub = bus.once('task_done', handler);

      unsub();
      await bus.emit(makeEvent('task_done'));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ======== 7. 错误隔离 ========

  describe('error isolation', () => {
    it('handler error does not stop other handlers', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h1 = vi.fn(() => { throw new Error('boom'); });
      const h2 = vi.fn();

      bus.on('task_done', h1);
      bus.on('task_done', h2);

      await bus.emit(makeEvent('task_done'));

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it('auto-emits error event when handler throws (emitHandlerErrors=true)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorBus = ForgeEventBus.create({ emitHandlerErrors: true });
      const errorHandler = vi.fn();

      errorBus.on('task_done', () => { throw new Error('fail'); });
      errorBus.on('error', errorHandler);

      await errorBus.emit(makeEvent('task_done'));

      // Wait for the async error event
      await new Promise((r) => setTimeout(r, 50));

      expect(errorHandler).toHaveBeenCalledOnce();
      const errorEvt = errorHandler.mock.calls[0][0];
      expect(errorEvt.type).toBe('error');
      expect(errorEvt.error).toContain('fail');
      spy.mockRestore();
    });

    it('does not emit error event for errors in error handlers (no recursion)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorBus = ForgeEventBus.create({ emitHandlerErrors: true });
      const errorHandler = vi.fn(() => { throw new Error('nested'); });

      errorBus.on('error', errorHandler);
      // Directly emit an error event with a handler that throws
      await errorBus.emit(makeEvent('error'));

      // Should not cause infinite recursion — handler called once
      expect(errorHandler).toHaveBeenCalledOnce();
      spy.mockRestore();
    });
  });

  // ======== 8. filter ========

  describe('event filter', () => {
    it('filter predicate blocks non-matching events', async () => {
      const handler = vi.fn();
      bus.on(
        'task_done',
        handler as ForgeEventHandler,
        (e) => (e as any).taskId === 'target',
      );

      await bus.emit(makeEvent('task_done', { taskId: 'other' }));
      expect(handler).not.toHaveBeenCalled();

      await bus.emit(makeEvent('task_done', { taskId: 'target' }));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ======== 9. removeAllListeners ========

  describe('removeAllListeners', () => {
    it('removes all listeners when called without pattern', async () => {
      bus.on('task_done', vi.fn());
      bus.on('task_start', vi.fn());
      expect(bus.listenerCount).toBe(2);

      bus.removeAllListeners();
      expect(bus.listenerCount).toBe(0);
    });

    it('removes only listeners matching the given pattern', async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('task_done', h1);
      bus.on('task_start', h2);

      bus.removeAllListeners('task_done');
      expect(bus.listenerCount).toBe(1);

      await bus.emit(makeEvent('task_done'));
      await bus.emit(makeEvent('task_start'));

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  // ======== 10. waitFor ========

  describe('waitFor()', () => {
    it('resolves with the matching event', async () => {
      const promise = bus.waitFor('task_done');

      const evt = makeEvent('task_done');
      await bus.emit(evt);

      const result = await promise;
      expect(result.type).toBe('task_done');
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      const promise = bus.waitFor('task_done', undefined, 100);

      vi.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow('timed out');
      vi.useRealTimers();
    });
  });

  // ======== 11. introspection ========

  describe('introspection', () => {
    it('listenerCount reflects active subscriptions', () => {
      expect(bus.listenerCount).toBe(0);
      const unsub = bus.on('task_done', vi.fn());
      expect(bus.listenerCount).toBe(1);
      unsub();
      expect(bus.listenerCount).toBe(0);
    });

    it('listenerCountFor counts per-pattern', () => {
      bus.on('task_done', vi.fn());
      bus.on('task_done', vi.fn());
      bus.on('task_start', vi.fn());

      expect(bus.listenerCountFor('task_done')).toBe(2);
      expect(bus.listenerCountFor('task_start')).toBe(1);
      expect(bus.listenerCountFor('error')).toBe(0);
    });

    it('historySize reflects event count', async () => {
      expect(bus.historySize).toBe(0);
      await bus.emit(makeEvent('task_start'));
      expect(bus.historySize).toBe(1);
    });
  });

  // ======== 12. createForgeEvent helper ========

  describe('createForgeEvent()', () => {
    it('auto-fills timestamp', () => {
      const evt = createForgeEvent({
        type: 'task_start',
        message: 'go',
        taskId: 't1',
        role: 'dev',
      });
      expect(evt.timestamp).toBeDefined();
      expect(typeof evt.timestamp).toBe('string');
      expect(evt.type).toBe('task_start');
    });

    it('preserves provided timestamp', () => {
      const ts = '2025-01-01T00:00:00.000Z';
      const evt = createForgeEvent({
        type: 'task_start',
        message: 'go',
        taskId: 't1',
        role: 'dev',
        timestamp: ts,
      });
      expect(evt.timestamp).toBe(ts);
    });
  });
});
