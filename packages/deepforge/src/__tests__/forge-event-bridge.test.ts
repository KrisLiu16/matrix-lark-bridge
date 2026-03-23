/**
 * DeepForge 2.0 — Event Bridge Adapter Unit Tests
 *
 * Tests for forge-event-bridge.ts:
 * - Legacy ↔ new event format conversion (toLegacyEvent via bridgeOnEventCallback)
 * - Event type mapping completeness (all ForgeEventType → legacy type)
 * - Unknown event type fallback to 'alert'
 * - Emit helper functions (phase, iteration, task, critic, alert)
 * - Iteration lifecycle convenience helper with timing
 * - Unsubscribe / teardown behavior
 *
 * @module __tests__/forge-event-bridge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  bridgeOnEventCallback,
  emitPhaseTransition,
  emitIterationStart,
  emitIterationEnd,
  emitIterationLifecycle,
  emitTaskStart,
  emitTaskDone,
  emitTaskFail,
  emitCriticReview,
  emitAlert,
} from '../forge-event-bridge';
import type { LegacyForgeEvent, LegacyOnEventCallback } from '../forge-event-bridge';
import { ForgeEventBus, createForgeEvent } from '../forge-events';
import type {
  ForgeEvent,
  PhaseTransitionEvent,
  TaskStartEvent,
  TaskDoneEvent,
  TaskFailEvent,
  TaskRetryEvent,
  CriticReviewEvent,
  VerifierCheckEvent,
  AlertEvent,
  ErrorEvent,
  MiddlewareEnterEvent,
  MemoryUpdateEvent,
  SemaphoreAcquireEvent,
  ConfigChangeEvent,
  DashboardUpdateEvent,
  IterationStartEvent,
  IterationEndEvent,
  QualityGateEvent,
} from '../types/event';

// ============ Helpers ============

/** Create a fresh non-singleton event bus for each test. */
function createBus(): ForgeEventBus {
  return ForgeEventBus.create();
}

/** Collect legacy events from a bridge. */
function collectLegacyEvents(bus: ForgeEventBus): {
  events: LegacyForgeEvent[];
  unsub: () => void;
} {
  const events: LegacyForgeEvent[] = [];
  const unsub = bridgeOnEventCallback(bus, (e) => events.push(e));
  return { events, unsub };
}

// ============ Tests ============

