/**
 * DeepForge 2.0 — ProgressMiddleware
 *
 * Tracks execution progress across phases and iterations:
 * - Updates progress state before/after each iteration
 * - Computes completion percentage, elapsed time, and remaining estimate
 * - Maintains per-phase tracking (start time, iteration count, status)
 * - Emits structured progress events via ForgeEventBus
 * - Exposes Dashboard-consumable progress data via ctx.state
 *
 * Priority: 60 (task/progress tracking layer, per middleware.ts conventions)
 *
 * @module forge-progress
 */

import type {
  MiddlewareContext,
  MiddlewareNext,
  Middleware,
  ForgePhase,
} from './types/middleware';

import type {
  ForgeEvent,
  DashboardUpdateEvent,
  ForgeEventHandler,
} from './types/event';

// ─── Phase Tracking Types ───
// PhaseTrackingEntry is the internal per-phase state used by ProgressMiddleware.
// This is distinct from dashboard.ts PhaseProgress which is a simplified UI view.

/** Internal per-phase tracking entry for ProgressMiddleware. */
export interface PhaseTrackingEntry {
  /** Phase identifier */
  phase: ForgePhase;
  /** Phase status */
  status: 'pending' | 'active' | 'completed' | 'skipped';
  /** ISO-8601 start time (undefined if pending) */
  startedAt?: string;
  /** ISO-8601 completion time (undefined if still running) */
  completedAt?: string;
  /** Number of iterations completed in this phase */
  iterationCount: number;
  /** Wall-clock duration in ms (computed on read if still active) */
  durationMs: number;
}

/** Overall progress snapshot consumed by Dashboard. */
export interface ProgressSnapshot {
  /** Current phase */
  currentPhase: ForgePhase;
  /** Overall completion percentage (0–100) */
  completionPercent: number;
  /** Total elapsed time in ms since the run started */
  elapsedMs: number;
  /** Estimated remaining time in ms (0 if unknown) */
  estimatedRemainingMs: number;
  /** Current iteration number (1-based, 0 if not started) */
  currentIteration: number;
  /** Total planned iterations (0 if unknown) */
  totalIterations: number;
  /** Per-phase progress entries */
  phases: PhaseTrackingEntry[];
  /** ISO-8601 timestamp of this snapshot */
  timestamp: string;
}

// ─── Event Emitter Interface ───

/**
 * Minimal event emitter interface — decoupled from ForgeEventBus
 * to avoid circular dependencies. Compatible with ForgeEventBus.emit().
 */
export interface ProgressEventEmitter {
  emit(event: ForgeEvent): void | Promise<void>;
}

// ─── Configuration ───

export interface ProgressMiddlewareConfig {
  /** Total expected iterations (used for percentage calculation). 0 = unknown. */
  totalIterations: number;
  /** Ordered list of phases in the pipeline (for completion calculation). */
  phaseOrder: ForgePhase[];
  /** Whether to emit dashboard_update events. Default: true. */
  emitEvents: boolean;
  /** Namespace key prefix in ctx.state. Default: 'progress'. */
  stateKey: string;
}

const DEFAULT_CONFIG: ProgressMiddlewareConfig = {
  totalIterations: 0,
  phaseOrder: [
    'setup',
    'planning',
    'executing',
    'critiquing',
    'verifying',
    'iterating',
    'completing',
  ],
  emitEvents: true,
  stateKey: 'progress',
};

// ─── Phase Weight Map ───
// Weights determine how much each phase contributes to overall progress.
// Executing is heaviest; setup/completing are lightest.

const DEFAULT_PHASE_WEIGHTS: Record<string, number> = {
  setup: 5,
  planning: 10,
  executing: 40,
  critiquing: 15,
  verifying: 15,
  iterating: 10,
  completing: 5,
};

// ─── Internal Helpers ───

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedSince(isoTimestamp: string): number {
  return Date.now() - new Date(isoTimestamp).getTime();
}

// ─── ProgressMiddleware ───

/**
 * Middleware that tracks execution progress and exposes structured
 * progress data for Dashboard consumption.
 *
 * Usage:
 * ```ts
 * const progress = new ProgressMiddleware(eventBus, { totalIterations: 3 });
 * pipeline.use(progress.execute.bind(progress), {
 *   name: progress.name,
 *   priority: progress.priority,
 * });
 * ```
 *
 * State keys written to ctx.state:
 * - `progress:snapshot` — latest ProgressSnapshot
 * - `progress:phases`   — PhaseTrackingEntry[] array
 */
export class ProgressMiddleware implements Middleware {
  readonly name = 'progress';
  readonly priority = 60;
  readonly enabled = true;
  readonly continueOnError = true; // progress tracking should never abort the pipeline

