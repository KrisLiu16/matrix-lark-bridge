/**
 * DeepForge 2.0 — ForgeDashboard
 *
 * Aggregated dashboard state manager that consumes events from ForgeEventBus
 * and progress snapshots from ProgressMiddleware, producing a unified
 * DashboardState for UI rendering.
 *
 * Features:
 * - Maintains full DashboardState with phase progress, agent statuses,
 *   iteration summaries, notifications, and recent events
 * - Subscribes to ForgeEventBus for automatic state updates
 * - FIFO notification cap (configurable, default 100)
 * - Recent events ring buffer (configurable, default 50)
 * - Update callbacks for reactive UI binding
 * - Progress snapshot ingestion from ProgressMiddleware
 *
 * Zero external dependencies beyond types.
 *
 * @module forge-dashboard
 */

import type {
  DashboardState,
  DashboardConfig,
  DashboardUpdateFn,
  AgentStatus,
  IterationSummary,
  NotificationItem,
  DashboardEvent,
} from './types/dashboard';

import type {
  ForgeEvent,
  ForgeEventType,
  TaskStartEvent,
  TaskDoneEvent,
  TaskFailEvent,
  IterationStartEvent,
  IterationEndEvent,
  PhaseTransitionEvent,
  CriticReviewEvent,
  VerifierCheckEvent,
  AlertEvent,
  ErrorEvent,
} from './types/event';

import type { ForgeEventBus } from './forge-events';

import type { ProgressSnapshot } from './forge-progress';

// Re-import the default config value (runtime, not type)
// We inline defaults to avoid import issues with the const export
const DEFAULTS: DashboardConfig = {
  maxRecentEvents: 50,
  maxNotifications: 100,
  refreshIntervalMs: 2000,
  showCosts: true,
  showAgentDetail: true,
};

// ─── Helpers ───

function nowIso(): string {
  return new Date().toISOString();
}

// notificationCounter moved to ForgeDashboard instance to avoid multi-instance shared state

/**
 * Map event types to dashboard event severity for UI styling.
 */
function eventSeverity(event: ForgeEvent): 'info' | 'success' | 'warning' | 'error' {
  switch (event.type) {
    case 'task_done':
    case 'iteration_end':
      return 'success';
    case 'task_fail':
    case 'error':
    case 'middleware_error':
      return 'error';
    case 'alert':
    case 'quality_gate':
    case 'semaphore_timeout':
      return 'warning';
    default:
      return 'info';
  }
}

// ─── ForgeDashboard ───

export class ForgeDashboard {
  private readonly config: DashboardConfig;
  private state: DashboardState;
  private listeners: DashboardUpdateFn[] = [];
  private unsubscribes: Array<() => void> = [];
  private notificationCounter = 0;

  constructor(
    projectId: string,
    title: string,
    config?: Partial<DashboardConfig>,
  ) {
    this.config = { ...DEFAULTS, ...config };
    this.state = this.createInitialState(projectId, title);
  }

  private generateNotificationId(): string {
    this.notificationCounter++;
    return `notif-${Date.now()}-${this.notificationCounter}`;
  }

  // ─── State Initialization ───

  private createInitialState(projectId: string, title: string): DashboardState {
    return {
      projectId,
      title,
      phase: 'setup',
      currentIteration: 0,
      totalCostUsd: 0,
      elapsedMs: 0,
      iterations: [],
      activeTasks: [],
      phaseProgress: {
        phase: 'setup',
        progress: 0,
        message: 'Initializing...',
        startedAt: nowIso(),
      },
      agents: [],
      recentEvents: [],
      notifications: [],
      consecutiveFailures: 0,
      updatedAt: nowIso(),
    };
  }

  // ─── Progress Snapshot Integration ───

  /**
   * Ingest a ProgressSnapshot from ProgressMiddleware and update
   * phase progress, elapsed time, and iteration counter.
   */
  updateFromProgressSnapshot(snapshot: ProgressSnapshot): void {
    this.state.phase = snapshot.currentPhase;
    this.state.currentIteration = snapshot.currentIteration;
    this.state.elapsedMs = snapshot.elapsedMs;

    this.state.phaseProgress = {
      phase: snapshot.currentPhase,
      progress: snapshot.completionPercent / 100,
      message: `Phase: ${snapshot.currentPhase} — ${snapshot.completionPercent}% complete`,
      startedAt: snapshot.phases.find(p => p.phase === snapshot.currentPhase)?.startedAt ?? nowIso(),
      estimatedEndAt: snapshot.estimatedRemainingMs > 0
        ? new Date(Date.now() + snapshot.estimatedRemainingMs).toISOString()
        : undefined,
    };

    this.state.updatedAt = nowIso();
    this.notifyListeners();
  }

  // ─── Notification Management ───

  /**
   * Add a notification item. Enforces FIFO cap at maxNotifications.
   */
  addNotification(item: NotificationItem): void {
    this.state.notifications.push(item);

    // FIFO eviction when over limit
    while (this.state.notifications.length > this.config.maxNotifications) {
      this.state.notifications.shift();
    }

    this.state.updatedAt = nowIso();
    this.notifyListeners();
  }