describe('ForgeEventBridge', () => {
  let bus: ForgeEventBus;

  beforeEach(() => {
    bus = createBus();
  });

  // ---- bridgeOnEventCallback ----

  describe('bridgeOnEventCallback', () => {
    it('should subscribe to wildcard and forward events as legacy format', async () => {
      const { events } = collectLegacyEvents(bus);

      await emitPhaseTransition(bus, 'executing', 'planning');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('phase');
      expect(events[0].message).toContain('executing');
      expect(events[0].timestamp).toBeTruthy();
    });

    it('should return an unsubscribe function that stops forwarding', async () => {
      const { events, unsub } = collectLegacyEvents(bus);

      await emitPhaseTransition(bus, 'executing');
      expect(events).toHaveLength(1);

      unsub();

      await emitPhaseTransition(bus, 'reviewing');
      expect(events).toHaveLength(1); // no new event
    });

    it('should forward multiple events in order', async () => {
      const { events } = collectLegacyEvents(bus);

      await emitTaskStart(bus, 'task-1', 'coder');
      await emitTaskDone(bus, 'task-1', 'coder', 500);
      await emitAlert(bus, 'done', 'info');

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('task_start');
      expect(events[1].type).toBe('task_done');
      expect(events[2].type).toBe('alert');
    });

    it('should support multiple bridge callbacks simultaneously', async () => {
      const eventsA: LegacyForgeEvent[] = [];
      const eventsB: LegacyForgeEvent[] = [];
      bridgeOnEventCallback(bus, (e) => eventsA.push(e));
      bridgeOnEventCallback(bus, (e) => eventsB.push(e));

      await emitPhaseTransition(bus, 'setup');

      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(1);
    });
  });

  // ---- toLegacyEvent (indirect) — type mapping ----

  describe('toLegacyEvent type mapping', () => {
    it('phase_transition → phase', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<PhaseTransitionEvent>({
        type: 'phase_transition',
        from: 'setup',
        to: 'planning',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('phase');
    });

    it('task_start → task_start with role and taskId', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<TaskStartEvent>({
        type: 'task_start',
        taskId: 't-1',
        role: 'coder',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('task_start');
      expect(events[0].role).toBe('coder');
      expect(events[0].taskId).toBe('t-1');
    });

    it('task_done → task_done with role and taskId', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<TaskDoneEvent>({
        type: 'task_done',
        taskId: 't-2',
        role: 'tester',
        durationMs: 100,
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('task_done');
      expect(events[0].role).toBe('tester');
      expect(events[0].taskId).toBe('t-2');
    });

    it('task_fail → task_fail with role and taskId', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<TaskFailEvent>({
        type: 'task_fail',
        taskId: 't-3',
        role: 'researcher',
        error: 'boom',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('task_fail');
      expect(events[0].role).toBe('researcher');
      expect(events[0].taskId).toBe('t-3');
    });

    it('task_retry → task_start (legacy mapping) with role and taskId', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<TaskRetryEvent>({
        type: 'task_retry',
        taskId: 't-4',
        role: 'coder',
        attempt: 2,
        reason: 'timeout',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('task_start'); // mapped to task_start
      expect(events[0].role).toBe('coder');
      expect(events[0].taskId).toBe('t-4');
    });

    it('critic_review → critic', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<CriticReviewEvent>({
        type: 'critic_review',
        iteration: 1,
        passed: true,
        feedback: 'ok',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('critic');
    });

    it('verifier_check → critic (legacy mapping)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<VerifierCheckEvent>({
        type: 'verifier_check',
        iteration: 2,
        passed: false,
        result: 'issues found',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('critic'); // mapped to critic
    });

    it('alert → alert', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<AlertEvent>({
        type: 'alert',
        severity: 'warn',
        message: 'warning msg',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
      expect(events[0].message).toBe('warning msg');
    });

    it('error → alert', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<ErrorEvent>({
        type: 'error',
        severity: 'error',
        error: 'crash',
        fatal: false,
        message: 'error msg',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('middleware_enter → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<MiddlewareEnterEvent>({
        type: 'middleware_enter',
        middlewareName: 'quality-gate',
        hook: 'before',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('memory_update → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<MemoryUpdateEvent>({
        type: 'memory_update',
        entryCount: 10,
        updateSource: 'agent',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('semaphore_acquire → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<SemaphoreAcquireEvent>({
        type: 'semaphore_acquire',
        taskId: 's-1',
        activeCount: 1,
        maxPermits: 3,
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('config_change → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<ConfigChangeEvent>({
        type: 'config_change',
        key: 'maxIterations',
        oldValue: 3,
        newValue: 5,
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('dashboard_update → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<DashboardUpdateEvent>({
        type: 'dashboard_update',
        metrics: { tasks: 5 },
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });

    it('quality_gate → alert (no legacy equivalent)', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<QualityGateEvent>({
        type: 'quality_gate',
        gateName: 'accuracy',
        passed: true,
        score: 0.95,
        reason: 'above threshold',
        message: 'test',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].type).toBe('alert');
    });
  });

  // ---- Legacy event shape ----

  describe('legacy event shape', () => {
    it('should always have type, message, and timestamp', async () => {
      const { events } = collectLegacyEvents(bus);
      await emitAlert(bus, 'hello', 'info');

      const legacy = events[0];
      expect(legacy).toHaveProperty('type');
      expect(legacy).toHaveProperty('message');
      expect(legacy).toHaveProperty('timestamp');
      expect(typeof legacy.type).toBe('string');
      expect(typeof legacy.message).toBe('string');
      expect(typeof legacy.timestamp).toBe('string');
    });

    it('should preserve the original message text', async () => {
      const { events } = collectLegacyEvents(bus);
      const ev = createForgeEvent<AlertEvent>({
        type: 'alert',
        severity: 'info',
        message: 'exact message text',
        source: 'test',
      });
      await bus.emit(ev);

      expect(events[0].message).toBe('exact message text');
    });

    it('should preserve the original timestamp', async () => {
      const { events } = collectLegacyEvents(bus);
      const fixedTs = '2026-01-15T10:30:00.000Z';
      const ev: ForgeEvent = {
        type: 'alert',
        severity: 'info',
        message: 'ts test',
        source: 'test',
        timestamp: fixedTs,
      };
      await bus.emit(ev);

      expect(events[0].timestamp).toBe(fixedTs);
    });

    it('should not include role/taskId for events without them', async () => {
      const { events } = collectLegacyEvents(bus);
      await emitPhaseTransition(bus, 'setup');

      expect(events[0].role).toBeUndefined();
      expect(events[0].taskId).toBeUndefined();
    });
  });

  // ---- emitPhaseTransition ----

  describe('emitPhaseTransition', () => {
    it('should emit a phase_transition event with from and to', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('phase_transition', (e) => { captured.push(e); });

      await emitPhaseTransition(bus, 'executing', 'planning');

      expect(captured).toHaveLength(1);
      const ev = captured[0] as PhaseTransitionEvent;
      expect(ev.type).toBe('phase_transition');
      expect(ev.from).toBe('planning');
      expect(ev.to).toBe('executing');
      expect(ev.source).toBe('ForgeEngine');
    });

    it('should default fromPhase to "unknown"', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('phase_transition', (e) => { captured.push(e); });

      await emitPhaseTransition(bus, 'setup');

      const ev = captured[0] as PhaseTransitionEvent;
      expect(ev.from).toBe('unknown');
      expect(ev.to).toBe('setup');
    });

    it('should include "Phase →" in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('phase_transition', (e) => { captured.push(e); });

      await emitPhaseTransition(bus, 'reviewing');

      expect(captured[0].message).toContain('Phase');
      expect(captured[0].message).toContain('reviewing');
    });
  });

  // ---- emitIterationStart ----

  describe('emitIterationStart', () => {
    it('should emit iteration_start with iteration and plannedTaskCount', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_start', (e) => { captured.push(e); });

      await emitIterationStart(bus, 0, 5);

      expect(captured).toHaveLength(1);
      const ev = captured[0] as IterationStartEvent;
      expect(ev.type).toBe('iteration_start');
      expect(ev.iteration).toBe(0);
      expect(ev.plannedTaskCount).toBe(5);
      expect(ev.source).toBe('ForgeEngine');
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_start', (e) => { captured.push(e); });

      await emitIterationStart(bus, 1, 3, 'corr-123');

      const ev = captured[0] as IterationStartEvent;
      expect(ev.correlationId).toBe('corr-123');
    });

    it('should include iteration number and task count in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_start', (e) => { captured.push(e); });

      await emitIterationStart(bus, 2, 7);

      expect(captured[0].message).toContain('2');
      expect(captured[0].message).toContain('7');
    });
  });

  // ---- emitIterationEnd ----

  describe('emitIterationEnd', () => {
    it('should emit iteration_end with duration and success', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { captured.push(e); });

      await emitIterationEnd(bus, 1, 2500, true);

      expect(captured).toHaveLength(1);
      const ev = captured[0] as IterationEndEvent;
      expect(ev.type).toBe('iteration_end');
      expect(ev.iteration).toBe(1);
      expect(ev.durationMs).toBe(2500);
      expect(ev.success).toBe(true);
    });

    it('should reflect failure in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { captured.push(e); });

      await emitIterationEnd(bus, 0, 1000, false);

      expect(captured[0].message).toContain('failed');
    });

    it('should reflect success in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { captured.push(e); });

      await emitIterationEnd(bus, 0, 1000, true);

      expect(captured[0].message).toContain('completed');
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { captured.push(e); });

      await emitIterationEnd(bus, 0, 500, true, 'corr-456');

      const ev = captured[0] as IterationEndEvent;
      expect(ev.correlationId).toBe('corr-456');
    });
  });

  // ---- emitIterationLifecycle ----

  describe('emitIterationLifecycle', () => {
    it('should emit iteration_start immediately and return a finalizer', async () => {
      const starts: ForgeEvent[] = [];
      const ends: ForgeEvent[] = [];
      bus.on('iteration_start', (e) => { starts.push(e); });
      bus.on('iteration_end', (e) => { ends.push(e); });

      const finalize = await emitIterationLifecycle(bus, 0, 5);

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(0);
      expect(typeof finalize).toBe('function');
    });

    it('should emit iteration_end when finalizer is called with success=true', async () => {
      const ends: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { ends.push(e); });

      const finalize = await emitIterationLifecycle(bus, 1, 3);
      await finalize(true);

      expect(ends).toHaveLength(1);
      const ev = ends[0] as IterationEndEvent;
      expect(ev.success).toBe(true);
      expect(ev.iteration).toBe(1);
      expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should emit iteration_end when finalizer is called with success=false', async () => {
      const ends: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { ends.push(e); });

      const finalize = await emitIterationLifecycle(bus, 2, 4);
      await finalize(false);

      const ev = ends[0] as IterationEndEvent;
      expect(ev.success).toBe(false);
    });

    it('should measure elapsed time between start and finalize', async () => {
      const ends: ForgeEvent[] = [];
      bus.on('iteration_end', (e) => { ends.push(e); });

      // Mock Date.now for deterministic timing
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValueOnce(1000); // start
      const finalize = await emitIterationLifecycle(bus, 0, 2);
      now.mockReturnValueOnce(1050); // end
      await finalize(true);
      now.mockRestore();

      const ev = ends[0] as IterationEndEvent;
      expect(ev.durationMs).toBe(50);
    });

    it('should forward correlationId to both start and end', async () => {
      const starts: ForgeEvent[] = [];
      const ends: ForgeEvent[] = [];
      bus.on('iteration_start', (e) => { starts.push(e); });
      bus.on('iteration_end', (e) => { ends.push(e); });

      const finalize = await emitIterationLifecycle(bus, 0, 1, 'corr-789');
      await finalize(true);

      expect((starts[0] as IterationStartEvent).correlationId).toBe('corr-789');
      expect((ends[0] as IterationEndEvent).correlationId).toBe('corr-789');
    });
  });

  // ---- emitTaskStart ----

  describe('emitTaskStart', () => {
    it('should emit task_start with taskId and role', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_start', (e) => { captured.push(e); });

      await emitTaskStart(bus, 'r5-test-1', 'tester');

      expect(captured).toHaveLength(1);
      const ev = captured[0] as TaskStartEvent;
      expect(ev.type).toBe('task_start');
      expect(ev.taskId).toBe('r5-test-1');
      expect(ev.role).toBe('tester');
      expect(ev.source).toBe('ForgeEngine');
    });

    it('should include role and taskId in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_start', (e) => { captured.push(e); });

      await emitTaskStart(bus, 'my-task', 'coder');

      expect(captured[0].message).toContain('coder');
      expect(captured[0].message).toContain('my-task');
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_start', (e) => { captured.push(e); });

      await emitTaskStart(bus, 't-1', 'r', 'corr-abc');

      expect((captured[0] as TaskStartEvent).correlationId).toBe('corr-abc');
    });
  });

  // ---- emitTaskDone ----

  describe('emitTaskDone', () => {
    it('should emit task_done with taskId, role, durationMs', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_done', (e) => { captured.push(e); });

      await emitTaskDone(bus, 'r5-task', 'coder', 1500);

      expect(captured).toHaveLength(1);
      const ev = captured[0] as TaskDoneEvent;
      expect(ev.type).toBe('task_done');
      expect(ev.taskId).toBe('r5-task');
      expect(ev.role).toBe('coder');
      expect(ev.durationMs).toBe(1500);
    });

    it('should include optional costUsd', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_done', (e) => { captured.push(e); });

      await emitTaskDone(bus, 't-1', 'coder', 200, 0.05);

      const ev = captured[0] as TaskDoneEvent;
      expect(ev.costUsd).toBe(0.05);
    });

    it('should leave costUsd undefined when not provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_done', (e) => { captured.push(e); });

      await emitTaskDone(bus, 't-1', 'coder', 200);

      const ev = captured[0] as TaskDoneEvent;
      expect(ev.costUsd).toBeUndefined();
    });

    it('should include durationMs in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_done', (e) => { captured.push(e); });

      await emitTaskDone(bus, 't-1', 'coder', 3000);

      expect(captured[0].message).toContain('3000');
    });
  });

  // ---- emitTaskFail ----

  describe('emitTaskFail', () => {
    it('should emit task_fail with taskId, role, error', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_fail', (e) => { captured.push(e); });

      await emitTaskFail(bus, 'fail-task', 'researcher', 'timeout exceeded');

      expect(captured).toHaveLength(1);
      const ev = captured[0] as TaskFailEvent;
      expect(ev.type).toBe('task_fail');
      expect(ev.taskId).toBe('fail-task');
      expect(ev.role).toBe('researcher');
      expect(ev.error).toBe('timeout exceeded');
    });

    it('should include error in message', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_fail', (e) => { captured.push(e); });

      await emitTaskFail(bus, 't-1', 'coder', 'segfault');

      expect(captured[0].message).toContain('segfault');
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('task_fail', (e) => { captured.push(e); });

      await emitTaskFail(bus, 't-1', 'r', 'err', 'corr-fail');

      expect((captured[0] as TaskFailEvent).correlationId).toBe('corr-fail');
    });
  });

  // ---- emitCriticReview ----

  describe('emitCriticReview', () => {
    it('should emit critic_review with iteration, passed, feedback', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('critic_review', (e) => { captured.push(e); });

      await emitCriticReview(bus, 3, true, 'all good');

      expect(captured).toHaveLength(1);
      const ev = captured[0] as CriticReviewEvent;
      expect(ev.type).toBe('critic_review');
      expect(ev.iteration).toBe(3);
      expect(ev.passed).toBe(true);
      expect(ev.feedback).toBe('all good');
    });

    it('should reflect PASS in message when passed=true', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('critic_review', (e) => { captured.push(e); });

      await emitCriticReview(bus, 1, true, 'ok');

      expect(captured[0].message).toContain('PASS');
    });

    it('should reflect FAIL in message when passed=false', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('critic_review', (e) => { captured.push(e); });

      await emitCriticReview(bus, 1, false, 'issues');

      expect(captured[0].message).toContain('FAIL');
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('critic_review', (e) => { captured.push(e); });

      await emitCriticReview(bus, 0, true, 'fine', 'corr-crit');

      expect((captured[0] as CriticReviewEvent).correlationId).toBe('corr-crit');
    });
  });

  // ---- emitAlert ----

  describe('emitAlert', () => {
    it('should emit alert with message and severity', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('alert', (e) => { captured.push(e); });

      await emitAlert(bus, 'disk full', 'warn');

      expect(captured).toHaveLength(1);
      const ev = captured[0] as AlertEvent;
      expect(ev.type).toBe('alert');
      expect(ev.message).toBe('disk full');
      expect(ev.severity).toBe('warn');
    });

    it('should default severity to "info"', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('alert', (e) => { captured.push(e); });

      await emitAlert(bus, 'notice');

      const ev = captured[0] as AlertEvent;
      expect(ev.severity).toBe('info');
    });

    it('should include optional detail', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('alert', (e) => { captured.push(e); });

      await emitAlert(bus, 'err', 'error', 'stack trace here');

      const ev = captured[0] as AlertEvent;
      expect(ev.detail).toBe('stack trace here');
    });

    it('should leave detail undefined when not provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('alert', (e) => { captured.push(e); });

      await emitAlert(bus, 'info msg', 'info');

      const ev = captured[0] as AlertEvent;
      expect(ev.detail).toBeUndefined();
    });

    it('should include correlationId when provided', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('alert', (e) => { captured.push(e); });

      await emitAlert(bus, 'x', 'info', undefined, 'corr-alert');

      expect((captured[0] as AlertEvent).correlationId).toBe('corr-alert');
    });
  });

  // ---- source field ----

  describe('source field', () => {
    it('all emit helpers set source to "ForgeEngine"', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('*', (e) => { captured.push(e); });

      await emitPhaseTransition(bus, 'a');
      await emitIterationStart(bus, 0, 1);
      await emitIterationEnd(bus, 0, 100, true);
      await emitTaskStart(bus, 't', 'r');
      await emitTaskDone(bus, 't', 'r', 50);
      await emitTaskFail(bus, 't', 'r', 'e');
      await emitCriticReview(bus, 0, true, 'ok');
      await emitAlert(bus, 'x');

      for (const ev of captured) {
        expect(ev.source).toBe('ForgeEngine');
      }
    });
  });

  // ---- timestamp field ----

  describe('timestamp field', () => {
    it('all emitted events have a valid ISO-8601 timestamp', async () => {
      const captured: ForgeEvent[] = [];
      bus.on('*', (e) => { captured.push(e); });

      await emitPhaseTransition(bus, 'a');
      await emitTaskStart(bus, 't', 'r');
      await emitAlert(bus, 'x');

      for (const ev of captured) {
        expect(ev.timestamp).toBeTruthy();
        // ISO-8601 parse should not return NaN
        expect(Number.isNaN(Date.parse(ev.timestamp))).toBe(false);
      }
    });
  });

  // ---- Integration: bridge + emit helpers ----

  describe('integration: bridge + emit helpers', () => {
    it('should convert a full task lifecycle through the bridge', async () => {
      const { events } = collectLegacyEvents(bus);

      await emitIterationStart(bus, 0, 2);
      await emitTaskStart(bus, 'task-a', 'coder');
      await emitTaskDone(bus, 'task-a', 'coder', 100, 0.01);
      await emitTaskStart(bus, 'task-b', 'tester');
      await emitTaskFail(bus, 'task-b', 'tester', 'assertion failed');
      await emitCriticReview(bus, 0, false, 'task-b failed');
      await emitIterationEnd(bus, 0, 500, false);

      expect(events).toHaveLength(7);
      // Iteration start has no legacy type for iteration_start → alert fallback
      expect(events[0].type).toBe('alert'); // iteration_start → alert
      expect(events[1].type).toBe('task_start');
      expect(events[2].type).toBe('task_done');
      expect(events[3].type).toBe('task_start');
      expect(events[4].type).toBe('task_fail');
      expect(events[5].type).toBe('critic');
      expect(events[6].type).toBe('alert'); // iteration_end → alert
    });

    it('should handle emitIterationLifecycle through the bridge', async () => {
      const { events } = collectLegacyEvents(bus);

      const finalize = await emitIterationLifecycle(bus, 0, 1);
      await emitTaskStart(bus, 'only-task', 'dev');
      await finalize(true);

      expect(events).toHaveLength(3);
      // iteration_start → alert, task_start → task_start, iteration_end → alert
      expect(events[0].type).toBe('alert');
      expect(events[1].type).toBe('task_start');
      expect(events[2].type).toBe('alert');
    });
  });
});