  private readonly config: ProgressMiddlewareConfig;
  private readonly eventEmitter: ProgressEventEmitter | null;

  /** Tracks per-phase state across the entire run */
  private phaseMap: Map<ForgePhase, PhaseTrackingEntry> = new Map();
  /** ISO timestamp when the first execute() call happened */
  private runStartedAt: string | null = null;
  /** Current iteration counter (1-based) */
  private currentIteration = 0;
  /** Tracks the last known phase to detect transitions */
  private lastPhase: ForgePhase | null = null;
  /** Average ms per iteration (computed from history for remaining-time estimate) */
  private iterationDurations: number[] = [];
  /** Start time of the current iteration */
  private iterationStartTime: number | null = null;

  constructor(
    eventEmitter?: ProgressEventEmitter | null,
    config?: Partial<ProgressMiddlewareConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventEmitter = eventEmitter ?? null;

    // Initialize phase entries
    for (const phase of this.config.phaseOrder) {
      this.phaseMap.set(phase, {
        phase,
        status: 'pending',
        iterationCount: 0,
        durationMs: 0,
      });
    }
  }

  /**
   * Middleware execute handler — Koa-style onion model.
   *
   * Before next(): record iteration start, detect phase transitions.
   * After next(): update progress, compute estimates, emit events.
   */
  async execute(ctx: MiddlewareContext, next: MiddlewareNext): Promise<MiddlewareContext> {
    // ── Pre-processing ──
    if (!this.runStartedAt) {
      this.runStartedAt = nowIso();
    }

    const currentPhase = ctx.config.phase as ForgePhase;
    this.handlePhaseTransition(currentPhase);
    this.handleIterationStart(ctx);

    // ── Delegate to downstream middleware ──
    const result = await next();

    // ── Post-processing ──
    this.handleIterationEnd(ctx);
    const snapshot = this.buildSnapshot(ctx);

    // Write structured data to ctx.state for Dashboard consumption
    const stateKey = this.config.stateKey;
    result.state[`${stateKey}:snapshot`] = snapshot;
    result.state[`${stateKey}:phases`] = [...this.phaseMap.values()];

    // Emit dashboard_update event
    if (this.config.emitEvents) {
      this.emitProgressEvent(snapshot);
    }

    return result;
  }

  // ─── Phase Transition Detection ───

  private handlePhaseTransition(currentPhase: ForgePhase): void {
    if (this.lastPhase === currentPhase) return;

    // Complete the previous phase
    if (this.lastPhase) {
      const prevEntry = this.phaseMap.get(this.lastPhase);
      if (prevEntry && prevEntry.status === 'active') {
        prevEntry.status = 'completed';
        prevEntry.completedAt = nowIso();
        if (prevEntry.startedAt) {
          prevEntry.durationMs = elapsedSince(prevEntry.startedAt);
        }
      }
    }

    // Activate the new phase
    const entry = this.phaseMap.get(currentPhase);
    if (entry) {
      entry.status = 'active';
      if (!entry.startedAt) {
        entry.startedAt = nowIso();
      }
    } else {
      // Phase not in phaseOrder — add it dynamically
      this.phaseMap.set(currentPhase, {
        phase: currentPhase,
        status: 'active',
        startedAt: nowIso(),
        iterationCount: 0,
        durationMs: 0,
      });
    }

    this.lastPhase = currentPhase;
  }

  // ─── Iteration Tracking ───

  private handleIterationStart(ctx: MiddlewareContext): void {
    const iterInfo = (ctx as { iteration?: { number: number } }).iteration;
    if (iterInfo) {
      const iterNum = iterInfo.number;
      if (iterNum > this.currentIteration) {
        // New iteration detected
        this.currentIteration = iterNum;
        this.iterationStartTime = Date.now();

        // Increment iteration count for the active phase
        const currentPhase = ctx.config.phase as ForgePhase;
        const entry = this.phaseMap.get(currentPhase);
        if (entry) {
          entry.iterationCount++;
        }
      }
    }
  }

  private handleIterationEnd(ctx: MiddlewareContext): void {
    if (this.iterationStartTime !== null) {
      const duration = Date.now() - this.iterationStartTime;
      if (duration > 0) {
        this.iterationDurations.push(duration);
      }
    }
  }

  // ─── Snapshot Builder ───

