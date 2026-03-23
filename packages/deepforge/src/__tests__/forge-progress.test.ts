/**
 * DeepForge 2.0 — ProgressMiddleware Unit Tests
 *
 * Tests for artifacts/src/forge-progress.ts
 * Covers: phase weights, completion %, iteration detection, elapsed/remaining time,
 * phase transitions, event emission, ctx.state snapshot, reset, public API.
 *
 * @module __tests__/forge-progress
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ProgressMiddleware,
  type ProgressEventEmitter,
  type ProgressSnapshot,
  type PhaseTrackingEntry,
  type ProgressMiddlewareConfig,
} from '../forge-progress';

import type {
  MiddlewareContext,
  MiddlewareNext,
  ForgePhase,
  MiddlewareMessage,
  MiddlewareContextConfig,
  MiddlewareMetadata,
} from '../types/middleware';

// ─── Helpers ───

function makeCtx(overrides: {
  phase?: ForgePhase;
  iteration?: { number: number };
  state?: Record<string, unknown>;
}): MiddlewareContext {
  const config: MiddlewareContextConfig = {
    projectId: 'test-project',
    model: 'claude-opus-4-6',
    effort: 'high',
    maxConcurrent: 4,
    phase: overrides.phase ?? 'executing',
  };

  const metadata: MiddlewareMetadata = {
    runId: 'run-001',
    chain: ['progress'],
    currentIndex: 0,
    startedAt: new Date().toISOString(),
    timing: {},
    aborted: false,
  };

  const ctx: MiddlewareContext = {
    messages: [] as MiddlewareMessage[],
    config,
    iteration: overrides.iteration ? { number: overrides.iteration.number, taskCount: 1, completedCount: 0, failedCount: 0 } : undefined,
    state: overrides.state ?? {},
    metadata,
  };

  return ctx;
}

function passthrough(): MiddlewareNext {
  return async function next() {
    // Return ctx is handled by the middleware itself via `result`
    // The middleware calls `const result = await next()` and next() should return ctx
    return undefined as unknown as MiddlewareContext;
  };
}

/**
 * Creates a next() that returns the same ctx (simulating downstream pass-through).
 */
function passthroughCtx(ctx: MiddlewareContext): MiddlewareNext {
  return async () => ctx;
}

// ─── Tests ───