  // ─── Agent Status Management ───

  /**
   * Update the status of a specific agent/role.
   * Creates the agent entry if it doesn't exist.
   */
  updateAgentStatus(agentId: string, status: Partial<AgentStatus>): void {
    const existing = this.state.agents.find(a => a.role === agentId);

    if (existing) {
      Object.assign(existing, status, { lastActivityAt: nowIso() });
    } else {
      this.state.agents.push({
        role: agentId,
        label: status.label ?? agentId,
        state: status.state ?? 'idle',
        currentTaskId: status.currentTaskId,
        tasksCompleted: status.tasksCompleted ?? 0,
        tasksFailed: status.tasksFailed ?? 0,
        costUsd: status.costUsd ?? 0,
        lastActivityAt: nowIso(),
      });
    }

    this.state.updatedAt = nowIso();
    this.notifyListeners();
  }

  // ─── Iteration Summary ───

  /**
   * Record a completed iteration summary.
   */
  addIterationSummary(summary: IterationSummary): void {
    // Replace if same iteration number exists, otherwise append
    const idx = this.state.iterations.findIndex(s => s.number === summary.number);
    if (idx !== -1) {
      this.state.iterations[idx] = summary;
    } else {
      this.state.iterations.push(summary);
    }

    // Accumulate cost
    this.state.totalCostUsd = this.state.iterations.reduce(
      (sum, iter) => sum + iter.costUsd,
      0,
    );

    this.state.updatedAt = nowIso();
    this.notifyListeners();
  }

  // ─── State Access ───

  /**
   * Return a deep-copied snapshot of the current dashboard state.
   */
  getState(): DashboardState {
    return structuredClone(this.state);
  }

  // ─── Event Bus Integration ───

  /**
   * Subscribe to a ForgeEventBus and automatically update dashboard state
   * based on incoming events. Subscribes to relevant event types:
   * - phase_transition, iteration_start, iteration_end
   * - task_start, task_done, task_fail
   * - critic_review, verifier_check
   * - alert, error
   * - dashboard_update
   *
   * Returns an unsubscribe function that removes all listeners.
   */
  subscribeToEventBus(eventBus: ForgeEventBus): () => void {
    const eventTypes: ForgeEventType[] = [
      'phase_transition',
      'iteration_start',
      'iteration_end',
      'task_start',
      'task_done',
      'task_fail',
      'critic_review',
      'verifier_check',
      'alert',
      'error',
      'dashboard_update',
    ];

    for (const eventType of eventTypes) {
      const unsub = eventBus.on(eventType, (event: ForgeEvent) => {
        this.handleEvent(event);
      });
      this.unsubscribes.push(unsub);
    }

    return () => {
      for (const unsub of this.unsubscribes) {
        unsub();
      }
      this.unsubscribes = [];
    };
  }

  // ─── Update Callbacks ───

  /**
   * Register a callback invoked whenever dashboard state changes.
   * Returns an unsubscribe function.
   */
  onUpdate(fn: DashboardUpdateFn): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // ─── Reset ───

  /**
   * Reset dashboard to initial state.
   */
  reset(): void {
    this.state = this.createInitialState(this.state.projectId, this.state.title);
    this.notifyListeners();
  }

