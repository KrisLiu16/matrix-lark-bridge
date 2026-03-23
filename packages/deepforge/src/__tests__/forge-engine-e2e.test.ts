/**
 * DeepForge 2.0 — ForgeEngine Full-Flow Blocking Tests
 *
 * These tests simulate the complete engine control flow by driving the
 * state machine through multiple phases (plan → execute → critic → verify → iterate)
 * and verify that blocking middleware correctly prevents task execution or
 * marks verifier as failed.
 *
 * NOTE: engine.run() cannot be used in tests because vi.fn() retains all
 * call arguments from writeFileSync/appendFileSync, causing OOM during the
 * many persist() calls in a full run loop. Instead, we drive the state machine
 * manually via private methods to achieve the same coverage.
 *
 * @module __tests__/forge-engine-e2e
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── Mock node:fs and node:path before any imports ─────────────────────────

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

vi.mock('node:path', () => ({
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/') || '.'),
  join: vi.fn((...args: string[]) => args.join('/')),
  basename: vi.fn((p: string) => p.split('/').pop() ?? p),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-0000-0000-000000000000'),
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

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { ForgeEngine } from '../forge-engine';
import { MiddlewarePipeline } from '../forge-middleware';
import { ForgeEventBus } from '../forge-events';
import type { MiddlewareContext } from '../types/middleware';
import type { ForgeProject } from '../types';
import { forgeRun } from '../forge-runner.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ForgeEngine Full-Flow: blocking middleware across phases', () => {
  let activeEngine: ForgeEngine | null = null;

  afterEach(() => {
    activeEngine?.stop();
    activeEngine = null;
    vi.clearAllMocks();
  });

  /**
   * Test: quality-gate blocking skips worker execution
   *
   * Flow: setup → plan (leader creates coder tasks) → execute (quality-gate blocks → skip to iterating)
   *
   * Verifies that:
   * 1. Leader plan runs and creates tasks
   * 2. Quality-gate middleware blocks during executing phase
   * 3. Worker forgeRun is NOT called
   * 4. Engine transitions to iterating (skipping execution)
   */
  it('should skip worker execution when quality-gate blocks: setup → plan → execute (blocked)', async () => {
    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const forgeRunCalls: Array<{ taskId?: string; roleName?: string }> = [];

    mockForgeRun.mockImplementation(async (opts: any) => {
      forgeRunCalls.push({ taskId: opts.taskId, roleName: opts.roleName });
      if (opts.roleName === 'leader') {
        return {
          success: true,
          output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "write code"}, {"id": "coder-2", "role": "coder", "description": "write tests"}]}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      }
      return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
    });

    const project = createTestProject();
    const engine = new ForgeEngine(project, { log: () => {} });
    activeEngine = engine;

    const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;

    // Mock pipeline: block with quality-gate failure only during executing phase
    const originalExecute = pipeline.execute.bind(pipeline);
    vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
      if (ctx.config.phase === 'executing') {
        return {
          context: ctx,
          success: false,
          error: 'quality-gate-blocked',
          steps: [
            { name: 'context-enrichment', status: 'executed' as const, durationMs: 1, blocking: false },
            { name: 'progress', status: 'executed' as const, durationMs: 1, blocking: false },
            { name: 'quality-gate', status: 'error' as const, durationMs: 0, error: 'quality-gate-blocked', blocking: true },
          ],
          totalDurationMs: 2,
        };
      }
      return originalExecute(ctx);
    });

    // Phase 1: Setup
    await (engine as any).setup();
    expect(engine.currentState.phase).toBe('planning');

    // Phase 2: Plan — leader creates tasks (leader plan task + 2 parsed coder tasks = 3)
    await (engine as any).plan();
    expect(engine.currentState.phase).toBe('executing');
    expect(engine.currentState.iterations[0].tasks.length).toBe(3); // leader + 2 coder
    const coderTasks = engine.currentState.iterations[0].tasks.filter((t: any) => t.role === 'coder');
    expect(coderTasks.length).toBe(2);
    expect(coderTasks[0].status).toBe('pending');

    // Phase 3: Execute — quality-gate blocks, should skip to iterating
    await (engine as any).executeDynamic();
    expect(engine.currentState.phase).toBe('iterating');

    // Worker forgeRun should NOT have been called — only leader for plan
    const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
    expect(workerCalls.length).toBe(0);

    // Leader was called (for planning)
    const leaderCalls = forgeRunCalls.filter(c => c.roleName === 'leader');
    expect(leaderCalls.length).toBe(1);

    // Coder tasks remain pending (not executed)
    const pendingCoderTasks = engine.currentState.iterations[0].tasks.filter(
      (t: any) => t.role === 'coder' && t.status === 'pending',
    );
    expect(pendingCoderTasks.length).toBe(2);
  });

  /**
   * Test: loop-detection blocking marks verifier as failed
   *
   * Flow: setup → plan → execute → critic → verify (loop-detection blocks → verifierPassed=false)
   *
   * Verifies that:
   * 1. Full flow runs through execute and critic successfully
   * 2. Loop-detection middleware blocks during verifying phase
   * 3. Verifier content says "pass" but verifierPassed is overridden to false
   */
  it('should mark verifierPassed=false when loop-detection blocks: setup → plan → execute → critic → verify (blocked)', async () => {
    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;

    mockForgeRun.mockImplementation(async (opts: any) => {
      if (opts.roleName === 'leader') {
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

    const project = createTestProject();
    const engine = new ForgeEngine(project, { log: () => {} });
    activeEngine = engine;

    const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;

    // Mock pipeline: block with loop-detection failure during verifying phase
    const originalExecute = pipeline.execute.bind(pipeline);
    vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
      if (ctx.config.phase === 'verifying') {
        return {
          context: ctx,
          success: false,
          error: 'loop-detected-in-verify',
          steps: [
            { name: 'context-enrichment', status: 'executed' as const, durationMs: 1, blocking: false },
            { name: 'progress', status: 'executed' as const, durationMs: 1, blocking: false },
            { name: 'loop-detection', status: 'error' as const, durationMs: 0, error: 'loop-detected-in-verify', blocking: true },
          ],
          totalDurationMs: 2,
        };
      }
      return originalExecute(ctx);
    });

    // Drive the full state machine manually
    await (engine as any).setup();
    expect(engine.currentState.phase).toBe('planning');

    await (engine as any).plan();
    expect(engine.currentState.phase).toBe('executing');

    await (engine as any).executeDynamic();
    expect(engine.currentState.phase).toBe('critiquing');

    await (engine as any).runCritic();
    expect(engine.currentState.phase).toBe('verifying');

    await (engine as any).runVerifier();
    expect(engine.currentState.phase).toBe('iterating');

    // Verifier content was "All checks pass" BUT loop-detection blocked
    // → verifierPassed must be false
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    expect(iter.verifierPassed).toBe(false);
  });

  /**
   * Test: pipeline crash during verification emits middleware_error and marks verifier failed
   *
   * Flow: setup → plan → execute → critic → verify (pipeline crash → null → verifierPassed=false + middleware_error)
   */
  it('should emit middleware_error and mark verifierPassed=false when pipeline crashes during verify', async () => {
    const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
    const emittedEvents: Array<{ type: string; message: string }> = [];

    mockForgeRun.mockImplementation(async (opts: any) => {
      if (opts.roleName === 'leader') {
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

    const project = createTestProject();
    const engine = new ForgeEngine(project, { log: () => {} });
    activeEngine = engine;

    // Listen on v2 EventBus directly (middleware_error is not mapped to legacy events)
    const eventBus: ForgeEventBus = (engine as any).subsystems.eventBus;
    eventBus.on('middleware_error', (ev: any) => { emittedEvents.push(ev); });

    const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;

    // Mock pipeline to THROW during verifying phase → runPipeline returns null
    const originalExecute = pipeline.execute.bind(pipeline);
    vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
      if (ctx.config.phase === 'verifying') {
        throw new Error('pipeline-crash-in-verification');
      }
      return originalExecute(ctx);
    });

    // Drive full flow
    await (engine as any).setup();
    await (engine as any).plan();
    await (engine as any).executeDynamic();
    await (engine as any).runCritic();
    await (engine as any).runVerifier();

    // middleware_error event with pipeline crash message emitted (via v2 EventBus)
    const crashEvents = emittedEvents.filter(
      (ev: any) => ev.message.includes('Pipeline crashed during verification'),
    );
    expect(crashEvents.length).toBeGreaterThan(0);

    // verifierPassed should be false
    const iter = engine.currentState.iterations[0];
    expect(iter).toBeDefined();
    expect(iter.verifierPassed).toBe(false);
  });
});