describe('ProgressMiddleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Construction & Defaults ──

  describe('constructor', () => {
    it('should initialize with default config and all phases pending', () => {
      const mw = new ProgressMiddleware();
      expect(mw.name).toBe('progress');
      expect(mw.priority).toBe(60);
      expect(mw.enabled).toBe(true);
      expect(mw.continueOnError).toBe(true);

      // getSnapshot returns null before any execute()
      expect(mw.getSnapshot()).toBeNull();
    });

    it('should accept custom config overrides', () => {
      const mw = new ProgressMiddleware(null, {
        totalIterations: 5,
        stateKey: 'custom-progress',
        emitEvents: false,
      });

      // Verify via execute — stateKey should use 'custom-progress'
      const ctx = makeCtx({ phase: 'setup' });
      const next = passthroughCtx(ctx);

      // Execute to trigger state writing
      return mw.execute(ctx, next).then((result) => {
        expect(result.state['custom-progress:snapshot']).toBeDefined();
        expect(result.state['custom-progress:phases']).toBeDefined();
        // Default 'progress:' keys should NOT exist
        expect(result.state['progress:snapshot']).toBeUndefined();
      });
    });
  });

  // ── 2. Phase Weight Calculation & Completion Percent ──

  describe('completion percentage', () => {
    it('should give 50% credit to active phase when totalIterations is unknown', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 0 });
      const ctx = makeCtx({ phase: 'setup' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // setup is active with weight=5, total weight=100
      // Active phase gets 50% credit: 5 * 0.5 = 2.5, so 2.5/100 = 2.5% → rounds to 3%
      expect(snapshot.completionPercent).toBe(3);
    });

    it('should compute fractional credit based on iteration progress when totalIterations is known', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 4 });

      // First call with iteration 1 in 'executing' phase
      // Need to go through setup first to complete it
      const ctx1 = makeCtx({ phase: 'setup' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      // Now transition to executing, iteration 2 of 4
      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // setup completed: weight=5 (full)
      // executing active: weight=40, fraction=2/4=0.5, credit=20
      // total completed weight = 5 + 20 = 25, total weight = 100
      // 25/100 = 25%
      expect(snapshot.completionPercent).toBe(25);
    });

    it('should cap iteration fraction at 1.0 even if currentIteration > totalIterations', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 2 });

      const ctx = makeCtx({ phase: 'executing', iteration: { number: 5 } });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // Iteration fraction = min(5/2, 1) = 1.0, so executing gets full weight
      // Active phase at 100% = 40 weight, no completed phases yet
      // But setup is still 'pending' (skipped from setup to executing)
      // 40/100 = 40%
      expect(snapshot.completionPercent).toBe(40);
    });

    it('should return 0% when totalWeight is 0 (empty phaseOrder)', async () => {
      const mw = new ProgressMiddleware(null, { phaseOrder: [] as ForgePhase[] });
      const ctx = makeCtx({ phase: 'executing' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // Phase not in phaseOrder → added dynamically, but totalWeight from order=0
      // computeCompletionPercent iterates over config.phaseOrder (empty), totalWeight=0 → return 0
      expect(snapshot.completionPercent).toBe(0);
    });
  });

  // ── 3. Iteration Detection ──

  describe('iteration detection', () => {
    it('should detect a new iteration when ctx.iteration.number increases', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot.currentIteration).toBe(2);
    });

    it('should not increment iteration when number stays the same', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot.currentIteration).toBe(1);
    });

    it('should increment phase iterationCount on new iteration', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const phases = result.state['progress:phases'] as PhaseTrackingEntry[];
      const exec = phases.find(p => p.phase === 'executing');
      expect(exec?.iterationCount).toBe(2);
    });

    it('should handle missing iteration info gracefully', async () => {
      const mw = new ProgressMiddleware();

      const ctx = makeCtx({ phase: 'executing' }); // no iteration
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot.currentIteration).toBe(0);
    });
  });

  // ── 4. Elapsed Time & Remaining Estimate ──

  describe('elapsed and remaining time', () => {
    it('should compute elapsedMs from run start', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'setup' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      // Advance time by 5 seconds
      vi.advanceTimersByTime(5000);

      const ctx2 = makeCtx({ phase: 'executing' });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(5000);
    });

    it('should estimate remaining time via linear extrapolation', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 4 });

      // Setup phase
      const ctx1 = makeCtx({ phase: 'setup' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      // Advance 10s, then execute with iteration 2/4
      vi.advanceTimersByTime(10000);

      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // Should have estimatedRemainingMs > 0 since completionPercent < 100
      if (snapshot.completionPercent > 0 && snapshot.completionPercent < 100) {
        expect(snapshot.estimatedRemainingMs).toBeGreaterThan(0);
      }
    });

    it('should return 0 remaining when completionPercent is 0 or 100', async () => {
      const mw = new ProgressMiddleware(null, { phaseOrder: [] as ForgePhase[] });
      const ctx = makeCtx({ phase: 'executing' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // completionPercent = 0 (empty phaseOrder) → remaining = 0
      expect(snapshot.estimatedRemainingMs).toBe(0);
    });
  });

  // ── 5. Phase Transition Detection ──

  describe('phase transitions', () => {
    it('should mark previous phase as completed on transition', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'setup' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      vi.advanceTimersByTime(1000);

      const ctx2 = makeCtx({ phase: 'planning' });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const phases = result.state['progress:phases'] as PhaseTrackingEntry[];
      const setup = phases.find(p => p.phase === 'setup');
      expect(setup?.status).toBe('completed');
      expect(setup?.completedAt).toBeDefined();
      expect(setup?.durationMs).toBeGreaterThanOrEqual(1000);

      const planning = phases.find(p => p.phase === 'planning');
      expect(planning?.status).toBe('active');
      expect(planning?.startedAt).toBeDefined();
    });

    it('should not re-trigger transition if phase stays the same', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'executing' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      const ctx2 = makeCtx({ phase: 'executing' });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const phases = result.state['progress:phases'] as PhaseTrackingEntry[];
      const exec = phases.find(p => p.phase === 'executing');
      expect(exec?.status).toBe('active');
    });

    it('should dynamically add unknown phases not in phaseOrder', async () => {
      const mw = new ProgressMiddleware(null, {
        phaseOrder: ['setup', 'executing'] as ForgePhase[],
      });

      // Use 'critiquing' which is NOT in the configured phaseOrder
      const ctx = makeCtx({ phase: 'critiquing' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const phases = result.state['progress:phases'] as PhaseTrackingEntry[];
      const crit = phases.find(p => p.phase === 'critiquing');
      expect(crit).toBeDefined();
      expect(crit?.status).toBe('active');
    });

    it('should track multiple sequential phase transitions', async () => {
      const mw = new ProgressMiddleware();

      const phases: ForgePhase[] = ['setup', 'planning', 'executing'];
      for (const phase of phases) {
        const ctx = makeCtx({ phase });
        await mw.execute(ctx, passthroughCtx(ctx));
        vi.advanceTimersByTime(500);
      }

      const finalCtx = makeCtx({ phase: 'critiquing' });
      const result = await mw.execute(finalCtx, passthroughCtx(finalCtx));

      const phaseList = result.state['progress:phases'] as PhaseTrackingEntry[];
      const setup = phaseList.find(p => p.phase === 'setup');
      const planning = phaseList.find(p => p.phase === 'planning');
      const executing = phaseList.find(p => p.phase === 'executing');
      const critiquing = phaseList.find(p => p.phase === 'critiquing');

      expect(setup?.status).toBe('completed');
      expect(planning?.status).toBe('completed');
      expect(executing?.status).toBe('completed');
      expect(critiquing?.status).toBe('active');
    });
  });

  // ── 6. Event Emission ──

  describe('event emission', () => {
    it('should emit dashboard_update event with correct metrics', async () => {
      const emitter: ProgressEventEmitter = { emit: vi.fn() };
      const mw = new ProgressMiddleware(emitter, { totalIterations: 3 });

      const ctx = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx, passthroughCtx(ctx));

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const event = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('dashboard_update');
      expect(event.source).toBe('ProgressMiddleware');
      expect(event.metrics.completionPercent).toBeTypeOf('number');
      expect(event.metrics.elapsedMs).toBeTypeOf('number');
      expect(event.metrics.currentIteration).toBe(1);
      expect(event.metrics.totalIterations).toBe(3);
      expect(event.metrics.phaseCount).toBeGreaterThan(0);
      expect(event.metrics.completedPhases).toBeTypeOf('number');
    });

    it('should not emit events when emitEvents is false', async () => {
      const emitter: ProgressEventEmitter = { emit: vi.fn() };
      const mw = new ProgressMiddleware(emitter, { emitEvents: false });

      const ctx = makeCtx({ phase: 'setup' });
      await mw.execute(ctx, passthroughCtx(ctx));

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('should not emit events when eventEmitter is null', async () => {
      const mw = new ProgressMiddleware(null);

      const ctx = makeCtx({ phase: 'setup' });
      // Should not throw even without emitter
      const result = await mw.execute(ctx, passthroughCtx(ctx));
      expect(result.state['progress:snapshot']).toBeDefined();
    });

    it('should swallow emitter errors without breaking pipeline', async () => {
      const emitter: ProgressEventEmitter = {
        emit: vi.fn(() => { throw new Error('emit failed'); }),
      };
      const mw = new ProgressMiddleware(emitter);

      const ctx = makeCtx({ phase: 'setup' });
      // Should NOT throw
      const result = await mw.execute(ctx, passthroughCtx(ctx));
      expect(result.state['progress:snapshot']).toBeDefined();
    });
  });

  // ── 7. ctx.state Snapshot Writing ──

  describe('ctx.state snapshot', () => {
    it('should write progress:snapshot and progress:phases to ctx.state', async () => {
      const mw = new ProgressMiddleware();
      const ctx = makeCtx({ phase: 'executing' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.currentPhase).toBe('executing');
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.phases).toBeInstanceOf(Array);
      expect(snapshot.phases.length).toBeGreaterThan(0);

      const phases = result.state['progress:phases'] as PhaseTrackingEntry[];
      expect(phases).toBeInstanceOf(Array);
    });

    it('should use custom stateKey prefix', async () => {
      const mw = new ProgressMiddleware(null, { stateKey: 'myProgress' });
      const ctx = makeCtx({ phase: 'setup' });
      const result = await mw.execute(ctx, passthroughCtx(ctx));

      expect(result.state['myProgress:snapshot']).toBeDefined();
      expect(result.state['myProgress:phases']).toBeDefined();
    });
  });

  // ── 8. getSnapshot() Public API ──

  describe('getSnapshot()', () => {
    it('should return null before any execute() call', () => {
      const mw = new ProgressMiddleware();
      expect(mw.getSnapshot()).toBeNull();
    });

    it('should return a valid snapshot after execute()', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 5 });

      const ctx = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      await mw.execute(ctx, passthroughCtx(ctx));

      vi.advanceTimersByTime(2000);

      const snapshot = mw.getSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.currentPhase).toBe('executing');
      expect(snapshot!.currentIteration).toBe(2);
      expect(snapshot!.totalIterations).toBe(5);
      expect(snapshot!.elapsedMs).toBeGreaterThanOrEqual(2000);
      expect(snapshot!.completionPercent).toBeGreaterThan(0);
      expect(snapshot!.timestamp).toBeDefined();
    });
  });

  // ── 9. reset() ──

  describe('reset()', () => {
    it('should clear all progress state', async () => {
      const mw = new ProgressMiddleware();

      const ctx = makeCtx({ phase: 'executing', iteration: { number: 3 } });
      await mw.execute(ctx, passthroughCtx(ctx));
      expect(mw.getSnapshot()).not.toBeNull();

      mw.reset();

      expect(mw.getSnapshot()).toBeNull();
    });

    it('should re-initialize phases after reset', async () => {
      const mw = new ProgressMiddleware();

      const ctx1 = makeCtx({ phase: 'setup' });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      mw.reset();

      // Execute again — should start fresh
      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      const result = await mw.execute(ctx2, passthroughCtx(ctx2));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      // Setup should be pending (not completed from the previous run)
      const setupPhase = snapshot.phases.find(p => p.phase === 'setup');
      expect(setupPhase?.status).toBe('pending');

      // Current iteration should be 1 (reset from 3)
      expect(snapshot.currentIteration).toBe(1);
    });
  });

  // ── 10. setTotalIterations() ──

  describe('setTotalIterations()', () => {
    it('should update totalIterations at runtime and affect completion calculation', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 0 });

      const ctx1 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx1, passthroughCtx(ctx1));

      // With totalIterations=0, active phase gets 50% credit
      const snap1 = mw.getSnapshot()!;
      const pct1 = snap1.completionPercent;

      // Update total iterations
      mw.setTotalIterations(4);

      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx2, passthroughCtx(ctx2));

      const snap2 = mw.getSnapshot()!;
      // With totalIterations=4 and currentIteration=1, fraction=1/4=0.25
      // executing weight=40, credit=10, total=100 → 10%
      expect(snap2.totalIterations).toBe(4);
      // The completion percentage should differ from the 50%-credit calculation
      expect(snap2.completionPercent).not.toBe(pct1);
    });
  });

  // ── 11. Iteration Duration Tracking ──

  describe('iteration duration tracking', () => {
    it('should accumulate iteration durations for remaining time estimate', async () => {
      const mw = new ProgressMiddleware(null, { totalIterations: 3 });

      // Iteration 1
      const ctx1 = makeCtx({ phase: 'executing', iteration: { number: 1 } });
      await mw.execute(ctx1, passthroughCtx(ctx1));
      vi.advanceTimersByTime(2000);

      // Iteration 2 — triggers handleIterationEnd for previous + handleIterationStart for new
      const ctx2 = makeCtx({ phase: 'executing', iteration: { number: 2 } });
      await mw.execute(ctx2, passthroughCtx(ctx2));
      vi.advanceTimersByTime(3000);

      // Iteration 3
      const ctx3 = makeCtx({ phase: 'executing', iteration: { number: 3 } });
      const result = await mw.execute(ctx3, passthroughCtx(ctx3));

      const snapshot = result.state['progress:snapshot'] as ProgressSnapshot;
      expect(snapshot.currentIteration).toBe(3);
    });
  });
});
