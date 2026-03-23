/**
 * DeepForge 2.0 — ForgeEngine Integration Tests
 *
 * Tests that verify the engine's integration with the middleware pipeline,
 * EventBus, and other v2 subsystems. Unlike unit tests for individual
 * subsystems, these tests ensure ForgeEngine actually *uses* the pipeline
 * and that pipeline results affect engine behavior.
 *
 * @module __tests__/forge-engine-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock forgeRun — we don't want to spawn real CC processes
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
import { MiddlewarePipeline, createMiddlewareContext } from '../forge-middleware';
import type { MiddlewareContext, MiddlewareFn, MiddlewareResult } from '../types/middleware';
import type { ForgeProject } from '../types';
import { forgeRun } from '../forge-runner.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

function createTestProject(overrides?: Partial<ForgeProject>): ForgeProject {
  return {
    id: 'test-project',
    title: 'Test Project',
    description: 'Integration test project',
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

describe('ForgeEngine Integration', () => {
  let engine: ForgeEngine;
  let project: ForgeProject;
  const events: Array<{ type: string; message: string }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    project = createTestProject();
    engine = new ForgeEngine(project, {
      log: () => {},
      onEvent: (e) => events.push(e),
    });
  });

  afterEach(() => {
    engine.stop();
  });

  // ────────────────────────────────────────────
  // 1. Engine constructs with 6 middleware registered
  // ────────────────────────────────────────────
  describe('middleware registration', () => {
    it('should register 6 middleware in the pipeline after construction', () => {
      // Access subsystems through the engine's pipeline
      // The pipeline is inside subsystems which is private, so we test via
      // the public API indirectly — the engine logs the middleware chain.
      // We can verify by checking that the pipeline has the expected size.
      const subsystems = (engine as any).subsystems;
      const pipeline: MiddlewarePipeline = subsystems.pipeline;

      expect(pipeline.size).toBe(6);
    });

    it('should register middleware with correct names', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const chain = pipeline.chain;

      expect(chain).toContain('context-enrichment');
      expect(chain).toContain('progress');
      expect(chain).toContain('artifact-tracking');
      expect(chain).toContain('summarization');
      expect(chain).toContain('quality-gate');
      expect(chain).toContain('loop-detection');
    });

    it('should order middleware by priority (low to high)', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const chain = pipeline.chain;

      // Priority order: context-enrichment(50) < progress(60) < artifact-tracking(65)
      //   < summarization(70) < quality-gate(110) < loop-detection(115)
      const ceIdx = chain.indexOf('context-enrichment');
      const progIdx = chain.indexOf('progress');
      const atIdx = chain.indexOf('artifact-tracking');
      const sumIdx = chain.indexOf('summarization');
      const qgIdx = chain.indexOf('quality-gate');
      const ldIdx = chain.indexOf('loop-detection');

      expect(ceIdx).toBeLessThan(progIdx);
      expect(progIdx).toBeLessThan(atIdx);
      expect(atIdx).toBeLessThan(sumIdx);
      expect(sumIdx).toBeLessThan(qgIdx);
      expect(qgIdx).toBeLessThan(ldIdx);
    });
  });

  // ────────────────────────────────────────────
  // 2. pipeline.execute() is called during run()
  // ────────────────────────────────────────────
  describe('pipeline execution during engine run', () => {
    it('should call pipeline.execute() when executing tasks', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const executeSpy = vi.spyOn(pipeline, 'execute');

      // Set up a scenario where engine enters executing phase with pending tasks
      // Mock forgeRun to return tasks for the planning phase, then succeed for execution
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      let callCount = 0;
      mockForgeRun.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Leader planning: return tasks
          return {
            success: true,
            output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "test task", "priority": "medium"}]}\n```',
            costUsd: 0.01,
            durationMs: 100,
          };
        }
        // All subsequent calls: succeed
        return {
          success: true,
          output: 'Done. PROJECT_COMPLETE',
          costUsd: 0.01,
          durationMs: 50,
        };
      });

      // Run engine — it will go through setup → planning → executing → ...
      // Stop after a bit to prevent infinite loop
      setTimeout(() => engine.stop(), 500);
      await engine.run();

      // pipeline.execute() should have been called at least once (during executing phase)
      expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('should call fireBeforeIteration during planning', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const fireBeforeSpy = vi.spyOn(pipeline, 'fireBeforeIteration');

      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true,
        output: 'PROJECT_COMPLETE',
        costUsd: 0.01,
        durationMs: 50,
      });

      setTimeout(() => engine.stop(), 500);
      await engine.run();

      // fireBeforeIteration is called during plan()
      expect(fireBeforeSpy).toHaveBeenCalled();
    });

    it('should call fireAfterIteration during iterate', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const fireAfterSpy = vi.spyOn(pipeline, 'fireAfterIteration');

      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      let callCount = 0;
      mockForgeRun.mockImplementation(async () => {
        callCount++;
        return {
          success: true,
          output: callCount >= 4 ? 'PROJECT_COMPLETE' : '```json\n{"tasks": []}\n```',
          costUsd: 0.01,
          durationMs: 50,
        };
      });

      setTimeout(() => engine.stop(), 500);
      await engine.run();

      // fireAfterIteration is called during iterate()
      expect(fireAfterSpy).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // 3. Pipeline results are logged
  // ────────────────────────────────────────────
  describe('pipeline result handling', () => {
    it('should log middleware errors from pipeline results', async () => {
      const logMessages: string[] = [];
      const engineWithLog = new ForgeEngine(project, {
        log: (msg) => logMessages.push(msg),
      });

      // Replace a middleware with one that throws
      const pipeline: MiddlewarePipeline = (engineWithLog as any).subsystems.pipeline;
      pipeline.remove('context-enrichment');
      pipeline.use(
        async (_ctx: MiddlewareContext, next) => {
          throw new Error('test-enrichment-failure');
        },
        { name: 'context-enrichment', priority: 50, continueOnError: true, timeout: 5_000 },
      );

      // Directly test runPipeline
      await (engineWithLog as any).runPipeline('executing');

      // Should log the error from the failed middleware step
      const errorLogs = logMessages.filter(m => m.includes('context-enrichment') || m.includes('test-enrichment-failure'));
      expect(errorLogs.length).toBeGreaterThan(0);

      engineWithLog.stop();
    });

    it('should log pipeline warning when result.success is false', async () => {
      const logMessages: string[] = [];
      const engineWithLog = new ForgeEngine(project, {
        log: (msg) => logMessages.push(msg),
      });

      // Replace a critical middleware with one that throws (continueOnError: false on pipeline level)
      const pipeline: MiddlewarePipeline = (engineWithLog as any).subsystems.pipeline;
      // Quality gate has continueOnError: true currently, but pipeline-level is false
      // Let's add a new middleware that fails and doesn't continue
      pipeline.use(
        async () => { throw new Error('critical-failure'); },
        { name: 'test-blocker', priority: 1, continueOnError: false, timeout: 5_000 },
      );

      await (engineWithLog as any).runPipeline('executing');

      const warningLogs = logMessages.filter(m => m.includes('Pipeline'));
      expect(warningLogs.length).toBeGreaterThan(0);

      engineWithLog.stop();
    });
  });

  // ────────────────────────────────────────────
  // 4. continueOnError behavior per middleware
  // ────────────────────────────────────────────
  describe('continueOnError configuration', () => {
    it('context-enrichment middleware has continueOnError: true', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      // Verify via registration internals
      const regs = (pipeline as any).registrations;
      const ce = regs.find((r: any) => r.options.name === 'context-enrichment');
      expect(ce.options.continueOnError).toBe(true);
    });

    it('progress middleware has continueOnError: true', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const regs = (pipeline as any).registrations;
      const p = regs.find((r: any) => r.options.name === 'progress');
      expect(p.options.continueOnError).toBe(true);
    });

    it('quality-gate middleware has continueOnError: false (P1-2 fix)', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const regs = (pipeline as any).registrations;
      const qg = regs.find((r: any) => r.options.name === 'quality-gate');
      expect(qg.options.continueOnError).toBe(false);
    });

    it('loop-detection middleware has continueOnError: false (P1-2 fix)', () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const regs = (pipeline as any).registrations;
      const ld = regs.find((r: any) => r.options.name === 'loop-detection');
      expect(ld.options.continueOnError).toBe(false);
    });

    it('enrichment middleware failure does not stop the pipeline', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;

      // Replace context-enrichment with a failing one
      pipeline.remove('context-enrichment');
      pipeline.use(
        async () => { throw new Error('enrichment-crash'); },
        { name: 'context-enrichment', priority: 50, continueOnError: true, timeout: 5_000 },
      );

      // Add a spy middleware after all others to verify pipeline continued
      let spyReached = false;
      pipeline.use(
        async (ctx, next) => { spyReached = true; return next(); },
        { name: 'spy-after', priority: 200, continueOnError: true },
      );

      const ctx = createMiddlewareContext({
        config: { projectId: 'test', model: 'test', effort: 'medium', maxConcurrent: 3, phase: 'executing' },
      });
      const result = await pipeline.execute(ctx);

      // Pipeline continued past the failing middleware
      expect(spyReached).toBe(true);
      // The failing step is recorded
      const failedStep = result.steps.find(s => s.name === 'context-enrichment');
      expect(failedStep?.status).toBe('error');
    });
  });

  // ────────────────────────────────────────────
  // 5. EventBus integration
  // ────────────────────────────────────────────
  describe('EventBus integration', () => {
    it('should have EventBus created in subsystems', () => {
      const subsystems = (engine as any).subsystems;
      expect(subsystems.eventBus).toBeDefined();
    });

    it('should emit phase_transition events on setPhase', async () => {
      const eventBus = (engine as any).subsystems.eventBus;
      const emittedEvents: any[] = [];
      eventBus.on('phase_transition', (e: any) => emittedEvents.push(e));

      // Call setPhase (private but we access it for testing)
      (engine as any).setPhase('planning');

      // EventBus emit is async (void promise) — wait for microtask
      await new Promise(r => setTimeout(r, 10));

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe('phase_transition');
      expect(emittedEvents[0].to).toBe('planning');
    });

    it('should bridge v2 events to legacy onEvent callback', () => {
      // Events array is populated by the onEvent callback from constructor
      (engine as any).setPhase('executing');

      const phaseEvents = events.filter(e => e.type === 'phase');
      expect(phaseEvents.length).toBeGreaterThan(0);
    });

    it('should emit middleware lifecycle events during pipeline execution', async () => {
      const eventBus = (engine as any).subsystems.eventBus;
      const middlewareEvents: any[] = [];
      eventBus.on('middleware_enter', (e: any) => middlewareEvents.push(e));
      eventBus.on('middleware_exit', (e: any) => middlewareEvents.push(e));

      await (engine as any).runPipeline('executing');

      // Should have enter/exit events for each middleware that ran
      expect(middlewareEvents.length).toBeGreaterThan(0);
      const enterEvents = middlewareEvents.filter((e: any) => e.type === 'middleware_enter');
      const exitEvents = middlewareEvents.filter((e: any) => e.type === 'middleware_exit');
      expect(enterEvents.length).toBeGreaterThanOrEqual(1);
      expect(exitEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────
  // 6. Subsystems are properly wired
  // ────────────────────────────────────────────
  describe('subsystem wiring', () => {
    it('should create all 6 subsystems', () => {
      const s = (engine as any).subsystems;
      expect(s.eventBus).toBeDefined();
      expect(s.memory).toBeDefined();
      expect(s.configManager).toBeDefined();
      expect(s.pipeline).toBeDefined();
      expect(s.semaphore).toBeDefined();
      expect(s.dashboard).toBeDefined();
    });

    it('should update semaphore max from project.maxConcurrent', () => {
      const semaphore = (engine as any).subsystems.semaphore;
      // Default project has maxConcurrent: 3
      expect(semaphore.max).toBe(3);
    });

    it('should destroy subsystems on engine exit', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const clearSpy = vi.spyOn(pipeline, 'clear');

      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true,
        output: '',
        costUsd: 0,
        durationMs: 10,
      });

      // Stop immediately
      engine.stop();
      await engine.run();

      // Pipeline should have been cleared during destroyForgeSubsystems
      expect(clearSpy).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  // 7. Public API still works
  // ────────────────────────────────────────────
  describe('public API compatibility', () => {
    it('should expose currentState with correct initial state', () => {
      const state = engine.currentState;
      expect(state.projectId).toBe('test-project');
      expect(state.phase).toBe('setup');
      expect(state.currentIteration).toBe(0);
      expect(state.iterations).toEqual([]);
      expect(state.totalCostUsd).toBe(0);
    });

    it('stop() should halt the engine run loop', async () => {
      engine.stop();

      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true, output: '', costUsd: 0, durationMs: 10,
      });

      await engine.run();
      // Engine should exit without error when stopped
      expect(engine.currentState.phase).toBe('setup');
    });

    it('resolveNotification() should work without errors', () => {
      // Should not throw
      expect(() => engine.resolveNotification('test-id', 'test reply')).not.toThrow();
    });
  });

  // ────────────────────────────────────────────
  // 8. buildMiddlewareContext produces valid context
  // ────────────────────────────────────────────
  describe('middleware context building', () => {
    it('should build context with correct project info', () => {
      const ctx = (engine as any).buildMiddlewareContext('executing');
      expect(ctx.config.projectId).toBe('test-project');
      expect(ctx.config.model).toBe('claude-sonnet-4-20250514');
      expect(ctx.config.phase).toBe('executing');
      expect(ctx.config.maxConcurrent).toBe(3);
    });

    it('should include iteration info when available', () => {
      // Manually add an iteration
      const state = engine.currentState;
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 't1', role: 'coder', description: 'test', priority: 'medium', status: 'completed' },
          { id: 't2', role: 'coder', description: 'test2', priority: 'medium', status: 'failed', error: 'err' },
        ],
        costUsd: 0.5,
        startedAt: new Date().toISOString(),
      });

      const ctx = (engine as any).buildMiddlewareContext('verifying');
      expect(ctx.iteration).toBeDefined();
      expect(ctx.iteration.number).toBe(1);
      expect(ctx.iteration.taskCount).toBe(2);
      expect(ctx.iteration.completedCount).toBe(1);
      expect(ctx.iteration.failedCount).toBe(1);
    });

    it('should have empty state object', () => {
      const ctx = (engine as any).buildMiddlewareContext('setup');
      expect(ctx.state).toEqual({});
    });
  });

  // ────────────────────────────────────────────
  // 9. Pipeline with real middleware chain
  // ────────────────────────────────────────────
  describe('real pipeline chain execution', () => {
    it('should execute all 6 middleware and record steps', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const ctx = (engine as any).buildMiddlewareContext('executing');

      const result: MiddlewareResult = await pipeline.execute(ctx);

      expect(result.steps.length).toBe(6);
      // Each middleware should have a recorded step (executed, skipped, or error with continueOnError)
      const stepNames = result.steps.map(s => s.name);
      expect(stepNames).toContain('context-enrichment');
      expect(stepNames).toContain('progress');
      expect(stepNames).toContain('artifact-tracking');
      expect(stepNames).toContain('summarization');
      expect(stepNames).toContain('quality-gate');
      expect(stepNames).toContain('loop-detection');
    });

    it('should return result with totalDurationMs', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const ctx = (engine as any).buildMiddlewareContext('verifying');

      const result = await pipeline.execute(ctx);

      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.context).toBeDefined();
    });

    it('should preserve context through middleware chain', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const ctx = (engine as any).buildMiddlewareContext('executing');
      ctx.state.testMarker = 'should-survive';

      const result = await pipeline.execute(ctx);

      expect(result.context.state.testMarker).toBe('should-survive');
    });
  });

  // ────────────────────────────────────────────
  // 10. runPipeline integration
  // ────────────────────────────────────────────
  describe('runPipeline method', () => {
    it('should not throw even if pipeline fails', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;

      // Add a blocking middleware that throws
      pipeline.use(
        async () => { throw new Error('total-pipeline-crash'); },
        { name: 'crasher', priority: 1, continueOnError: false },
      );

      // runPipeline catches errors internally — should not throw
      // It may return a result or undefined depending on whether error is caught at pipeline or engine level
      await expect((engine as any).runPipeline('executing')).resolves.not.toThrow();
    });

    it('should call pipeline.execute with correct phase in context', async () => {
      const pipeline: MiddlewarePipeline = (engine as any).subsystems.pipeline;
      const executeSpy = vi.spyOn(pipeline, 'execute');

      await (engine as any).runPipeline('verifying');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const ctx = executeSpy.mock.calls[0][0] as MiddlewareContext;
      expect(ctx.config.phase).toBe('verifying');
    });
  });

  // ────────────────────────────────────────────
  // 11. Blocking path — quality-gate failure skips task execution
  // ────────────────────────────────────────────
  describe('blocking path: quality-gate failure skips execution', () => {
    it('should skip worker task execution when quality-gate middleware fails (via executeDynamic)', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      const forgeRunCalls: Array<{ taskId?: string; roleName?: string }> = [];

      mockForgeRun.mockImplementation(async (opts: any) => {
        forgeRunCalls.push({ taskId: opts.taskId, roleName: opts.roleName });
        return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
      });

      const logMessages: string[] = [];
      const blockingEngine = new ForgeEngine(project, { log: (msg) => logMessages.push(msg) });
      const pipeline: MiddlewarePipeline = (blockingEngine as any).subsystems.pipeline;

      // Mock pipeline.execute to return a result with a failed quality-gate step.
      // This avoids the onion-model cascade that makes the real pipeline hard to test.
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        context: {} as MiddlewareContext,
        success: false,
        error: 'quality-gate-blocked',
        steps: [
          { name: 'context-enrichment', status: 'executed', durationMs: 1, blocking: false },
          { name: 'progress', status: 'executed', durationMs: 1, blocking: false },
          { name: 'quality-gate', status: 'error', durationMs: 0, error: 'quality-gate-blocked', blocking: true },
        ],
        totalDurationMs: 2,
      });

      // Set up state as if plan() already ran with pending worker tasks
      const state = blockingEngine.currentState;
      state.phase = 'executing';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 'coder-1', role: 'coder', description: 'write code', priority: 'medium', status: 'pending' },
          { id: 'coder-2', role: 'coder', description: 'write more code', priority: 'medium', status: 'pending' },
        ],
        costUsd: 0,
        startedAt: new Date().toISOString(),
      });

      await (blockingEngine as any).executeDynamic();

      // Worker tasks should NOT have been executed — quality-gate blocked
      const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
      expect(workerCalls.length).toBe(0);

      // Phase should have transitioned to 'iterating' (skipping execution)
      expect(state.phase).toBe('iterating');

      // Should log blocking middleware failure
      const blockingLogs = logMessages.filter(m => m.includes('Blocking middleware failure') && m.includes('quality-gate'));
      expect(blockingLogs.length).toBeGreaterThan(0);

      blockingEngine.stop();
    });

    it('should execute worker tasks when quality-gate succeeds (control test)', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      const forgeRunCalls: Array<{ taskId?: string; roleName?: string }> = [];

      mockForgeRun.mockImplementation(async (opts: any) => {
        forgeRunCalls.push({ taskId: opts.taskId, roleName: opts.roleName });
        return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
      });

      // No pipeline manipulation — quality-gate passes normally
      const state = engine.currentState;
      state.phase = 'executing';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 'coder-1', role: 'coder', description: 'write code', priority: 'medium', status: 'pending' },
        ],
        costUsd: 0,
        startedAt: new Date().toISOString(),
      });

      await (engine as any).executeDynamic();

      // Worker task SHOULD have been executed — no blocking
      const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
      expect(workerCalls.length).toBe(1);

      // Phase should be 'critiquing' (normal flow)
      expect(state.phase).toBe('critiquing');
    });

    it('should also block when pipeline crashes (runPipeline returns null)', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      const forgeRunCalls: Array<{ taskId?: string; roleName?: string }> = [];

      mockForgeRun.mockImplementation(async (opts: any) => {
        forgeRunCalls.push({ taskId: opts.taskId, roleName: opts.roleName });
        return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
      });

      const blockingEngine = new ForgeEngine(project, { log: () => {} });
      const pipeline: MiddlewarePipeline = (blockingEngine as any).subsystems.pipeline;

      // Mock pipeline.execute to THROW — runPipeline will catch and return null
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('pipeline-crash'));

      const state = blockingEngine.currentState;
      state.phase = 'executing';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 'coder-1', role: 'coder', description: 'write code', priority: 'medium', status: 'pending' },
        ],
        costUsd: 0,
        startedAt: new Date().toISOString(),
      });

      await (blockingEngine as any).executeDynamic();

      // When pipeline crashes, execution is also blocked (conservative behavior)
      const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
      expect(workerCalls.length).toBe(0);

      blockingEngine.stop();
    });
  });

  // ────────────────────────────────────────────
  // 12. Blocking path — loop-detection failure marks verifier as failed
  // ────────────────────────────────────────────
  describe('blocking path: loop-detection failure marks verifier failed', () => {
    it('should set verifierPassed = false when loop-detection fails during verification', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true,
        output: '✅ All good, no issues',
        costUsd: 0.01,
        durationMs: 50,
      });

      const blockingEngine = new ForgeEngine(project, { log: () => {} });
      const pipeline: MiddlewarePipeline = (blockingEngine as any).subsystems.pipeline;

      // Mock pipeline.execute to return a failed loop-detection step in verifying phase
      const originalExecute = pipeline.execute.bind(pipeline);
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
        if (ctx.config.phase === 'verifying') {
          return {
            context: ctx,
            success: false,
            error: 'loop-detected-in-verify',
            steps: [
              { name: 'context-enrichment', status: 'executed', durationMs: 1, blocking: false },
              { name: 'progress', status: 'executed', durationMs: 1, blocking: false },
              { name: 'loop-detection', status: 'error', durationMs: 0, error: 'loop-detected-in-verify', blocking: true },
            ],
            totalDurationMs: 2,
          };
        }
        return originalExecute(ctx);
      });

      // Set up state as if execution + critique already completed
      const state = blockingEngine.currentState;
      state.phase = 'verifying';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 'coder-1', role: 'coder', description: 'write code', priority: 'medium', status: 'completed' },
        ],
        costUsd: 0.1,
        startedAt: new Date().toISOString(),
      });

      // Call runVerifier directly
      await (blockingEngine as any).runVerifier();

      // Verifier output was "All good" (success), BUT loop-detection middleware
      // failed during post-verification pipeline → verifierPassed should be false
      expect(state.iterations[0].verifierPassed).toBe(false);

      blockingEngine.stop();
    });

    it('should keep verifierPassed = true when loop-detection succeeds (control test)', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true,
        output: '✅ All good, no issues',
        costUsd: 0.01,
        durationMs: 50,
      });

      // No pipeline manipulation — loop-detection passes normally
      const state = engine.currentState;
      state.phase = 'verifying';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [
          { id: 'coder-1', role: 'coder', description: 'write code', priority: 'medium', status: 'completed' },
        ],
        costUsd: 0.1,
        startedAt: new Date().toISOString(),
      });

      await (engine as any).runVerifier();

      // Without loop-detection failure, verifierPassed should be true
      expect(state.iterations[0].verifierPassed).toBe(true);
    });

    it('should log post-verification pipeline failure', async () => {
      const logMessages: string[] = [];
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      mockForgeRun.mockResolvedValue({
        success: true,
        output: '✅ OK',
        costUsd: 0.01,
        durationMs: 50,
      });

      const blockingEngine = new ForgeEngine(project, { log: (msg) => logMessages.push(msg) });
      const pipeline: MiddlewarePipeline = (blockingEngine as any).subsystems.pipeline;

      // Mock pipeline.execute to return a failed loop-detection step in verifying phase
      const originalExecute = pipeline.execute.bind(pipeline);
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
        if (ctx.config.phase === 'verifying') {
          return {
            context: ctx,
            success: false,
            error: 'loop-detected-in-verify',
            steps: [
              { name: 'context-enrichment', status: 'executed', durationMs: 1, blocking: false },
              { name: 'loop-detection', status: 'error', durationMs: 0, error: 'loop-detected-in-verify', blocking: true },
            ],
            totalDurationMs: 1,
          };
        }
        return originalExecute(ctx);
      });

      const state = blockingEngine.currentState;
      state.phase = 'verifying';
      state.currentIteration = 1;
      state.iterations.push({
        number: 1,
        tasks: [],
        costUsd: 0,
        startedAt: new Date().toISOString(),
      });

      await (blockingEngine as any).runVerifier();

      const blockingLogs = logMessages.filter(m =>
        m.includes('Post-verification pipeline failure') && m.includes('loop-detection'),
      );
      expect(blockingLogs.length).toBeGreaterThan(0);

      blockingEngine.stop();
    });
  });

  // ────────────────────────────────────────────
  // 13. End-to-end blocking tests through engine.run()
  //
  // These tests call engine.run() which drives the full state machine loop.
  // The engine is stopped via onEvent callback when it reaches target phase.
  // ────────────────────────────────────────────
  describe('end-to-end: blocking middleware via engine.run()', () => {
    it('should skip worker execution when quality-gate blocks during run()', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;
      const forgeRunCalls: Array<{ taskId?: string; roleName?: string }> = [];

      // Plan phase returns tasks with a coder role; other phases return generic success
      mockForgeRun.mockImplementation(async (opts: any) => {
        forgeRunCalls.push({ taskId: opts.taskId, roleName: opts.roleName });
        if (opts.roleName === 'leader' && opts.taskId?.includes('plan')) {
          return {
            success: true,
            output: '```json\n{"tasks": [{"id": "coder-1", "role": "coder", "description": "write code"}]}\n```',
            costUsd: 0.01,
            durationMs: 50,
          };
        }
        return { success: true, output: 'Done', costUsd: 0.01, durationMs: 50 };
      });

      const phaseLog: string[] = [];
      const e2eEngine = new ForgeEngine(project, {
        log: () => {},
        onEvent: (ev) => {
          phaseLog.push(ev.type + ':' + (ev as any).to);
          // Stop BEFORE iterate() runs — when we enter iterating due to blocking
          if ((ev as any).to === 'iterating') {
            e2eEngine.stop();
          }
        },
      });

      const pipeline: MiddlewarePipeline = (e2eEngine as any).subsystems.pipeline;

      // Mock pipeline to block with quality-gate failure only during executing phase
      const originalExecute = pipeline.execute.bind(pipeline);
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
        if (ctx.config.phase === 'executing') {
          return {
            context: ctx,
            success: false,
            error: 'quality-gate-blocked',
            steps: [
              { name: 'context-enrichment', status: 'executed' as const, durationMs: 1, blocking: false },
              { name: 'quality-gate', status: 'error' as const, durationMs: 0, error: 'quality-gate-blocked', blocking: true },
            ],
            totalDurationMs: 1,
          };
        }
        return originalExecute(ctx);
      });

      // Run the engine — it will go setup → plan → execute (blocked) → iterating → stop
      await e2eEngine.run();

      // Verify: worker forgeRun should NOT have been called (only leader for plan)
      const workerCalls = forgeRunCalls.filter(c => c.roleName === 'coder');
      expect(workerCalls.length).toBe(0);

      // Leader should have been called (for planning)
      const leaderCalls = forgeRunCalls.filter(c => c.roleName === 'leader');
      expect(leaderCalls.length).toBeGreaterThanOrEqual(1);

      // Phase should have transitioned through executing → iterating
      expect(phaseLog).toContain('phase_transition:executing');
      expect(phaseLog).toContain('phase_transition:iterating');
    });

    it('should mark verifierPassed=false when loop-detection blocks during run()', async () => {
      const mockForgeRun = forgeRun as ReturnType<typeof vi.fn>;

      // All phases return reasonable output
      mockForgeRun.mockImplementation(async (opts: any) => {
        if (opts.roleName === 'leader' && opts.taskId?.includes('plan')) {
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
          return { success: true, output: 'Looks good', costUsd: 0.01, durationMs: 50 };
        }
        if (opts.roleName === 'verifier') {
          return { success: true, output: '✅ All checks pass', costUsd: 0.01, durationMs: 50 };
        }
        // leader iterate — include PROJECT_COMPLETE to exit cleanly
        return { success: true, output: 'PROJECT_COMPLETE', costUsd: 0.01, durationMs: 50 };
      });

      const e2eEngine = new ForgeEngine(project, {
        log: () => {},
      });

      const pipeline: MiddlewarePipeline = (e2eEngine as any).subsystems.pipeline;

      // Mock pipeline to block with loop-detection failure only during verifying phase
      const originalExecute = pipeline.execute.bind(pipeline);
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: MiddlewareContext) => {
        if (ctx.config.phase === 'verifying') {
          return {
            context: ctx,
            success: false,
            error: 'loop-detected',
            steps: [
              { name: 'context-enrichment', status: 'executed' as const, durationMs: 1, blocking: false },
              { name: 'loop-detection', status: 'error' as const, durationMs: 0, error: 'loop-detected', blocking: true },
            ],
            totalDurationMs: 1,
          };
        }
        return originalExecute(ctx);
      });

      // run() goes: setup → plan → execute → critic → verify (blocked) → iterate → plan (loop)
      // Stop when we see the verifier result persisted — after iterating phase starts
      let iteratingCount = 0;
      const origStop = e2eEngine.stop.bind(e2eEngine);
      const origOnEvent = (e2eEngine as any).onEvent;
      (e2eEngine as any).onEvent = (ev: any) => {
        origOnEvent?.(ev);
        if (ev.to === 'iterating') {
          iteratingCount++;
          // Don't stop here — let iterate() run, but stop when it transitions to planning
        }
        if (ev.to === 'planning' && iteratingCount >= 1) {
          e2eEngine.stop();
        }
        if (ev.to === 'completing' || ev.to === 'completed') {
          e2eEngine.stop();
        }
      };

      await e2eEngine.run();

      // Verify: the first iteration's verifierPassed should be false
      const state = e2eEngine.currentState;
      const firstIter = state.iterations[0];
      expect(firstIter).toBeDefined();
      expect(firstIter.verifierPassed).toBe(false);
    });
  });
});
