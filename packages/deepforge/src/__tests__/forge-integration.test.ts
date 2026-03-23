/**
 * DeepForge 2.0 — Subsystem Integration Test (mocked I/O)
 *
 * Tests the full lifecycle: createForgeSubsystems → middleware registration →
 * pipeline execution → destroyForgeSubsystems.
 *
 * Covers Critic-9 O1: subsystem integration validation.
 *
 * @module __tests__/forge-integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock node:fs, node:path, node:crypto before imports ──────────────────

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
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

vi.mock('node:path', () => ({
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/') || '.'),
  join: vi.fn((...args: string[]) => args.join('/')),
  basename: vi.fn((p: string) => p.split('/').pop() ?? p),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'integ-uuid-0000-0000-000000000000'),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────

import {
  createForgeSubsystems,
  destroyForgeSubsystems,
} from '../forge-engine-adapter';
import type { ForgeSubsystems } from '../forge-engine-adapter';
import type { ForgeConfig } from '../types/config';
import { ForgeEventBus } from '../forge-events';
import { ForgeMemory } from '../forge-memory';
import { ForgeConfigManager } from '../forge-config';
import { MiddlewarePipeline } from '../forge-middleware';
import { AsyncSemaphore } from '../forge-semaphore';
import { ForgeDashboard } from '../forge-dashboard';
import type { MiddlewareContext, MiddlewareFn } from '../types/middleware';

// ─── Test Config Factory ─────────────────────────────────────────────────

function createTestConfig(): ForgeConfig {
  return {
    version: '2.0',
    project: {
      model: 'claude-sonnet-4-20250514',
      effort: 'high',
      maxConcurrent: 3,
      maxIterations: 5,
      costLimitUsd: 10,
    },
    middleware: {
      contextEnrichment: { enabled: true, order: 10, params: {} },
      memory: { enabled: true, order: 20, params: {} },
      qualityGate: { enabled: true, order: 30, params: {} },
      concurrencyLimit: { enabled: true, order: 40, params: {} },
      logging: { enabled: true, order: 50, params: {} },
    },
    memory: {
      enabled: true,
      storagePath: '.deepforge/memory.json',
      maxEntries: 100,
      debounceMs: 5000,
      pruneConfidenceThreshold: 0.3,
      pruneRelevanceThreshold: 0.1,
      autoExtract: false,
      injectionCount: 5,
      injectionEnabled: true,
      maxInjectionTokens: 2000,
    },
    events: {
      enabled: true,
      bufferSize: 200,
      allowedTypes: [],
      persistToDisk: false,
    },
    concurrency: {
      maxWorkers: 3,
      queueLimit: 50,
      acquireTimeoutMs: 5000,
    },
    quality: {
      structuredVerdict: true,
      maxAutoRetries: 2,
      passThreshold: 0.7,
    },
    notifications: {
      onPhaseChange: true,
      onTaskFail: true,
      onIterationComplete: true,
      onRunComplete: true,
    },
  } as ForgeConfig;
}

function createTestContext(): MiddlewareContext {
  return {
    messages: [{ role: 'user', content: 'integration test' }],
    config: {
      projectId: 'integ-test',
      model: 'claude-sonnet-4-20250514',
      effort: 'high',
      maxConcurrent: 3,
      phase: 'executing',
      iteration: 1,
    },
    iteration: undefined,
    state: {},
    metadata: {
      runId: '',
      chain: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('forge-integration (subsystem integration, mocked I/O)', () => {
  let config: ForgeConfig;
  let subsystems: ForgeSubsystems | undefined;

  beforeEach(() => {
    config = createTestConfig();
  });

  afterEach(async () => {
    if (subsystems) {
      try {
        await destroyForgeSubsystems(subsystems);
      } catch {
        // Ignore cleanup errors
      }
      subsystems = undefined;
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Subsystem creation — all 6 returned and non-null
  // ═════════════════════════════════════════════════════════════════════════

  describe('createForgeSubsystems returns all 6 subsystems', () => {
    it('should return eventBus as ForgeEventBus instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.eventBus).toBeDefined();
      expect(subsystems.eventBus).toBeInstanceOf(ForgeEventBus);
    });

    it('should return pipeline as MiddlewarePipeline instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.pipeline).toBeDefined();
      expect(subsystems.pipeline).toBeInstanceOf(MiddlewarePipeline);
    });

    it('should return semaphore as AsyncSemaphore instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.semaphore).toBeDefined();
      expect(subsystems.semaphore).toBeInstanceOf(AsyncSemaphore);
    });

    it('should return memory as ForgeMemory instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.memory).toBeDefined();
      expect(subsystems.memory).toBeInstanceOf(ForgeMemory);
    });

    it('should return configManager as ForgeConfigManager instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.configManager).toBeDefined();
      expect(subsystems.configManager).toBeInstanceOf(ForgeConfigManager);
    });

    it('should return dashboard as ForgeDashboard instance', () => {
      subsystems = createForgeSubsystems(config);
      expect(subsystems.dashboard).toBeDefined();
      expect(subsystems.dashboard).toBeInstanceOf(ForgeDashboard);
    });

    it('should have no null subsystems', () => {
      subsystems = createForgeSubsystems(config);
      const keys: (keyof ForgeSubsystems)[] = [
        'eventBus', 'pipeline', 'semaphore', 'memory', 'configManager', 'dashboard',
      ];
      for (const key of keys) {
        expect(subsystems[key]).not.toBeNull();
        expect(subsystems[key]).not.toBeUndefined();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Middleware registration + pipeline execution
  // ═════════════════════════════════════════════════════════════════════════

  describe('pipeline middleware registration and execution', () => {
    it('should register a middleware via use() and execute it', async () => {
      subsystems = createForgeSubsystems(config);
      const executionLog: string[] = [];

      const testMiddleware: MiddlewareFn = async (ctx, next) => {
        executionLog.push('before');
        ctx.state['test-marker'] = true;
        const result = await next();
        executionLog.push('after');
        return result;
      };

      subsystems.pipeline.use(testMiddleware, { name: 'test-mw', priority: 10 });
      expect(subsystems.pipeline.has('test-mw')).toBe(true);

      const ctx = createTestContext();
      const result = await subsystems.pipeline.execute(ctx);

      expect(result.success).toBe(true);
      expect(result.context.state['test-marker']).toBe(true);
      expect(executionLog).toEqual(['before', 'after']);
    });

    it('should execute multiple middleware in priority order', async () => {
      subsystems = createForgeSubsystems(config);
      const order: number[] = [];

      const mw1: MiddlewareFn = async (_ctx, next) => { order.push(1); return next(); };
      const mw2: MiddlewareFn = async (_ctx, next) => { order.push(2); return next(); };
      const mw3: MiddlewareFn = async (_ctx, next) => { order.push(3); return next(); };

      subsystems.pipeline.use(mw3, { name: 'mw-3', priority: 30 });
      subsystems.pipeline.use(mw1, { name: 'mw-1', priority: 10 });
      subsystems.pipeline.use(mw2, { name: 'mw-2', priority: 20 });

      const ctx = createTestContext();
      const result = await subsystems.pipeline.execute(ctx);

      expect(result.success).toBe(true);
      expect(order).toEqual([1, 2, 3]);
    });

    it('should emit middleware events to eventBus during execution', async () => {
      subsystems = createForgeSubsystems(config);
      const emittedTypes: string[] = [];

      subsystems.eventBus.on('*', (event) => {
        emittedTypes.push(event.type);
      });

      const noop: MiddlewareFn = async (_ctx, next) => { return next(); };
      subsystems.pipeline.use(noop, { name: 'noop-mw', priority: 10 });

      const ctx = createTestContext();
      await subsystems.pipeline.execute(ctx);

      expect(emittedTypes).toContain('middleware_enter');
      expect(emittedTypes).toContain('middleware_exit');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. destroyForgeSubsystems — cleanup verification
  // ═════════════════════════════════════════════════════════════════════════

  describe('destroyForgeSubsystems cleanup', () => {
    it('should remove all eventBus listeners after destroy', async () => {
      subsystems = createForgeSubsystems(config);

      // Dashboard subscription adds listeners; verify they exist
      expect(subsystems.eventBus.listenerCount).toBeGreaterThan(0);

      await destroyForgeSubsystems(subsystems);

      expect(subsystems.eventBus.listenerCount).toBe(0);
      subsystems = undefined; // prevent double-destroy in afterEach
    });

    it('should clear pipeline middleware after destroy', async () => {
      subsystems = createForgeSubsystems(config);
      const noop: MiddlewareFn = async (_ctx, next) => { return next(); };
      subsystems.pipeline.use(noop, { name: 'to-be-cleared', priority: 10 });

      expect(subsystems.pipeline.size).toBe(1);

      await destroyForgeSubsystems(subsystems);

      expect(subsystems.pipeline.size).toBe(0);
      subsystems = undefined;
    });

    it('should dispose semaphore (reject queued waiters)', async () => {
      subsystems = createForgeSubsystems(config);
      const disposeSpy = vi.spyOn(subsystems.semaphore, 'dispose');

      await destroyForgeSubsystems(subsystems);

      expect(disposeSpy).toHaveBeenCalledOnce();
      disposeSpy.mockRestore();
      subsystems = undefined;
    });

    it('should dispose dashboard', async () => {
      subsystems = createForgeSubsystems(config);
      const disposeSpy = vi.spyOn(subsystems.dashboard, 'dispose');

      await destroyForgeSubsystems(subsystems);

      expect(disposeSpy).toHaveBeenCalledOnce();
      disposeSpy.mockRestore();
      subsystems = undefined;
    });

    it('should dispose memory (flush pending saves)', async () => {
      subsystems = createForgeSubsystems(config);
      const disposeSpy = vi.spyOn(subsystems.memory, 'dispose');

      await destroyForgeSubsystems(subsystems);

      expect(disposeSpy).toHaveBeenCalledOnce();
      disposeSpy.mockRestore();
      subsystems = undefined;
    });

    it('should dispose configManager', async () => {
      subsystems = createForgeSubsystems(config);
      const disposeSpy = vi.spyOn(subsystems.configManager, 'dispose');

      await destroyForgeSubsystems(subsystems);

      expect(disposeSpy).toHaveBeenCalledOnce();
      disposeSpy.mockRestore();
      subsystems = undefined;
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. Full lifecycle: create → use → execute → destroy
  // ═════════════════════════════════════════════════════════════════════════

  describe('full create → register → execute → destroy lifecycle', () => {
    it('should complete the full lifecycle without errors', async () => {
      // Create
      subsystems = createForgeSubsystems(config);

      // Verify all 6 subsystems
      expect(Object.keys(subsystems)).toHaveLength(6);

      // Register middleware
      const executed = vi.fn();
      const mw: MiddlewareFn = async (ctx, next) => {
        executed();
        ctx.state['lifecycle-marker'] = 'done';
        return next();
      };
      subsystems.pipeline.use(mw, { name: 'lifecycle-mw', priority: 10 });

      // Execute pipeline
      const ctx = createTestContext();
      const result = await subsystems.pipeline.execute(ctx);
      expect(result.success).toBe(true);
      expect(executed).toHaveBeenCalledOnce();
      expect(result.context.state['lifecycle-marker']).toBe('done');

      // Destroy
      await destroyForgeSubsystems(subsystems);

      // Verify cleanup
      expect(subsystems.eventBus.listenerCount).toBe(0);
      expect(subsystems.pipeline.size).toBe(0);

      subsystems = undefined;
    });

    it('should handle create → destroy without any middleware usage', async () => {
      subsystems = createForgeSubsystems(config);
      await destroyForgeSubsystems(subsystems);

      expect(subsystems.eventBus.listenerCount).toBe(0);
      expect(subsystems.pipeline.size).toBe(0);

      subsystems = undefined;
    });

    it('should handle pipeline execution with no registered middleware', async () => {
      subsystems = createForgeSubsystems(config);

      const ctx = createTestContext();
      const result = await subsystems.pipeline.execute(ctx);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(0);
      expect(result.totalDurationMs).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 5. Cross-subsystem event flow
  // ═════════════════════════════════════════════════════════════════════════

  describe('cross-subsystem event flow', () => {
    it('should bridge semaphore events to eventBus during withLock', async () => {
      subsystems = createForgeSubsystems(config);
      const events: string[] = [];

      subsystems.eventBus.on('*', (event) => {
        if (event.type.startsWith('semaphore_')) {
          events.push(event.type);
        }
      });

      await subsystems.semaphore.withLock(async () => {
        // Just a simple task
        return 'done';
      });

      expect(events).toContain('semaphore_acquire');
      expect(events).toContain('semaphore_release');
    });

    it('should propagate middleware errors as middleware_error events', async () => {
      subsystems = createForgeSubsystems(config);
      const errorEvents: string[] = [];

      subsystems.eventBus.on('middleware_error', (event) => {
        errorEvents.push(event.message);
      });

      const failingMw: MiddlewareFn = async () => {
        throw new Error('intentional-failure');
      };
      subsystems.pipeline.use(failingMw, {
        name: 'failing-mw',
        priority: 10,
        continueOnError: true,
      });

      const ctx = createTestContext();
      await subsystems.pipeline.execute(ctx);

      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(errorEvents.some(msg => msg.includes('failing-mw'))).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 6. Multiple create/destroy cycles
  // ═════════════════════════════════════════════════════════════════════════

  describe('multiple lifecycle cycles', () => {
    it('should support create → destroy → create → destroy without leaks', async () => {
      // First cycle
      const sub1 = createForgeSubsystems(config);
      const noop: MiddlewareFn = async (_ctx, next) => { return next(); };
      sub1.pipeline.use(noop, { name: 'cycle-1', priority: 10 });
      await destroyForgeSubsystems(sub1);
      expect(sub1.eventBus.listenerCount).toBe(0);

      // Second cycle
      const sub2 = createForgeSubsystems(config);
      sub2.pipeline.use(noop, { name: 'cycle-2', priority: 10 });
      const ctx = createTestContext();
      const result = await sub2.pipeline.execute(ctx);
      expect(result.success).toBe(true);
      await destroyForgeSubsystems(sub2);
      expect(sub2.eventBus.listenerCount).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 7. Options passthrough
  // ═════════════════════════════════════════════════════════════════════════

  describe('createForgeSubsystems with options', () => {
    it('should pass projectId and title to dashboard', () => {
      subsystems = createForgeSubsystems(config, {
        projectId: 'my-project',
        title: 'My Session',
      });

      const state = subsystems.dashboard.getState();
      expect(state.projectId).toBe('my-project');
      expect(state.title).toBe('My Session');
    });

    it('should use defaults when options are omitted', () => {
      subsystems = createForgeSubsystems(config);

      const state = subsystems.dashboard.getState();
      expect(state.projectId).toBe('deepforge');
      expect(state.title).toBe('DeepForge Session');
    });
  });
});