  /**
   * Dispose the dashboard: reset state (notifying listeners once), unsubscribe
   * all event bus listeners, and clear update callbacks.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    // 1. Reset state (also notifies listeners with the reset snapshot)
    this.reset();

    // 2. Unsubscribe from event bus
    for (const unsub of this.unsubscribes) {
      unsub();
    }

    // 3. Clear subscriptions and listeners
    this.unsubscribes = [];
    this.listeners = [];
  }

  // ─── Internal: Event Handling ───

  private handleEvent(event: ForgeEvent): void {
    // Add to recent events feed
    this.pushRecentEvent(event);

    // Dispatch by type for state mutations
    switch (event.type) {
      case 'phase_transition':
        this.handlePhaseTransition(event);
        break;
      case 'iteration_start':
        this.handleIterationStart(event);
        break;
      case 'iteration_end':
        this.handleIterationEnd(event);
        break;
      case 'task_start':
        this.handleTaskStart(event);
        break;
      case 'task_done':
        this.handleTaskDone(event);
        break;
      case 'task_fail':
        this.handleTaskFail(event);
        break;
      case 'critic_review':
        this.handleCriticReview(event);
        break;
      case 'verifier_check':
        this.handleVerifierCheck(event);
        break;
      case 'alert':
        this.handleAlert(event);
        break;
      case 'error':
        this.handleError(event);
        break;
      default:
        // dashboard_update and other types — no special handling needed
        break;
    }

    this.state.updatedAt = nowIso();
    this.notifyListeners();
  }

  private handlePhaseTransition(event: PhaseTransitionEvent): void {
    this.state.phase = event.to as DashboardState['phase'];
    this.state.phaseProgress = {
      phase: event.to as DashboardState['phase'],
      progress: 0,
      message: `Transitioning to ${event.to}`,
      startedAt: event.timestamp,
    };
  }

  private handleIterationStart(event: IterationStartEvent): void {
    this.state.currentIteration = event.iteration;
    this.state.consecutiveFailures = 0;
  }

  private handleIterationEnd(event: IterationEndEvent): void {
    if (!event.success) {
      this.state.consecutiveFailures++;
    } else {
      this.state.consecutiveFailures = 0;
    }
  }

  private handleTaskStart(event: TaskStartEvent): void {
    // Update agent status to running
    this.updateAgentStatus(event.role, {
      state: 'running',
      currentTaskId: event.taskId,
    });
  }

  private handleTaskDone(event: TaskDoneEvent): void {
    // Update agent: mark completed, increment counter, add cost
    const agent = this.state.agents.find(a => a.role === event.role);
    if (agent) {
      agent.state = 'idle';
      agent.currentTaskId = undefined;
      agent.tasksCompleted++;
      if (event.costUsd) {
        agent.costUsd += event.costUsd;
      }
    } else {
      this.updateAgentStatus(event.role, {
        state: 'idle',
        tasksCompleted: 1,
        costUsd: event.costUsd ?? 0,
      });
    }
    // Note: state.totalCostUsd is NOT accumulated here — it is computed
    // from iteration summaries in addIterationSummary() to avoid dual
    // accumulation paths that would cause cost drift.

    // Reset consecutive failures on success
    this.state.consecutiveFailures = 0;
  }

  private handleTaskFail(event: TaskFailEvent): void {
    const agent = this.state.agents.find(a => a.role === event.role);
    if (agent) {
      agent.state = 'idle';
      agent.currentTaskId = undefined;
      agent.tasksFailed++;
    } else {
      this.updateAgentStatus(event.role, {
        state: 'idle',
        tasksFailed: 1,
      });
    }

    this.state.consecutiveFailures++;

    // Auto-generate error notification for task failures
    this.addNotification({
      id: this.generateNotificationId(),
      severity: 'error',
      title: `Task failed: ${event.taskId}`,
      message: event.error,
      timestamp: event.timestamp,
      source: event.role,
      read: false,
    });
  }

  private handleCriticReview(event: CriticReviewEvent): void {
    // Update the iteration summary if it exists
    const iterSummary = this.state.iterations.find(
      s => s.number === event.iteration,
    );
    if (iterSummary) {
      iterSummary.criticCleared = event.passed;
    }

    // Generate notification
    this.addNotification({
      id: this.generateNotificationId(),
      severity: event.passed ? 'success' : 'warning',
      title: `Critic review: iteration ${event.iteration}`,
      message: event.passed
        ? 'Iteration passed critic review'
        : `Critic flagged issues: ${event.feedback}`,
      timestamp: event.timestamp,
      source: 'critic',
      read: false,
    });
  }

  private handleVerifierCheck(event: VerifierCheckEvent): void {
    const iterSummary = this.state.iterations.find(
      s => s.number === event.iteration,
    );
    if (iterSummary) {
      iterSummary.verifierPassed = event.passed;
    }

    this.addNotification({
      id: this.generateNotificationId(),
      severity: event.passed ? 'success' : 'warning',
      title: `Verifier check: iteration ${event.iteration}`,
      message: event.passed
        ? 'Iteration passed verification'
        : `Verification issues: ${event.result}`,
      timestamp: event.timestamp,
      source: 'verifier',
      read: false,
    });
  }

  private handleAlert(event: AlertEvent): void {
    this.addNotification({
      id: this.generateNotificationId(),
      severity: event.severity === 'warn' || event.severity === 'error' || event.severity === 'fatal'
        ? (event.severity === 'warn' ? 'warning' : 'error')
        : 'info',
      title: 'System alert',
      message: event.message,
      timestamp: event.timestamp,
      source: event.source,
      read: false,
    });
  }

  private handleError(event: ErrorEvent): void {
    this.addNotification({
      id: this.generateNotificationId(),
      severity: 'error',
      title: event.fatal ? 'Fatal error' : 'System error',
      message: event.error,
      timestamp: event.timestamp,
      source: event.source,
      read: false,
    });
  }

  // ─── Internal: Recent Events Feed ───

  private pushRecentEvent(event: ForgeEvent): void {
    const dashboardEvent: DashboardEvent = {
      type: event.type,
      message: event.message,
      timestamp: event.timestamp,
      severity: eventSeverity(event),
    };

    this.state.recentEvents.push(dashboardEvent);

    // FIFO cap
    while (this.state.recentEvents.length > this.config.maxRecentEvents) {
      this.state.recentEvents.shift();
    }
  }

  // ─── Internal: Listener Notification ───

  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        // Listener errors must not break dashboard
      }
    }
  }
}
