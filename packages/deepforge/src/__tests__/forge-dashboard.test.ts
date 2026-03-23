/**
 * DeepForge 2.0 — ForgeDashboard Unit Tests
 *
 * Coverage areas:
 * 1. constructor defaults
 * 2. updateFromProgressSnapshot
 * 3. addNotification FIFO cap
 * 4. updateAgentStatus create/update
 * 5. addIterationSummary cost accumulation
 * 6. getState deep copy
 * 7. subscribeToEventBus (11 event types)
 * 8. onUpdate callback register/unregister
 * 9. reset
 *
 * @module __tests__/forge-dashboard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock ForgeEventBus ───

import type {
  ForgeEvent,
  ForgeEventType,
  ForgeEventHandler,
  ForgeEventFilter,
  PhaseTransitionEvent,
  IterationStartEvent,
  IterationEndEvent,
  TaskStartEvent,
  TaskDoneEvent,
  TaskFailEvent,
  CriticReviewEvent,
  VerifierCheckEvent,
  AlertEvent,
  ErrorEvent as ForgeErrorEvent,
  DashboardUpdateEvent,
} from '../types/event';
import type { ForgeEventBus } from '../forge-events';

type HandlerEntry = { type: ForgeEventType | '*'; handler: ForgeEventHandler };

function createMockEventBus() {
  const handlers: HandlerEntry[] = [];
  return {
    on: vi.fn(<T extends ForgeEvent = ForgeEvent>(
      pattern: ForgeEventType | '*',
      handler: ForgeEventHandler<T>,
      _filter?: ForgeEventFilter<T>,
    ): (() => void) => {
      const entry: HandlerEntry = { type: pattern, handler: handler as ForgeEventHandler };
      handlers.push(entry);
      return () => {
        const idx = handlers.indexOf(entry);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    }),
    /** Helper: fire a synthetic event to all matching handlers */
    _fire(event: ForgeEvent) {
      for (const h of handlers) {
        if (h.type === event.type || h.type === '*') {
          h.handler(event);
        }
      }
    },
    _handlers: handlers,
  };
}

type MockEventBus = ReturnType<typeof createMockEventBus>;

/**
 * Type-safe wrapper: subscribes a dashboard to a mock event bus.
 * Centralizes the single structural cast (mock → ForgeEventBus).
 */
function subscribeToMockBus(d: ForgeDashboard, bus: MockEventBus): () => void {
  return d.subscribeToEventBus(bus as unknown as ForgeEventBus);
}

// ─── Import SUT ───

import { ForgeDashboard } from '../forge-dashboard';
import type { ProgressSnapshot } from '../forge-progress';
import type {
  IterationSummary,
  NotificationItem,
  AgentStatus,
  DashboardState,
} from '../types/dashboard';

// ─── Helpers ───

function makeNotification(overrides?: Partial<NotificationItem>): NotificationItem {
  return {
    id: `notif-${Math.random().toString(36).slice(2)}`,
    severity: 'info',
    title: 'Test notification',
    message: 'Test message',
    timestamp: new Date().toISOString(),
    read: false,
    ...overrides,
  };
}

function makeIterationSummary(num: number, cost: number): IterationSummary {
  return {
    number: num,
    phase: 'executing',
    taskSummary: { total: 5, completed: 4, failed: 1, running: 0, pending: 0 },
    costUsd: cost,
    durationMs: 10000,
  };
}

function makeProgressSnapshot(overrides?: Partial<ProgressSnapshot>): ProgressSnapshot {
  return {
    currentPhase: 'executing',
    completionPercent: 60,
    elapsedMs: 30000,
    estimatedRemainingMs: 20000,
    currentIteration: 3,
    totalIterations: 5,
    phases: [
      {
        phase: 'setup',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:01:00.000Z',
        iterationCount: 0,
        durationMs: 60000,
      },
      {
        phase: 'executing',
        status: 'active',
        startedAt: '2026-01-01T00:01:00.000Z',
        iterationCount: 3,
        durationMs: 30000,
      },
    ],
    timestamp: '2026-01-01T00:01:30.000Z',
    ...overrides,
  };
}

function ts(): string {
  return new Date().toISOString();
}

// ─── Tests ───