  private buildSnapshot(ctx: MiddlewareContext): ProgressSnapshot {
    const currentPhase = ctx.config.phase as ForgePhase;
    const elapsedMs = this.runStartedAt ? elapsedSince(this.runStartedAt) : 0;

    // Update active phase duration
    for (const entry of this.phaseMap.values()) {
      if (entry.status === 'active' && entry.startedAt) {
        entry.durationMs = elapsedSince(entry.startedAt);
      }
    }

    const completionPercent = this.computeCompletionPercent(currentPhase);
    const estimatedRemainingMs = this.estimateRemaining(completionPercent, elapsedMs);
    const totalIterations = this.config.totalIterations;

    return {
      currentPhase,
      completionPercent,
      elapsedMs,
      estimatedRemainingMs,
      currentIteration: this.currentIteration,
      totalIterations,
      phases: [...this.phaseMap.values()],
      timestamp: nowIso(),
    };
  }

  /**
   * Compute overall completion percentage using phase weights.
   *
   * Completed phases contribute their full weight.
   * The active phase contributes a fraction of its weight based on
   * iteration progress (if totalIterations is known) or 50% as fallback.
   */
  private computeCompletionPercent(currentPhase: ForgePhase): number {
    const order = this.config.phaseOrder;
    let totalWeight = 0;
    let completedWeight = 0;

    for (const phase of order) {
      const weight = DEFAULT_PHASE_WEIGHTS[phase] ?? 10;
      totalWeight += weight;

      const entry = this.phaseMap.get(phase);
      if (!entry) continue;

      if (entry.status === 'completed') {
        completedWeight += weight;
      } else if (entry.status === 'active' && phase === currentPhase) {
        // Partial credit for active phase
        if (this.config.totalIterations > 0) {
          const iterFraction = Math.min(
            this.currentIteration / this.config.totalIterations,
            1,
          );
          completedWeight += weight * iterFraction;
        } else {
          // Unknown total — give 50% credit for being active
          completedWeight += weight * 0.5;
        }
      }
    }

    if (totalWeight === 0) return 0;
    return Math.round((completedWeight / totalWeight) * 100);
  }

  /**
   * Estimate remaining time based on average pace.
   *
   * Uses simple linear extrapolation: if we're X% done in Y ms,
   * remaining = Y * ((100 - X) / X).
   */
  private estimateRemaining(completionPercent: number, elapsedMs: number): number {
    if (completionPercent <= 0 || completionPercent >= 100) return 0;
    if (elapsedMs <= 0) return 0;

    const remaining = elapsedMs * ((100 - completionPercent) / completionPercent);
    return Math.round(remaining);
  }

  // ─── Event Emission ───

  private emitProgressEvent(snapshot: ProgressSnapshot): void {
    if (!this.eventEmitter) return;

    const event: DashboardUpdateEvent = {
      type: 'dashboard_update',
      timestamp: snapshot.timestamp,
      message: `Progress: ${snapshot.completionPercent}% — phase=${snapshot.currentPhase}, iteration=${snapshot.currentIteration}`,
      source: 'ProgressMiddleware',
      metrics: {
        completionPercent: snapshot.completionPercent,
        elapsedMs: snapshot.elapsedMs,
        estimatedRemainingMs: snapshot.estimatedRemainingMs,
        currentIteration: snapshot.currentIteration,
        totalIterations: snapshot.totalIterations,
        phaseCount: snapshot.phases.length,
        completedPhases: snapshot.phases.filter(p => p.status === 'completed').length,
      },
    };

    try {
      void this.eventEmitter.emit(event);
    } catch {
      // Event emission must never break the pipeline
    }
  }

  // ─── Public API ───

  /** Get the current progress snapshot (without running the middleware). */
  getSnapshot(): ProgressSnapshot | null {
    if (!this.runStartedAt) return null;

    const currentPhase = this.lastPhase ?? 'setup';
    const elapsedMs = elapsedSince(this.runStartedAt);
    const completionPercent = this.computeCompletionPercent(currentPhase);
    const estimatedRemainingMs = this.estimateRemaining(completionPercent, elapsedMs);

    return {
      currentPhase,
      completionPercent,
      elapsedMs,
      estimatedRemainingMs,
      currentIteration: this.currentIteration,
      totalIterations: this.config.totalIterations,
      phases: [...this.phaseMap.values()],
      timestamp: nowIso(),
    };
  }

  /** Reset all progress state. */
  reset(): void {
    this.runStartedAt = null;
    this.currentIteration = 0;
    this.lastPhase = null;
    this.iterationDurations = [];
    this.iterationStartTime = null;
    this.phaseMap.clear();

    for (const phase of this.config.phaseOrder) {
      this.phaseMap.set(phase, {
        phase,
        status: 'pending',
        iterationCount: 0,
        durationMs: 0,
      });
    }
  }

  /** Update the total expected iterations (can be refined at runtime). */
  setTotalIterations(total: number): void {
    this.config.totalIterations = total;
  }
}
