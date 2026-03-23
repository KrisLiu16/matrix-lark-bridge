/**
 * DeepForge 2.0 — ForgeEngine Full-Flow E2E Tests
 *
 * These tests drive the engine through engine.run() — the complete public API.
 * No private method access, no `as any` casts on engine internals.
 *
 * OOM prevention: fs mocks use plain functions (not vi.fn()) so vitest does
 * not retain the full JSON state from every persist() call.
 *
 * Middleware blocking is tested by mocking the middleware module classes
 * at the module level with phase-conditional throwing.
 *
 * @module __tests__/forge-engine-e2e
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ─── Mutable flags for per-test middleware behavior ──────────────────────────

let qualityGateBlockPhase: string | null = null;
let loopDetectionBlockPhase: string | null = null;

// ─── Mock node:fs with plain functions (no vi.fn → no arg retention → no OOM) ─

vi.mock('node:fs', () => ({
  appendFileSync: () => {},
  mkdirSync: () => {},
  existsSync: () => false,
  writeFileSync: () => {},
  readFileSync: () => { throw new Error('ENOENT'); },
  renameSync: () => {},
  statSync: () => ({ mtimeMs: Date.now() }),
  readdirSync: () => [],
  unlinkSync: () => {},
  copyFileSync: () => {},
  watchFile: () => {},
  unwatchFile: () => {},
}));

vi.mock('node:path', () => ({
  dirname: (p: string) => p.split('/').slice(0, -1).join('/') || '.',
  join: (...args: string[]) => args.join('/'),
  basename: (p: string) => p.split('/').pop() ?? p,
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid-0000-0000-000000000000',
}));

vi.mock('../forge-runner.js', () => ({
  forgeRun: vi.fn(async () => ({
    success: true,
    output: '```json\n{"tasks": []}\n```',
    costUsd: 0.01,
    durationMs: 100,
    error: undefined,
  })),
}));

// ─── Mock middleware modules with phase-conditional blocking ──────────────────

vi.mock('../forge-quality-gate.js', () => ({
  QualityGateMiddleware: class {
    readonly name = 'quality-gate';
    readonly priority = 110;
    readonly enabled = true;
    readonly continueOnError = false;
    readonly timeout = 60_000;

    async execute(ctx: Record<string, any>, next: () => Promise<any>): Promise<any> {
      if (qualityGateBlockPhase && ctx.config?.phase === qualityGateBlockPhase) {
        throw new Error('quality-gate-blocked');
      }
      return next();
    }
  },
}));

vi.mock('../forge-loop-detection.js', () => ({
  LoopDetectionMiddleware: class {
    readonly name = 'loop-detection';
    readonly priority = 115;
    readonly enabled = true;
    readonly continueOnError = false;

    async execute(ctx: Record<string, any>, next: () => Promise<any>): Promise<any> {
      if (loopDetectionBlockPhase && ctx.config?.phase === loopDetectionBlockPhase) {
        throw new Error('loop-detected');
      }
      return next();
    }
  },
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { ForgeEngine } from '../forge-engine';
import { ForgeEventBus } from '../forge-events';
import type { ForgeProject } from '../types';
import { forgeRun } from '../forge-runner.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestProject(overrides?: Partial<ForgeProject>): ForgeProject {
  return {
    id: 'test-project',
    title: 'Test Project',
    description: 'E2E test project',
    roles: [
      {
        name: 'coder',
        label: '编码员',
        description: 'Writes code',
        systemPrompt: 'You are a coder.',
      },
    ],
    model: 'claude-sonnet-4-20250514',
    effort: 'medium',
    maxConcurrent: 3,
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    chatId: 'test-chat',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ForgeEngine Full-Flow E2E via engine.run()', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let emitSpy: any;

  beforeEach(() => {
    qualityGateBlockPhase = null;
    loopDetectionBlockPhase = null;
    // Spy on ForgeEventBus.prototype.emit to capture events without accessing private engine internals
    emitSpy = vi.spyOn(ForgeEventBus.prototype, 'emit');
  });

  afterEach(() => {
    vi.clearAllMocks();
    emitSpy?.mockRestore();
  });

  /**
   * Test 1: quality-gate blocking skips worker execution
   *
   * Flow via engine.run():
   *   setup → plan (leader creates coder tasks) → execute (quality-gate blocks → iterating)
   *   → iterate (leader runs, engine.stop() called) → run() exits
   *
   * Verifies:
   * 1. Leader plan runs and creates tasks
   * 2. Quality-gate middleware blocks during executing phase
   * 3. Worker forgeRun is NOT called (only leader calls)
   * 4. Coder tasks remain pending
   */
  it('should skip worker execution when quality-gate blocks during executing phase', async () => {
    qualityGateBlockPhase = 'executing';

    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const forgeRunCalls: Array<{ roleName?: string }> = [];

    const project = createTestProject();
    let engine: ForgeEngine;

    mockForgeRun.mockImplementation(async (opts: Record<string, any>) => {
      forgeRunCalls.push({ roleName: opts.roleName });

      if (opts.roleName === 'leader') {
        // First leader call = plan; second leader call = iterate
        const isIterate = forgeRunCalls.filter(c => c.roleName === 'leader').length > 1;
        if (isIterate) {
          // Stop engine after iterate completes
          engine.stop();
          return { success: true, output: 'Iteration summary', costUsd: 0.01, durationMs: 50 };
        }
        // Plan: create 2 coder tasks
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "write code"}, {"id": "coder-2", "role": "coder", "description": "write tests"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    engine = new ForgeEngine(project, { log: () => {} });
    await engine.run();

    // Worker forgeRun should NOT have been called — only leader calls
    const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
    expect(workerCalls.length).toBe(0);

    // Leader was called twice (plan + iterate)
    const leaderCalls = forgeRunCalls.filter(c => c.roleName === 'leader');
    expect(leaderCalls.length).toBe(2);

    // Coder tasks remain pending (not executed due to blocking)
    const coderTasks = engine.currentState.iterations[0].tasks.filter(
      (t) => t.role === 'coder',
    );
    expect(coderTasks.length).toBe(2);
    for (const t of coderTasks) {
      expect(t.status).toBe('pending');
    }
  });

  /**
   * Test 2: loop-detection blocking marks verifier as failed
   *
   * Flow via engine.run():
   *   setup → plan → execute (coder runs) → critic → verify
   *   (verifier says "pass" but loop-detection blocks → verifierPassed=false)
   *   → iterate (engine.stop()) → run() exits
   *
   * Verifies:
   * 1. Full flow runs through execute and critic
   * 2. Loop-detection middleware blocks during verifying phase
   * 3. verifierPassed is overridden to false despite verifier saying "pass"
   */
  it('should mark verifierPassed=false when loop-detection blocks during verifying', async () => {
    loopDetectionBlockPhase = 'verifying';

    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const project = createTestProject();
    let engine: ForgeEngine;
    let iterateLeaderCallCount = 0;

    mockForgeRun.mockImplementation(async (opts: Record<string, any>) => {
      if (opts.roleName === 'leader') {
        if (opts.taskId?.startsWith('leader-iterate')) {
          iterateLeaderCallCount++;
          engine.stop();
          return { success: true, output: 'Iteration summary', costUsd: 0.01, durationMs: 50 };
        }
        // Plan: create 1 coder task
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "write code"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      if (opts.roleName === 'coder') {
        return { success: true, output: 'Code written successfully', costUsd: 0.02, durationMs: 100 };
      }
      if (opts.roleName === 'critic') {
        return { success: true, output: 'No issues found', costUsd: 0.01, durationMs: 50 };
      }
      if (opts.roleName === 'verifier') {
        // Verifier output says PASS — but loop-detection will override
        return { success: true, output: '✅ All checks pass, no issues', costUsd: 0.01, durationMs: 50 };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    engine = new ForgeEngine(project, { log: () => {} });
    await engine.run();

    // Verifier content was "All checks pass" BUT loop-detection blocked
    // → verifierPassed must be false
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    expect(iter.verifierPassed).toBe(false);
    expect(iterateLeaderCallCount).toBe(1);
  });

  /**
   * Test 3: blocking middleware error during verify emits middleware_error and fails verifier
   *
   * Flow via engine.run():
   *   setup → plan → execute → critic → verify
   *   (quality-gate blocks during verifying → pipeline emits middleware_error → verifierPassed=false)
   *   → iterate (engine.stop()) → run() exits
   *
   * Verifies:
   * 1. verifierPassed is false
   * 2. middleware_error event was emitted (captured via ForgeEventBus.prototype.emit spy)
   */
  it('should emit middleware_error and mark verifierPassed=false when middleware blocks during verify', async () => {
    qualityGateBlockPhase = 'verifying';

    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const project = createTestProject();
    let engine: ForgeEngine;

    mockForgeRun.mockImplementation(async (opts: Record<string, any>) => {
      if (opts.roleName === 'leader') {
        if (opts.taskId?.startsWith('leader-iterate')) {
          engine.stop();
          return { success: true, output: 'Iteration summary', costUsd: 0.01, durationMs: 50 };
        }
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "write code"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      if (opts.roleName === 'coder') {
        return { success: true, output: 'Code written', costUsd: 0.02, durationMs: 100 };
      }
      if (opts.roleName === 'critic') {
        return { success: true, output: 'No issues', costUsd: 0.01, durationMs: 50 };
      }
      if (opts.roleName === 'verifier') {
        return { success: true, output: '✅ All good', costUsd: 0.01, durationMs: 50 };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    engine = new ForgeEngine(project, { log: () => {} });
    await engine.run();

    // middleware_error event should have been emitted by the pipeline
    // emitSpy.mock.calls is Array<[event, ...rest]>
    const middlewareErrorCalls = (emitSpy.mock.calls as Array<[Record<string, unknown>]>).filter(
      (call) => call[0]?.type === 'middleware_error',
    );
    expect(middlewareErrorCalls.length).toBeGreaterThan(0);

    // At least one should mention quality-gate
    const qualityGateErrors = middlewareErrorCalls.filter(
      (call) => {
        const msg = String(call[0]?.message ?? '') + String(call[0]?.middlewareName ?? '');
        return msg.includes('quality-gate') || msg.includes('quality_gate');
      },
    );
    expect(qualityGateErrors.length).toBeGreaterThan(0);

    // verifierPassed should be false
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    expect(iter.verifierPassed).toBe(false);
  });

  /**
   * Test 4: Happy-path — all middleware passes, worker executes, verifier passes
   *
   * Flow via engine.run():
   *   setup → plan (leader creates 1 coder task) → execute (middleware passes, coder runs)
   *   → critic → verify (verifier says pass, no blocking) → iterate (engine.stop())
   *
   * Verifies:
   * 1. Coder task is executed (forgeRun called with roleName=coder)
   * 2. verifierPassed is true
   * 3. criticCleared is true
   * 4. All expected roles are called in order
   */
  it('should complete successfully when all middleware passes and verifier approves', async () => {
    // No blocking flags set — both middleware will call next() cleanly

    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const project = createTestProject();
    let engine: ForgeEngine;
    const calledRoles: string[] = [];

    mockForgeRun.mockImplementation(async (opts: Record<string, any>) => {
      calledRoles.push(opts.roleName);

      if (opts.roleName === 'leader') {
        if (opts.taskId?.startsWith('leader-iterate')) {
          engine.stop();
          return { success: true, output: 'All tasks completed successfully', costUsd: 0.01, durationMs: 50 };
        }
        // Plan: create 1 coder task
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "implement feature"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      if (opts.roleName === 'coder') {
        return { success: true, output: 'Feature implemented', costUsd: 0.02, durationMs: 100 };
      }
      if (opts.roleName === 'critic') {
        return { success: true, output: 'Code looks good, no issues', costUsd: 0.01, durationMs: 50 };
      }
      if (opts.roleName === 'verifier') {
        return { success: true, output: '✅ PASS: All checks passed, quality is good', costUsd: 0.01, durationMs: 50 };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    engine = new ForgeEngine(project, { log: () => {} });
    await engine.run();

    // Coder was called (worker executed)
    expect(calledRoles).toContain('coder');

    // Verifier was called
    expect(calledRoles).toContain('verifier');

    // Critic was called
    expect(calledRoles).toContain('critic');

    // verifierPassed should be true (no blocking middleware, verifier said PASS)
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    expect(iter.verifierPassed).toBe(true);

    // criticCleared should be true (no critical issues)
    expect(iter.criticCleared).toBe(true);

    // Coder task should be completed
    const coderTasks = iter.tasks.filter((t) => t.role === 'coder');
    expect(coderTasks.length).toBe(1);
    expect(coderTasks[0].status).toBe('completed');

    // All roles called: leader(plan), coder, critic, verifier, leader(iterate)
    expect(calledRoles.filter(r => r === 'leader').length).toBe(2);
  });

  /**
   * Test 5: Happy-path with multiple workers — concurrent execution
   *
   * Flow via engine.run():
   *   setup → plan (leader creates 2 coder tasks) → execute (both coders run)
   *   → critic → verify (pass) → iterate (engine.stop())
   *
   * Verifies:
   * 1. Both coder tasks are executed
   * 2. All tasks reach 'completed' status
   * 3. Engine terminates cleanly via engine.stop()
   */
  it('should execute multiple worker tasks concurrently and complete', async () => {
    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const project = createTestProject({ maxConcurrent: 3 });
    let engine: ForgeEngine;
    const coderCallIds: string[] = [];

    mockForgeRun.mockImplementation(async (opts: Record<string, any>) => {
      if (opts.roleName === 'leader') {
        if (opts.taskId?.startsWith('leader-iterate')) {
          engine.stop();
          return { success: true, output: 'Iteration complete', costUsd: 0.01, durationMs: 50 };
        }
        // Plan: create 2 coder tasks
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-a", "role": "coder", "description": "build UI"}, {"id": "coder-b", "role": "coder", "description": "build API"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      if (opts.roleName === 'coder') {
        coderCallIds.push(opts.taskId);
        return { success: true, output: `Task ${opts.taskId} done`, costUsd: 0.02, durationMs: 100 };
      }
      if (opts.roleName === 'critic') {
        return { success: true, output: 'Looks good', costUsd: 0.01, durationMs: 50 };
      }
      if (opts.roleName === 'verifier') {
        return { success: true, output: '✅ PASS: Everything verified', costUsd: 0.01, durationMs: 50 };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    engine = new ForgeEngine(project, { log: () => {} });
    await engine.run();

    // Both coder tasks were executed
    expect(coderCallIds.length).toBe(2);

    // All coder tasks should be completed
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    const coderTasks = iter.tasks.filter((t) => t.role === 'coder');
    expect(coderTasks.length).toBe(2);
    for (const t of coderTasks) {
      expect(t.status).toBe('completed');
    }

    // Verifier passed
    expect(iter.verifierPassed).toBe(true);
  });
});