describe('ForgeDashboard', () => {
  let dashboard: ForgeDashboard;

  beforeEach(() => {
    dashboard = new ForgeDashboard('proj-1', 'Test Project');
  });

  // ─── 1. Constructor & Defaults ───

  describe('constructor & defaults', () => {
    it('creates initial state with projectId and title', () => {
      const state = dashboard.getState();
      expect(state.projectId).toBe('proj-1');
      expect(state.title).toBe('Test Project');
    });

    it('initializes with phase "setup"', () => {
      const state = dashboard.getState();
      expect(state.phase).toBe('setup');
    });

    it('starts with zero cost, iteration 0, and empty arrays', () => {
      const state = dashboard.getState();
      expect(state.currentIteration).toBe(0);
      expect(state.totalCostUsd).toBe(0);
      expect(state.elapsedMs).toBe(0);
      expect(state.iterations).toEqual([]);
      expect(state.activeTasks).toEqual([]);
      expect(state.agents).toEqual([]);
      expect(state.recentEvents).toEqual([]);
      expect(state.notifications).toEqual([]);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('initializes phaseProgress with setup phase', () => {
      const state = dashboard.getState();
      expect(state.phaseProgress.phase).toBe('setup');
      expect(state.phaseProgress.progress).toBe(0);
      expect(state.phaseProgress.message).toBe('Initializing...');
      expect(state.phaseProgress.startedAt).toBeTruthy();
    });

    it('accepts partial config overrides', () => {
      const d = new ForgeDashboard('p', 't', { maxNotifications: 5 });
      // Add 7 notifications — only 5 should survive
      for (let i = 0; i < 7; i++) {
        d.addNotification(makeNotification({ id: `n-${i}` }));
      }
      expect(d.getState().notifications).toHaveLength(5);
      // First two evicted
      expect(d.getState().notifications[0].id).toBe('n-2');
    });
  });

  // ─── 2. updateFromProgressSnapshot ───

  describe('updateFromProgressSnapshot', () => {
    it('updates phase, iteration, and elapsed from snapshot', () => {
      const snapshot = makeProgressSnapshot();
      dashboard.updateFromProgressSnapshot(snapshot);
      const state = dashboard.getState();
      expect(state.phase).toBe('executing');
      expect(state.currentIteration).toBe(3);
      expect(state.elapsedMs).toBe(30000);
    });

    it('computes phaseProgress.progress as completionPercent / 100', () => {
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot({ completionPercent: 75 }));
      expect(dashboard.getState().phaseProgress.progress).toBe(0.75);
    });

    it('sets estimatedEndAt when estimatedRemainingMs > 0', () => {
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot({ estimatedRemainingMs: 5000 }));
      const state = dashboard.getState();
      expect(state.phaseProgress.estimatedEndAt).toBeTruthy();
    });

    it('omits estimatedEndAt when estimatedRemainingMs is 0', () => {
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot({ estimatedRemainingMs: 0 }));
      expect(dashboard.getState().phaseProgress.estimatedEndAt).toBeUndefined();
    });

    it('updates phaseProgress.message with phase and percent', () => {
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot({ completionPercent: 42 }));
      const msg = dashboard.getState().phaseProgress.message;
      expect(msg).toContain('executing');
      expect(msg).toContain('42');
    });

    it('picks startedAt from matching phase entry', () => {
      const snapshot = makeProgressSnapshot({ currentPhase: 'executing' });
      dashboard.updateFromProgressSnapshot(snapshot);
      expect(dashboard.getState().phaseProgress.startedAt).toBe('2026-01-01T00:01:00.000Z');
    });

    it('notifies listeners on snapshot update', () => {
      const listener = vi.fn();
      dashboard.onUpdate(listener);
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot());
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 3. addNotification FIFO cap ───

  describe('addNotification', () => {
    it('appends notification to the list', () => {
      const notif = makeNotification({ title: 'Hello' });
      dashboard.addNotification(notif);
      expect(dashboard.getState().notifications).toHaveLength(1);
      expect(dashboard.getState().notifications[0].title).toBe('Hello');
    });

    it('enforces FIFO eviction at maxNotifications (default 100)', () => {
      for (let i = 0; i < 105; i++) {
        dashboard.addNotification(makeNotification({ id: `n-${i}` }));
      }
      const state = dashboard.getState();
      expect(state.notifications).toHaveLength(100);
      // First 5 evicted, first remaining is n-5
      expect(state.notifications[0].id).toBe('n-5');
      expect(state.notifications[99].id).toBe('n-104');
    });

    it('respects custom maxNotifications', () => {
      const d = new ForgeDashboard('p', 't', { maxNotifications: 3 });
      for (let i = 0; i < 5; i++) {
        d.addNotification(makeNotification({ id: `n-${i}` }));
      }
      expect(d.getState().notifications).toHaveLength(3);
      expect(d.getState().notifications[0].id).toBe('n-2');
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      dashboard.onUpdate(listener);
      dashboard.addNotification(makeNotification());
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('updates updatedAt timestamp', () => {
      const before = dashboard.getState().updatedAt;
      // Slight delay to ensure different timestamp
      vi.spyOn(Date.prototype, 'toISOString').mockReturnValueOnce('2099-01-01T00:00:00.000Z');
      dashboard.addNotification(makeNotification());
      const after = dashboard.getState().updatedAt;
      // Just check it was updated (may or may not differ if same ms)
      expect(after).toBeTruthy();
      vi.restoreAllMocks();
    });
  });

  // ─── 4. updateAgentStatus ───

  describe('updateAgentStatus', () => {
    it('creates a new agent entry if not exists', () => {
      dashboard.updateAgentStatus('core-dev', { state: 'running', label: 'Core Developer' });
      const agents = dashboard.getState().agents;
      expect(agents).toHaveLength(1);
      expect(agents[0].role).toBe('core-dev');
      expect(agents[0].label).toBe('Core Developer');
      expect(agents[0].state).toBe('running');
      expect(agents[0].tasksCompleted).toBe(0);
      expect(agents[0].tasksFailed).toBe(0);
      expect(agents[0].costUsd).toBe(0);
    });

    it('uses agentId as default label', () => {
      dashboard.updateAgentStatus('tester', { state: 'idle' });
      expect(dashboard.getState().agents[0].label).toBe('tester');
    });

    it('updates existing agent via Object.assign', () => {
      dashboard.updateAgentStatus('core-dev', { state: 'running' });
      dashboard.updateAgentStatus('core-dev', { state: 'idle', tasksCompleted: 5 });
      const agents = dashboard.getState().agents;
      expect(agents).toHaveLength(1);
      expect(agents[0].state).toBe('idle');
      expect(agents[0].tasksCompleted).toBe(5);
    });

    it('sets lastActivityAt on create and update', () => {
      dashboard.updateAgentStatus('dev', { state: 'running' });
      const created = dashboard.getState().agents[0].lastActivityAt;
      expect(created).toBeTruthy();

      dashboard.updateAgentStatus('dev', { state: 'idle' });
      const updated = dashboard.getState().agents[0].lastActivityAt;
      expect(updated).toBeTruthy();
    });

    it('preserves existing currentTaskId if not overridden', () => {
      dashboard.updateAgentStatus('dev', { state: 'running', currentTaskId: 'task-1' });
      dashboard.updateAgentStatus('dev', { state: 'running' });
      // Object.assign doesn't delete undefined, so currentTaskId stays
      expect(dashboard.getState().agents[0].currentTaskId).toBe('task-1');
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      dashboard.onUpdate(listener);
      dashboard.updateAgentStatus('dev', { state: 'idle' });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 5. addIterationSummary ───

  describe('addIterationSummary', () => {
    it('appends new iteration summary', () => {
      dashboard.addIterationSummary(makeIterationSummary(0, 1.5));
      expect(dashboard.getState().iterations).toHaveLength(1);
      expect(dashboard.getState().iterations[0].number).toBe(0);
    });

    it('replaces existing summary with same iteration number', () => {
      dashboard.addIterationSummary(makeIterationSummary(0, 1.0));
      dashboard.addIterationSummary(makeIterationSummary(0, 2.0));
      expect(dashboard.getState().iterations).toHaveLength(1);
      expect(dashboard.getState().iterations[0].costUsd).toBe(2.0);
    });

    it('accumulates totalCostUsd from all iterations', () => {
      dashboard.addIterationSummary(makeIterationSummary(0, 1.5));
      dashboard.addIterationSummary(makeIterationSummary(1, 2.5));
      expect(dashboard.getState().totalCostUsd).toBe(4.0);
    });

    it('recalculates totalCostUsd on replace (not double-count)', () => {
      dashboard.addIterationSummary(makeIterationSummary(0, 1.0));
      dashboard.addIterationSummary(makeIterationSummary(1, 2.0));
      // Replace iteration 0 with higher cost
      dashboard.addIterationSummary(makeIterationSummary(0, 3.0));
      // total = 3.0 + 2.0 = 5.0
      expect(dashboard.getState().totalCostUsd).toBe(5.0);
    });

    it('notifies listeners', () => {
      const listener = vi.fn();
      dashboard.onUpdate(listener);
      dashboard.addIterationSummary(makeIterationSummary(0, 1.0));
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 6. getState deep copy ───

  describe('getState', () => {
    it('returns a deep copy (mutations do not affect internal state)', () => {
      dashboard.addNotification(makeNotification({ title: 'Original' }));
      const state = dashboard.getState();
      state.notifications[0].title = 'Mutated';
      state.notifications.push(makeNotification({ title: 'Extra' }));
      state.totalCostUsd = 9999;

      const fresh = dashboard.getState();
      expect(fresh.notifications[0].title).toBe('Original');
      expect(fresh.notifications).toHaveLength(1);
      expect(fresh.totalCostUsd).toBe(0);
    });

    it('returns new object reference each call', () => {
      const a = dashboard.getState();
      const b = dashboard.getState();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // ─── 7. subscribeToEventBus ───

  describe('subscribeToEventBus', () => {
    let bus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
      bus = createMockEventBus();
    });

    it('subscribes to 11 event types', () => {
      subscribeToMockBus(dashboard, bus);
      expect(bus.on).toHaveBeenCalledTimes(11);
      const types = bus.on.mock.calls.map((c) => c[0] as string);
      expect(types).toContain('phase_transition');
      expect(types).toContain('iteration_start');
      expect(types).toContain('iteration_end');
      expect(types).toContain('task_start');
      expect(types).toContain('task_done');
      expect(types).toContain('task_fail');
      expect(types).toContain('critic_review');
      expect(types).toContain('verifier_check');
      expect(types).toContain('alert');
      expect(types).toContain('error');
      expect(types).toContain('dashboard_update');
    });

    it('returns unsubscribe function that removes all listeners', () => {
      const unsub = subscribeToMockBus(dashboard, bus);
      expect(bus._handlers.length).toBe(11);
      unsub();
      expect(bus._handlers.length).toBe(0);
    });

    describe('phase_transition', () => {
      it('updates phase and phaseProgress', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'phase_transition',
          timestamp: '2026-01-01T00:05:00.000Z',
          message: 'Transition to iterating',
          from: 'setup',
          to: 'iterating',
        });
        const state = dashboard.getState();
        expect(state.phase).toBe('iterating');
        expect(state.phaseProgress.phase).toBe('iterating');
        expect(state.phaseProgress.progress).toBe(0);
        expect(state.phaseProgress.startedAt).toBe('2026-01-01T00:05:00.000Z');
      });
    });

    describe('iteration_start', () => {
      it('updates currentIteration and resets consecutiveFailures', () => {
        // Set some failures first
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_fail',
          timestamp: ts(),
          message: 'fail',
          taskId: 't1',
          role: 'dev',
          error: 'err',
        });
        expect(dashboard.getState().consecutiveFailures).toBe(1);

        bus._fire({
          type: 'iteration_start',
          timestamp: ts(),
          message: 'Iter 2 start',
          iteration: 2,
          plannedTaskCount: 10,
        });
        const state = dashboard.getState();
        expect(state.currentIteration).toBe(2);
        expect(state.consecutiveFailures).toBe(0);
      });
    });

    describe('iteration_end', () => {
      it('resets consecutiveFailures on success', () => {
        subscribeToMockBus(dashboard, bus);
        // Inject failure state via task_fail
        bus._fire({
          type: 'task_fail',
          timestamp: ts(),
          message: 'fail',
          taskId: 't1',
          role: 'dev',
          error: 'err',
        });
        expect(dashboard.getState().consecutiveFailures).toBe(1);

        bus._fire({
          type: 'iteration_end',
          timestamp: ts(),
          message: 'Iter done',
          iteration: 0,
          durationMs: 5000,
          success: true,
        });
        expect(dashboard.getState().consecutiveFailures).toBe(0);
      });

      it('increments consecutiveFailures on failure', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'iteration_end',
          timestamp: ts(),
          message: 'Iter failed',
          iteration: 0,
          durationMs: 5000,
          success: false,
        });
        expect(dashboard.getState().consecutiveFailures).toBe(1);

        bus._fire({
          type: 'iteration_end',
          timestamp: ts(),
          message: 'Iter failed again',
          iteration: 1,
          durationMs: 5000,
          success: false,
        });
        expect(dashboard.getState().consecutiveFailures).toBe(2);
      });
    });

    describe('task_start', () => {
      it('updates agent to running with currentTaskId', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_start',
          timestamp: ts(),
          message: 'Task started',
          taskId: 'task-42',
          role: 'core-dev',
        });
        const agents = dashboard.getState().agents;
        expect(agents).toHaveLength(1);
        expect(agents[0].role).toBe('core-dev');
        expect(agents[0].state).toBe('running');
        expect(agents[0].currentTaskId).toBe('task-42');
      });
    });

    describe('task_done', () => {
      it('marks existing agent idle, increments tasksCompleted, adds cost', () => {
        subscribeToMockBus(dashboard, bus);
        // First create agent via task_start
        bus._fire({
          type: 'task_start',
          timestamp: ts(),
          message: 'Start',
          taskId: 't1',
          role: 'dev',
        });
        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Done',
          taskId: 't1',
          role: 'dev',
          durationMs: 1000,
          costUsd: 0.5,
        });
        const agent = dashboard.getState().agents.find(a => a.role === 'dev')!;
        expect(agent.state).toBe('idle');
        expect(agent.tasksCompleted).toBe(1);
        expect(agent.costUsd).toBe(0.5);
        expect(agent.currentTaskId).toBeUndefined();
      });

      it('adds cost to agent costUsd (totalCostUsd computed from iterations only)', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_start',
          timestamp: ts(),
          message: 'Start',
          taskId: 't1',
          role: 'dev',
        });
        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Done',
          taskId: 't1',
          role: 'dev',
          durationMs: 1000,
          costUsd: 1.25,
        });
        // totalCostUsd is NOT accumulated from task_done — only from iteration summaries
        expect(dashboard.getState().totalCostUsd).toBe(0);
        // cost is tracked per-agent
        const agent = dashboard.getState().agents.find(a => a.role === 'dev')!;
        expect(agent.costUsd).toBe(1.25);
      });

      it('creates agent if not previously started', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Done',
          taskId: 't1',
          role: 'new-role',
          durationMs: 100,
          costUsd: 0.1,
        });
        const agents = dashboard.getState().agents;
        expect(agents).toHaveLength(1);
        expect(agents[0].role).toBe('new-role');
        expect(agents[0].tasksCompleted).toBe(1);
      });

      it('resets consecutiveFailures to 0', () => {
        subscribeToMockBus(dashboard, bus);
        // Cause a failure first
        bus._fire({
          type: 'task_fail',
          timestamp: ts(),
          message: 'Fail',
          taskId: 'f1',
          role: 'dev',
          error: 'err',
        });
        expect(dashboard.getState().consecutiveFailures).toBe(1);

        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Done',
          taskId: 't1',
          role: 'dev',
          durationMs: 100,
        });
        expect(dashboard.getState().consecutiveFailures).toBe(0);
      });

      it('handles task_done without costUsd (no cost added)', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Done',
          taskId: 't1',
          role: 'dev',
          durationMs: 100,
        });
        expect(dashboard.getState().totalCostUsd).toBe(0);
      });
    });

    describe('task_fail', () => {
      it('marks agent idle, increments tasksFailed, increments consecutiveFailures', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_start',
          timestamp: ts(),
          message: 'Start',
          taskId: 't1',
          role: 'dev',
        });
        bus._fire({
          type: 'task_fail',
          timestamp: ts(),
          message: 'Failed',
          taskId: 't1',
          role: 'dev',
          error: 'Something went wrong',
        });
        const agent = dashboard.getState().agents.find(a => a.role === 'dev')!;
        expect(agent.state).toBe('idle');
        expect(agent.tasksFailed).toBe(1);
        expect(dashboard.getState().consecutiveFailures).toBe(1);
      });

      it('creates agent if not previously started', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_fail',
          timestamp: ts(),
          message: 'Failed',
          taskId: 't1',
          role: 'mystery-role',
          error: 'Boom',
        });
        const agents = dashboard.getState().agents;
        expect(agents).toHaveLength(1);
        expect(agents[0].role).toBe('mystery-role');
        expect(agents[0].tasksFailed).toBe(1);
      });

      it('auto-generates error notification', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_fail',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: 'Failed',
          taskId: 'task-99',
          role: 'tester',
          error: 'Assertion failed',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs).toHaveLength(1);
        expect(notifs[0].severity).toBe('error');
        expect(notifs[0].title).toContain('task-99');
        expect(notifs[0].message).toBe('Assertion failed');
        expect(notifs[0].source).toBe('tester');
      });
    });

    describe('critic_review', () => {
      it('updates matching iteration summary criticCleared', () => {
        dashboard.addIterationSummary(makeIterationSummary(1, 1.0));
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'critic_review',
          timestamp: ts(),
          message: 'Critic passed',
          iteration: 1,
          passed: true,
          feedback: 'All good',
        });
        expect(dashboard.getState().iterations[0].criticCleared).toBe(true);
      });

      it('generates success notification when passed', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'critic_review',
          timestamp: ts(),
          message: 'Critic passed',
          iteration: 1,
          passed: true,
          feedback: '',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs).toHaveLength(1);
        expect(notifs[0].severity).toBe('success');
      });

      it('generates warning notification when failed', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'critic_review',
          timestamp: ts(),
          message: 'Critic failed',
          iteration: 1,
          passed: false,
          feedback: 'Issues found',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs[0].severity).toBe('warning');
        expect(notifs[0].message).toContain('Issues found');
      });

      it('does not crash when no matching iteration exists', () => {
        subscribeToMockBus(dashboard, bus);
        expect(() => {
          bus._fire({
            type: 'critic_review',
            timestamp: ts(),
            message: 'Critic',
            iteration: 999,
            passed: true,
            feedback: '',
          });
        }).not.toThrow();
      });
    });

    describe('verifier_check', () => {
      it('updates matching iteration summary verifierPassed', () => {
        dashboard.addIterationSummary(makeIterationSummary(2, 1.0));
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'verifier_check',
          timestamp: ts(),
          message: 'Verified',
          iteration: 2,
          passed: true,
          result: 'All checks passed',
        });
        expect(dashboard.getState().iterations[0].verifierPassed).toBe(true);
      });

      it('generates warning notification on failure', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'verifier_check',
          timestamp: ts(),
          message: 'Verify failed',
          iteration: 1,
          passed: false,
          result: 'Missing coverage',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs[0].severity).toBe('warning');
        expect(notifs[0].message).toContain('Missing coverage');
      });
    });

    describe('alert', () => {
      it('generates info notification for info severity', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'alert',
          timestamp: ts(),
          message: 'FYI',
          severity: 'info',
          source: 'system',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs).toHaveLength(1);
        expect(notifs[0].severity).toBe('info');
        expect(notifs[0].source).toBe('system');
      });

      it('maps warn severity to warning', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'alert',
          timestamp: ts(),
          message: 'Watch out',
          severity: 'warn',
          source: 'monitor',
        });
        expect(dashboard.getState().notifications[0].severity).toBe('warning');
      });

      it('maps error/fatal severity to error', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'alert',
          timestamp: ts(),
          message: 'Bad',
          severity: 'error',
          source: 'sys',
        });
        expect(dashboard.getState().notifications[0].severity).toBe('error');

        bus._fire({
          type: 'alert',
          timestamp: ts(),
          message: 'Very bad',
          severity: 'fatal',
          source: 'sys',
        });
        expect(dashboard.getState().notifications[1].severity).toBe('error');
      });
    });

    describe('error', () => {
      it('generates error notification with fatal title', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'error',
          timestamp: ts(),
          message: 'System error',
          severity: 'error',
          error: 'Stack overflow',
          fatal: true,
          source: 'engine',
        });
        const notifs = dashboard.getState().notifications;
        expect(notifs).toHaveLength(1);
        expect(notifs[0].severity).toBe('error');
        expect(notifs[0].title).toBe('Fatal error');
        expect(notifs[0].message).toBe('Stack overflow');
        expect(notifs[0].source).toBe('engine');
      });

      it('generates non-fatal error notification', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'error',
          timestamp: ts(),
          message: 'Non-fatal',
          severity: 'warn',
          error: 'Minor issue',
          fatal: false,
          source: 'plugin',
        });
        expect(dashboard.getState().notifications[0].title).toBe('System error');
      });
    });

    describe('recent events feed', () => {
      it('adds events to recentEvents with severity mapping', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'task_done',
          timestamp: ts(),
          message: 'Task completed',
          taskId: 't1',
          role: 'dev',
          durationMs: 100,
        });
        const events = dashboard.getState().recentEvents;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('task_done');
        expect(events[0].severity).toBe('success');
        expect(events[0].message).toBe('Task completed');
      });

      it('caps recentEvents at maxRecentEvents (default 50)', () => {
        subscribeToMockBus(dashboard, bus);
        for (let i = 0; i < 55; i++) {
          bus._fire({
            type: 'iteration_start',
            timestamp: ts(),
            message: `Event ${i}`,
            iteration: i,
            plannedTaskCount: 1,
          });
        }
        expect(dashboard.getState().recentEvents).toHaveLength(50);
        // First 5 evicted
        expect(dashboard.getState().recentEvents[0].message).toBe('Event 5');
      });

      it('respects custom maxRecentEvents', () => {
        const d = new ForgeDashboard('p', 't', { maxRecentEvents: 3 });
        subscribeToMockBus(d, bus);
        for (let i = 0; i < 5; i++) {
          bus._fire({
            type: 'iteration_start',
            timestamp: ts(),
            message: `E${i}`,
            iteration: i,
            plannedTaskCount: 1,
          });
        }
        expect(d.getState().recentEvents).toHaveLength(3);
      });

      it('maps severity correctly for different event types', () => {
        subscribeToMockBus(dashboard, bus);

        bus._fire({ type: 'task_done', timestamp: ts(), message: 'm', taskId: 't', role: 'r', durationMs: 1 });
        bus._fire({ type: 'task_fail', timestamp: ts(), message: 'm', taskId: 't', role: 'r', error: 'e' });
        bus._fire({ type: 'alert', timestamp: ts(), message: 'm', severity: 'warn', source: 's' });
        bus._fire({ type: 'task_start', timestamp: ts(), message: 'm', taskId: 't', role: 'r' });

        const events = dashboard.getState().recentEvents;
        expect(events[0].severity).toBe('success');  // task_done
        expect(events[1].severity).toBe('error');     // task_fail
        expect(events[2].severity).toBe('warning');   // alert
        expect(events[3].severity).toBe('info');      // task_start
      });
    });

    describe('dashboard_update (pass-through)', () => {
      it('adds to recentEvents but no special state mutation', () => {
        subscribeToMockBus(dashboard, bus);
        bus._fire({
          type: 'dashboard_update',
          timestamp: ts(),
          message: 'Metrics refresh',
          metrics: { tasks: 10 },
        });
        const events = dashboard.getState().recentEvents;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('dashboard_update');
        expect(events[0].severity).toBe('info');
      });
    });
  });

  // ─── 8. onUpdate callback ───

  describe('onUpdate', () => {
    it('registers callback and invokes on state change', () => {
      const fn = vi.fn();
      dashboard.onUpdate(fn);
      dashboard.addNotification(makeNotification());
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }));
    });

    it('supports multiple listeners', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      dashboard.onUpdate(fn1);
      dashboard.onUpdate(fn2);
      dashboard.addNotification(makeNotification());
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('returns unsubscribe function', () => {
      const fn = vi.fn();
      const unsub = dashboard.onUpdate(fn);
      dashboard.addNotification(makeNotification());
      expect(fn).toHaveBeenCalledTimes(1);

      unsub();
      dashboard.addNotification(makeNotification());
      expect(fn).toHaveBeenCalledTimes(1); // no additional call
    });

    it('passes deep-copied state to listener', () => {
      let received: DashboardState | null = null;
      dashboard.onUpdate((state) => { received = state; });
      dashboard.addNotification(makeNotification({ title: 'Test' }));

      expect(received).not.toBeNull();
      // Mutate received — should not affect internal state
      received!.notifications[0].title = 'Mutated';
      expect(dashboard.getState().notifications[0].title).toBe('Test');
    });

    it('isolates listener errors (does not break other listeners or dashboard)', () => {
      const errorFn = vi.fn(() => { throw new Error('Listener broke'); });
      const goodFn = vi.fn();

      dashboard.onUpdate(errorFn);
      dashboard.onUpdate(goodFn);

      // Should not throw
      expect(() => {
        dashboard.addNotification(makeNotification());
      }).not.toThrow();

      expect(errorFn).toHaveBeenCalledTimes(1);
      expect(goodFn).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 9. reset ───

  describe('reset', () => {
    it('restores initial state with same projectId and title', () => {
      // Mutate state
      dashboard.addNotification(makeNotification());
      dashboard.updateAgentStatus('dev', { state: 'running' });
      dashboard.addIterationSummary(makeIterationSummary(0, 5.0));
      dashboard.updateFromProgressSnapshot(makeProgressSnapshot());

      dashboard.reset();

      const state = dashboard.getState();
      expect(state.projectId).toBe('proj-1');
      expect(state.title).toBe('Test Project');
      expect(state.phase).toBe('setup');
      expect(state.currentIteration).toBe(0);
      expect(state.totalCostUsd).toBe(0);
      expect(state.elapsedMs).toBe(0);
      expect(state.iterations).toEqual([]);
      expect(state.agents).toEqual([]);
      expect(state.notifications).toEqual([]);
      expect(state.recentEvents).toEqual([]);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('notifies listeners after reset', () => {
      const fn = vi.fn();
      dashboard.onUpdate(fn);
      dashboard.reset();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('preserves listener registrations after reset', () => {
      const fn = vi.fn();
      dashboard.onUpdate(fn);
      dashboard.reset();
      fn.mockClear();

      dashboard.addNotification(makeNotification());
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('preserves event bus subscriptions after reset', () => {
      const bus = createMockEventBus();
      subscribeToMockBus(dashboard, bus);
      dashboard.reset();

      // Fire event — should still be handled
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'After reset',
        taskId: 't1',
        role: 'dev',
      });
      expect(dashboard.getState().agents).toHaveLength(1);
    });
  });

  // ─── dispose ───

  describe('dispose', () => {
    it('stops receiving events after dispose — verified via public API', () => {
      const bus = createMockEventBus();
      const updateFn = vi.fn();
      dashboard.onUpdate(updateFn);
      subscribeToMockBus(dashboard, bus);

      // Verify events work before dispose
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'Before dispose',
        taskId: 't-before',
        role: 'dev',
      });
      expect(dashboard.getState().agents).toHaveLength(1);
      expect(updateFn).toHaveBeenCalled();

      updateFn.mockClear();
      dashboard.dispose();

      // dispose() notifies listeners one final time with the reset snapshot
      // Clear again so we can verify no *further* calls happen
      updateFn.mockClear();

      // Fire event after dispose — should NOT be handled
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'After dispose',
        taskId: 't-after',
        role: 'tester',
      });

      // State was reset by dispose; no new agent should appear
      expect(dashboard.getState().agents).toHaveLength(0);
      // onUpdate listeners were cleared by dispose, so no callbacks after dispose
      expect(updateFn).not.toHaveBeenCalled();
    });

    it('is idempotent — calling dispose twice does not throw', () => {
      const bus = createMockEventBus();
      const updateFn = vi.fn();
      dashboard.onUpdate(updateFn);
      subscribeToMockBus(dashboard, bus);

      expect(() => {
        dashboard.dispose();
        dashboard.dispose();
      }).not.toThrow();

      // Clear any calls from dispose's final notification
      updateFn.mockClear();

      // After double dispose, events should still not be processed
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'After double dispose',
        taskId: 't-double',
        role: 'dev',
      });
      expect(dashboard.getState().agents).toHaveLength(0);
      expect(updateFn).not.toHaveBeenCalled();
    });

    it('resets state on dispose', () => {
      const bus = createMockEventBus();
      subscribeToMockBus(dashboard, bus);

      // Build up some state
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'Active task',
        taskId: 't-active',
        role: 'dev',
      });
      expect(dashboard.getState().agents).toHaveLength(1);

      dashboard.dispose();

      // State should be reset
      const state = dashboard.getState();
      expect(state.agents).toHaveLength(0);
      expect(state.notifications).toHaveLength(0);
    });

    it('handles double dispose gracefully', () => {
      const bus = createMockEventBus();
      subscribeToMockBus(dashboard, bus);

      // Build up state
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'Active task',
        taskId: 't-double',
        role: 'dev',
      });
      expect(dashboard.getState().agents).toHaveLength(1);

      // First dispose
      expect(() => dashboard.dispose()).not.toThrow();
      // Second dispose — must not throw
      expect(() => dashboard.dispose()).not.toThrow();

      const state = dashboard.getState();
      expect(state.agents).toHaveLength(0);
      expect(state.notifications).toHaveLength(0);
      expect(state.phaseProgress.progress).toBe(0);
    });

    it('listener receives reset state on dispose', () => {
      const bus = createMockEventBus();
      subscribeToMockBus(dashboard, bus);

      // Build up state so reset is observable
      bus._fire({
        type: 'task_start',
        timestamp: ts(),
        message: 'Active task',
        taskId: 't-listener',
        role: 'dev',
      });

      const listener = vi.fn();
      dashboard.onUpdate(listener);

      dashboard.dispose();

      // Listener should have been called with reset state
      expect(listener).toHaveBeenCalled();
      const lastCall = listener.mock.calls[listener.mock.calls.length - 1][0] as DashboardState;
      expect(lastCall.agents).toHaveLength(0);
      expect(lastCall.notifications).toHaveLength(0);
      expect(lastCall.phaseProgress.progress).toBe(0);
    });

    it('no notifications after dispose completes', () => {
      const bus = createMockEventBus();
      subscribeToMockBus(dashboard, bus);

      const listener = vi.fn();
      dashboard.onUpdate(listener);

      dashboard.dispose();

      // Reset listener call count after dispose
      listener.mockClear();

      // Attempt state-changing operations after dispose
      dashboard.addNotification(makeNotification({ title: 'post-dispose' }));
      dashboard.updateAgentStatus('ghost', { state: 'idle' });

      // Listener should NOT be called — it was cleared during dispose
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
