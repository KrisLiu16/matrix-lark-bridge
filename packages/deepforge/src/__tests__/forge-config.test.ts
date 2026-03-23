/**
 * DeepForge 2.0 — ForgeConfigManager Unit Tests
 *
 * Covers: constructor, loadFromObject/loadFromFile, validate, migrate,
 * env overrides, applyOverride+TTL, deepMerge, change tracking,
 * snapshot/rollback, deepEqual utility.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs — all methods used by ForgeConfigManager
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));

// Mock node:path — passthrough so path logic works but calls are interceptable
vi.mock('node:path', () => ({
  resolve: vi.fn((...args: string[]) => args[args.length - 1]),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/') || '/'),
  join: vi.fn((...segments: string[]) => segments.join('/')),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { ForgeConfigManager, DEFAULT_CONFIG, CURRENT_VERSION } from '../forge-config';
import type {
  ForgeConfig,
  DeepPartial,
  ConfigPropertyChange,
  ConfigPreset,
} from '../types/config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal v1.0 config object for migration tests. */
function makeV10Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    project: {
      model: 'claude-sonnet-4-20250514',
      effort: 'medium',
      maxConcurrent: 3,
      maxIterations: 5,
      costLimitUsd: 20,
    },
    ...overrides,
  };
}

/** Create a minimal v1.1 config object. */
function makeV11Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.1',
    project: {
      model: 'claude-sonnet-4-20250514',
      effort: 'medium',
      maxConcurrent: 3,
      maxIterations: 5,
      costLimitUsd: 20,
    },
    middleware: {
      contextEnrichment: { enabled: false, order: 10, params: {} },
      memory: { enabled: false, order: 20, params: {} },
      qualityGate: { enabled: true, order: 30, params: {} },
      concurrencyLimit: { enabled: false, order: 40, params: {} },
      logging: { enabled: true, order: 50, params: {} },
    },
    memory: {
      enabled: false,
      storagePath: '.deepforge/memory.json',
      maxEntries: 200,
      debounceMs: 30000,
      pruneConfidenceThreshold: 0.3,
      pruneRelevanceThreshold: 0.1,
      autoExtract: false,
      injectionCount: 15,
      injectionEnabled: true,
      maxInjectionTokens: 2000,
    },
    ...overrides,
  };
}

/** Create a valid v2.0 partial config. */
function makeV20Partial(overrides: DeepPartial<ForgeConfig> = {}): Record<string, unknown> {
  return {
    version: '2.0',
    project: {
      model: 'claude-sonnet-4-20250514',
      effort: 'high',
      maxConcurrent: 5,
      maxIterations: 10,
      costLimitUsd: 50,
    },
    ...overrides,
  } as Record<string, unknown>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ForgeConfigManager', () => {
  let mgr: ForgeConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new ForgeConfigManager();
  });

  afterEach(() => {
    mgr.dispose();
    vi.restoreAllMocks();
  });

  // ── 1. Constructor + Defaults ────────────────────────────────────────────

  describe('constructor & defaults', () => {
    it('should initialize with DEFAULT_CONFIG when no arg provided', () => {
      const cfg = mgr.get();
      expect(cfg.version).toBe(CURRENT_VERSION);
      expect(cfg.project.model).toBe('claude-sonnet-4-20250514');
      expect(cfg.project.maxIterations).toBe(10);
      expect(cfg.memory.enabled).toBe(true);
      expect(cfg.events.bufferSize).toBe(500);
      expect(cfg.concurrency.maxWorkers).toBe(5);
      expect(cfg.quality.passThreshold).toBe(0.7);
    });

    it('should deep-merge partial initial config onto defaults', () => {
      const custom = new ForgeConfigManager({
        project: { maxIterations: 50 },
        memory: { maxEntries: 1000 },
      });
      const cfg = custom.get();
      expect(cfg.project.maxIterations).toBe(50);
      expect(cfg.project.model).toBe('claude-sonnet-4-20250514'); // default preserved
      expect(cfg.memory.maxEntries).toBe(1000);
      expect(cfg.memory.debounceMs).toBe(30_000); // default preserved
      custom.dispose();
    });

    it('should return a clone from get(), not internal reference', () => {
      const cfg1 = mgr.get();
      const cfg2 = mgr.get();
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).not.toBe(cfg2);
    });

    it('should expose read-only ref via getRef()', () => {
      const ref = mgr.getRef();
      expect(ref.version).toBe(CURRENT_VERSION);
      expect(ref.project.model).toBe('claude-sonnet-4-20250514');
      // Same object on repeated calls (reference, not clone)
      const ref2 = mgr.getRef();
      expect(ref).toBe(ref2);
    });
  });

  // ── 2. loadFromObject / loadFromFile ─────────────────────────────────────

  describe('loadFromObject', () => {
    it('should load a valid v2.0 config', () => {
      const result = mgr.loadFromObject(makeV20Partial());
      expect(result.valid).toBe(true);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    });

    it('should merge loaded config with defaults', () => {
      mgr.loadFromObject(makeV20Partial({
        project: { costLimitUsd: 100 },
      }));
      const cfg = mgr.get();
      expect(cfg.project.costLimitUsd).toBe(100);
      expect(cfg.notifications.onPhaseChange).toBe(true); // default
    });

    it('should reject invalid config and keep old state', () => {
      const before = mgr.get();
      const result = mgr.loadFromObject({
        version: '2.0',
        project: {
          model: 123, // wrong type
          effort: 'invalid_effort',
          maxConcurrent: -5,
          maxIterations: 10,
          costLimitUsd: 50,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Config should remain unchanged
      expect(mgr.get()).toEqual(before);
    });
  });

  describe('loadFromFile', () => {
    it('should return valid result when file does not exist (uses defaults)', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(resolve).mockReturnValue('/tmp/nonexistent.json');
      const result = mgr.loadFromFile('/tmp/nonexistent.json');
      expect(result.valid).toBe(true);
    });

    it('should load and parse valid JSON file', () => {
      const configData = JSON.stringify(makeV20Partial({ project: { costLimitUsd: 99 } }));
      vi.mocked(resolve).mockReturnValue('/tmp/forge.json');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(configData);

      const result = mgr.loadFromFile('/tmp/forge.json');
      expect(result.valid).toBe(true);
      expect(mgr.get().project.costLimitUsd).toBe(99);
    });

    it('should return error for malformed JSON', () => {
      vi.mocked(resolve).mockReturnValue('/tmp/bad.json');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('not json {{{');

      const result = mgr.loadFromFile('/tmp/bad.json');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Failed to parse');
    });
  });

  // ── 3. validate() ───────────────────────────────────────────────────────

  describe('validate', () => {
    it('should pass for a valid DEFAULT_CONFIG', () => {
      const result = mgr.validate(DEFAULT_CONFIG as unknown as Record<string, unknown>);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should catch missing required fields', () => {
      const result = mgr.validate({ version: '2.0' });
      expect(result.valid).toBe(false);
      const missingProject = result.errors.find(e => e.path === 'project');
      expect(missingProject).toBeDefined();
      expect(missingProject!.message).toContain('required');
    });

    it('should catch type mismatches', () => {
      const broken = {
        ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        project: {
          ...DEFAULT_CONFIG.project,
          maxConcurrent: 'not a number',
        },
      };
      const result = mgr.validate(broken);
      expect(result.valid).toBe(false);
      const typeErr = result.errors.find(e => e.path === 'project.maxConcurrent');
      expect(typeErr).toBeDefined();
    });

    it('should catch enum violations', () => {
      const broken = {
        ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        project: {
          ...DEFAULT_CONFIG.project,
          effort: 'turbo',
        },
      };
      const result = mgr.validate(broken);
      expect(result.valid).toBe(false);
      const enumErr = result.errors.find(e => e.path === 'project.effort');
      expect(enumErr).toBeDefined();
      expect(enumErr!.message).toContain('one of');
    });

    it('should catch number range violations', () => {
      const broken = {
        ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        concurrency: {
          ...DEFAULT_CONFIG.concurrency,
          maxWorkers: 999,
        },
      };
      const result = mgr.validate(broken);
      expect(result.valid).toBe(false);
      const rangeErr = result.errors.find(e => e.path === 'concurrency.maxWorkers');
      expect(rangeErr).toBeDefined();
      expect(rangeErr!.message).toContain('exceeds maximum');
    });

    it('should run custom validators', () => {
      const unsub = mgr.addValidator((cfg) => {
        if ((cfg as any).project?.costLimitUsd! > 100) {
          return 'Cost limit too high';
        }
        return null;
      });

      const expensive = {
        ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        project: { ...DEFAULT_CONFIG.project, costLimitUsd: 200 },
      };
      const result = mgr.validate(expensive);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message === 'Cost limit too high')).toBe(true);

      unsub();
      const result2 = mgr.validate(expensive);
      expect(result2.valid).toBe(true);
    });

    it('should include validatedVersion and validatedAt', () => {
      const result = mgr.validate(DEFAULT_CONFIG as unknown as Record<string, unknown>);
      expect(result.validatedVersion).toBe('2.0');
      expect(typeof result.validatedAt).toBe('string');
      // validatedAt should be a parseable ISO date
      expect(new Date(result.validatedAt).getTime()).not.toBeNaN();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── 4. Version Migration ────────────────────────────────────────────────

  describe('migrate', () => {
    it('should migrate v1.0 → v2.0 via loadFromObject', () => {
      const result = mgr.loadFromObject(makeV10Config());
      expect(result.valid).toBe(true);
      const cfg = mgr.get();
      expect(cfg.version).toBe('2.0');
      expect(cfg.middleware).toBeDefined();
      expect(cfg.events).toBeDefined();
      expect(cfg.concurrency).toBeDefined();
      expect(cfg.quality).toBeDefined();
      expect(cfg.notifications).toBeDefined();
    });

    it('should migrate v1.1 → v2.0 via loadFromObject', () => {
      const result = mgr.loadFromObject(makeV11Config());
      expect(result.valid).toBe(true);
      const cfg = mgr.get();
      expect(cfg.version).toBe('2.0');
      // v1.1→v2.0 enables contextEnrichment and memory
      expect(cfg.middleware.contextEnrichment.enabled).toBe(true);
      expect(cfg.middleware.memory.enabled).toBe(true);
    });

    it('should preserve project settings across migration', () => {
      const v10 = makeV10Config({ project: { model: 'custom-model', effort: 'low', maxConcurrent: 2, maxIterations: 3, costLimitUsd: 10 } });
      mgr.loadFromObject(v10);
      const cfg = mgr.get();
      expect(cfg.project.model).toBe('custom-model');
      expect(cfg.project.effort).toBe('low');
    });

    it('should handle already-v2.0 config without migration', () => {
      const result = mgr.loadFromObject(makeV20Partial());
      expect(result.valid).toBe(true);
      expect(mgr.get().version).toBe('2.0');
    });
  });

  // ── 5. Environment Variable Overrides ───────────────────────────────────

  describe('env overrides', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should apply FORGE_PROJECT_MAX_CONCURRENT env var', () => {
      process.env.FORGE_PROJECT_MAX_CONCURRENT = '8';
      mgr.loadFromObject(makeV20Partial());
      expect(mgr.get().project.maxConcurrent).toBe(8);
    });

    it('should coerce boolean env var', () => {
      process.env.FORGE_MEMORY_ENABLED = 'false';
      mgr.loadFromObject(makeV20Partial());
      expect(mgr.get().memory.enabled).toBe(false);
    });

    it('should coerce "1" to true for boolean', () => {
      process.env.FORGE_MEMORY_AUTO_EXTRACT = '1';
      mgr.loadFromObject(makeV20Partial());
      expect(mgr.get().memory.autoExtract).toBe(true);
    });

    it('should apply string env var', () => {
      process.env.FORGE_PROJECT_MODEL = 'gpt-4o';
      mgr.loadFromObject(makeV20Partial());
      expect(mgr.get().project.model).toBe('gpt-4o');
    });

    it('should ignore unknown FORGE_ env vars', () => {
      process.env.FORGE_UNKNOWN_KEY = 'something';
      const before = mgr.get();
      const result = mgr.loadFromObject(makeV20Partial());
      expect(result.valid).toBe(true);
      // Config should not contain the unknown key
      const after = mgr.get();
      expect((after as any).unknown).toBeUndefined();
      expect((after as any).unknownKey).toBeUndefined();
      // Core fields remain intact
      expect(after.project.model).toBe('claude-sonnet-4-20250514');
    });

    it('should ignore non-FORGE_ env vars', () => {
      process.env.NODE_ENV = 'test';
      process.env.HOME = '/home/user';
      process.env.MY_CUSTOM_VAR = '42';
      const result = mgr.loadFromObject(makeV20Partial());
      expect(result.valid).toBe(true);
      // Non-FORGE_ vars should not affect config values
      const cfg = mgr.get();
      expect(cfg.project.maxConcurrent).toBe(5); // from makeV20Partial
      expect(cfg.version).toBe('2.0');
    });

    it('should not apply NaN for number fields', () => {
      process.env.FORGE_PROJECT_MAX_CONCURRENT = 'not_a_number';
      mgr.loadFromObject(makeV20Partial());
      // Should keep existing value since NaN → fallback
      expect(mgr.get().project.maxConcurrent).toBe(5);
    });
  });

  // ── 6. Runtime Overrides + TTL ──────────────────────────────────────────

  describe('applyOverride', () => {
    it('should override a single path', () => {
      const result = mgr.applyOverride('project.maxIterations', 20);
      expect(result.valid).toBe(true);
      expect(mgr.get().project.maxIterations).toBe(20);
    });

    it('should reject invalid override value', () => {
      const result = mgr.applyOverride('project.maxConcurrent', -5);
      expect(result.valid).toBe(false);
      // Original value preserved
      expect(mgr.get().project.maxConcurrent).toBe(5);
    });

    it('should track override source', () => {
      mgr.applyOverride('project.costLimitUsd', 100, 'cli');
      const overrides = mgr.getOverrides();
      expect(overrides).toHaveLength(1);
      expect(overrides[0].source).toBe('cli');
      expect(overrides[0].path).toBe('project.costLimitUsd');
      expect(overrides[0].value).toBe(100);
    });

    it('should support TTL on overrides', () => {
      mgr.applyOverride('project.maxIterations', 99, 'api', 5000);
      const overrides = mgr.getOverrides();
      expect(overrides[0].ttlMs).toBe(5000);
    });

    it('should accumulate multiple overrides', () => {
      mgr.applyOverride('project.maxIterations', 20);
      mgr.applyOverride('project.costLimitUsd', 100);
      expect(mgr.getOverrides()).toHaveLength(2);
      expect(mgr.get().project.maxIterations).toBe(20);
      expect(mgr.get().project.costLimitUsd).toBe(100);
    });

    it('should prune expired TTL overrides', () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

      // Apply with 1ms TTL (already expired)
      mgr.applyOverride('project.maxIterations', 99, 'api', 1);

      // Advance time
      dateSpy.mockReturnValue(now + 100);

      // Mock fs to prevent reload
      vi.mocked(existsSync).mockReturnValue(false);

      const pruned = mgr.pruneExpiredOverrides();
      expect(pruned).toBe(1);
      expect(mgr.getOverrides()).toHaveLength(0);

      dateSpy.mockRestore();
    });

    it('should not prune permanent (ttlMs=0) overrides', () => {
      mgr.applyOverride('project.maxIterations', 20, 'api', 0);
      vi.mocked(existsSync).mockReturnValue(false);
      const pruned = mgr.pruneExpiredOverrides();
      expect(pruned).toBe(0);
      expect(mgr.getOverrides()).toHaveLength(1);
    });

    it('should clear all overrides and revert to defaults', () => {
      mgr.applyOverride('project.maxIterations', 99);
      vi.mocked(existsSync).mockReturnValue(false);
      mgr.clearOverrides();
      expect(mgr.getOverrides()).toHaveLength(0);
      expect(mgr.get().project.maxIterations).toBe(DEFAULT_CONFIG.project.maxIterations);
    });
  });

  // ── 7. deepMerge ────────────────────────────────────────────────────────

  describe('deepMerge (via update)', () => {
    it('should deep-merge nested objects', () => {
      const result = mgr.update({
        project: { costLimitUsd: 200 },
      });
      expect(result.valid).toBe(true);
      const cfg = mgr.get();
      expect(cfg.project.costLimitUsd).toBe(200);
      expect(cfg.project.model).toBe('claude-sonnet-4-20250514'); // preserved
    });

    it('should overwrite primitive values', () => {
      mgr.update({ quality: { passThreshold: 0.9 } });
      expect(mgr.get().quality.passThreshold).toBe(0.9);
    });

    it('should not mutate the original config', () => {
      const before = mgr.get();
      mgr.update({ project: { maxIterations: 100 } });
      const after = mgr.get();
      expect(before.project.maxIterations).toBe(10);
      expect(after.project.maxIterations).toBe(100);
    });

    it('should reject invalid partial update', () => {
      const before = mgr.get();
      const result = mgr.update({
        project: { effort: 'turbo' as any },
      });
      expect(result.valid).toBe(false);
      expect(mgr.get()).toEqual(before);
    });
  });

  // ── 8. Change Tracking ──────────────────────────────────────────────────

  describe('change tracking', () => {
    it('should record changes on loadFromObject', () => {
      mgr.loadFromObject(makeV20Partial({ project: { costLimitUsd: 999 } }));
      const history = mgr.getChangeHistory();
      // Should have at least the costLimitUsd change but could be more due to migration source
      expect(history.length).toBeGreaterThan(0);
    });

    it('should record changes on update', () => {
      mgr.update({ project: { maxIterations: 77 } });
      const history = mgr.getChangeHistory();
      const iterChange = history.find(c => c.path === 'project.maxIterations');
      expect(iterChange).toBeDefined();
      expect(iterChange!.oldValue).toBe(10);
      expect(iterChange!.newValue).toBe(77);
      expect(iterChange!.source).toBe('api');
    });

    it('should record changes on applyOverride', () => {
      mgr.applyOverride('project.costLimitUsd', 200, 'cli');
      const history = mgr.getChangeHistory();
      const costChange = history.find(c => c.path === 'project.costLimitUsd' && c.source === 'cli');
      expect(costChange).toBeDefined();
      expect(costChange!.newValue).toBe(200);
    });

    it('should notify listeners on change', () => {
      const listener = vi.fn();
      mgr.onChange(listener);
      mgr.update({ project: { maxIterations: 42 } });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ project: expect.objectContaining({ maxIterations: 42 }) }),
        expect.objectContaining({ project: expect.objectContaining({ maxIterations: 10 }) }),
        expect.arrayContaining(['project.maxIterations']),
      );
    });

    it('should unsubscribe listener', () => {
      const listener = vi.fn();
      const unsub = mgr.onChange(listener);
      unsub();
      mgr.update({ project: { maxIterations: 42 } });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should not crash if listener throws', () => {
      mgr.onChange(() => { throw new Error('boom'); });
      expect(() => {
        mgr.update({ project: { maxIterations: 42 } });
      }).not.toThrow();
      expect(mgr.get().project.maxIterations).toBe(42);
    });

    it('should not record changes when values are identical', () => {
      mgr.update({ project: { maxIterations: DEFAULT_CONFIG.project.maxIterations } });
      const history = mgr.getChangeHistory();
      const iterChanges = history.filter(c => c.path === 'project.maxIterations');
      expect(iterChanges).toHaveLength(0);
    });

    it('should cap change history at 500 entries', () => {
      for (let i = 0; i < 510; i++) {
        mgr.update({ project: { costLimitUsd: i } });
      }
      const history = mgr.getChangeHistory();
      expect(history.length).toBeLessThanOrEqual(500);
    });
  });

  // ── 9. Snapshot / Rollback ──────────────────────────────────────────────

  describe('snapshot & rollback', () => {
    it('should create a snapshot and return an id', () => {
      const id = mgr.snapshot('before-change');
      expect(id).toMatch(/^snap-/);
    });

    it('should list snapshots', () => {
      mgr.snapshot('s1');
      mgr.snapshot('s2');
      const list = mgr.listSnapshots();
      expect(list).toHaveLength(2);
      expect(list[0].label).toBe('s1');
      expect(list[1].label).toBe('s2');
    });

    it('should rollback to a snapshot', () => {
      const id = mgr.snapshot('baseline');
      mgr.update({ project: { maxIterations: 99 } });
      expect(mgr.get().project.maxIterations).toBe(99);

      const result = mgr.rollback(id);
      expect(result.valid).toBe(true);
      expect(mgr.get().project.maxIterations).toBe(10); // original default
    });

    it('should preserve snapshot data independently from live config', () => {
      const id = mgr.snapshot();
      mgr.update({ project: { costLimitUsd: 999 } });
      const snaps = mgr.listSnapshots();
      expect(snaps[0].data.project.costLimitUsd).toBe(50); // snapshot value, not 999
    });

    it('should fail rollback for unknown snapshot id', () => {
      const result = mgr.rollback('snap-nonexistent');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('not found');
    });

    it('should record changes on rollback', () => {
      const id = mgr.snapshot();
      mgr.update({ project: { maxIterations: 99 } });
      const historyBefore = mgr.getChangeHistory().length;
      mgr.rollback(id);
      const historyAfter = mgr.getChangeHistory().length;
      expect(historyAfter).toBeGreaterThan(historyBefore);
    });

    it('should cap snapshots at 50', () => {
      for (let i = 0; i < 55; i++) {
        mgr.snapshot(`s${i}`);
      }
      expect(mgr.listSnapshots().length).toBeLessThanOrEqual(50);
    });
  });

  // ── 10. deepEqual utility ───────────────────────────────────────────────

  describe('deepEqual (via change tracking behavior)', () => {
    it('should detect equal primitive values (no change recorded)', () => {
      mgr.update({ project: { maxIterations: 10 } }); // same as default
      const changes = mgr.getChangeHistory().filter(c => c.path === 'project.maxIterations');
      expect(changes).toHaveLength(0);
    });

    it('should detect different primitive values (change recorded)', () => {
      mgr.update({ project: { maxIterations: 11 } });
      const changes = mgr.getChangeHistory().filter(c => c.path === 'project.maxIterations');
      expect(changes).toHaveLength(1);
    });

    it('should handle nested objects correctly', () => {
      // Update with same nested values — no change
      mgr.update({
        middleware: {
          contextEnrichment: { enabled: true, order: 10, params: {} },
        },
      });
      const ceChanges = mgr.getChangeHistory().filter(c => c.path.startsWith('middleware.contextEnrichment'));
      expect(ceChanges).toHaveLength(0);
    });

    it('should detect array differences', () => {
      mgr.update({ events: { allowedTypes: ['error', 'warning'] } });
      const changes = mgr.getChangeHistory().filter(c => c.path === 'events.allowedTypes');
      expect(changes).toHaveLength(1);
    });
  });

  // ── 11. getPath accessor ────────────────────────────────────────────────

  describe('getPath', () => {
    it('should get top-level value', () => {
      expect(mgr.getPath('version')).toBe('2.0');
    });

    it('should get nested value', () => {
      expect(mgr.getPath('project.maxIterations')).toBe(10);
    });

    it('should return undefined for missing path', () => {
      expect(mgr.getPath('nonexistent.path')).toBeUndefined();
    });
  });

  // ── 12. Preset Application ─────────────────────────────────────────────

  describe('preset application', () => {
    const speedPreset: ConfigPreset = {
      name: 'speed',
      description: 'Optimize for speed',
      config: {
        project: { maxConcurrent: 10, maxIterations: 5 },
        quality: { maxAutoRetries: 0 },
      },
      tags: ['speed'],
    };

    it('should apply preset via applyPreset', () => {
      const result = mgr.applyPreset(speedPreset);
      expect(result.valid).toBe(true);
      expect(mgr.get().project.maxConcurrent).toBe(10);
      expect(mgr.get().quality.maxAutoRetries).toBe(0);
    });

    it('should preserve non-preset values', () => {
      mgr.applyPreset(speedPreset);
      expect(mgr.get().memory.enabled).toBe(true); // default preserved
    });

    it('should reset and apply via resetToPreset', () => {
      mgr.update({ project: { costLimitUsd: 999 } });
      const result = mgr.resetToPreset(speedPreset);
      expect(result.valid).toBe(true);
      expect(mgr.get().project.maxConcurrent).toBe(10);
      expect(mgr.get().project.costLimitUsd).toBe(DEFAULT_CONFIG.project.costLimitUsd); // reset to default
    });
  });

  // ── 13. saveToFile ─────────────────────────────────────────────────────

  describe('saveToFile', () => {
    it('should write config JSON to file', () => {
      vi.mocked(writeFileSync).mockImplementation(() => {});
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(resolve).mockReturnValue('/tmp/out.json');
      vi.mocked(dirname).mockReturnValue('/tmp');

      mgr.saveToFile('/tmp/out.json');
      expect(writeFileSync).toHaveBeenCalledWith(
        '/tmp/out.json',
        expect.stringContaining('"version"'),
        'utf-8',
      );
    });

    it('should throw when no file path specified', () => {
      expect(() => mgr.saveToFile()).toThrow('No file path');
    });

    it('should create directory if needed', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(mkdirSync).mockImplementation(() => '' as any);
      vi.mocked(writeFileSync).mockImplementation(() => {});
      vi.mocked(resolve).mockReturnValue('/deep/nested/out.json');
      vi.mocked(dirname).mockReturnValue('/deep/nested');

      mgr.saveToFile('/deep/nested/out.json');
      expect(mkdirSync).toHaveBeenCalledWith('/deep/nested', { recursive: true });
    });
  });

  // ── 14. Watch / Unwatch ────────────────────────────────────────────────

  describe('watch / unwatch', () => {
    it('should throw if no file loaded', () => {
      expect(() => mgr.watch()).toThrow('No file path to watch');
    });

    it('should set isWatching flag', () => {
      vi.mocked(resolve).mockReturnValue('/tmp/config.json');
      vi.mocked(existsSync).mockReturnValue(false);
      mgr.loadFromFile('/tmp/config.json');

      vi.mocked(watch).mockReturnValue({
        on: vi.fn(),
        close: vi.fn(),
      } as any);

      expect(mgr.isWatching).toBe(false);
      mgr.watch();
      expect(mgr.isWatching).toBe(true);
      mgr.unwatch();
      expect(mgr.isWatching).toBe(false);
    });

    it('should not start watching twice', () => {
      vi.mocked(resolve).mockReturnValue('/tmp/config.json');
      vi.mocked(existsSync).mockReturnValue(false);
      mgr.loadFromFile('/tmp/config.json');

      vi.mocked(watch).mockReturnValue({
        on: vi.fn(),
        close: vi.fn(),
      } as any);

      mgr.watch();
      mgr.watch(); // second call should be no-op
      expect(watch).toHaveBeenCalledTimes(1);
    });
  });

  // ── 15. Dispose ────────────────────────────────────────────────────────

  describe('runtime cast validation guards (Critic-17 K1)', () => {
    it('should gracefully handle null constructor input by using defaults', () => {
      // null is falsy, so the constructor uses DEFAULT_CONFIG — toRecord() is never called
      const m = new ForgeConfigManager(null as unknown as DeepPartial<ForgeConfig>);
      const cfg = m.getRef();
      expect(cfg.version).toBeDefined();
      expect(cfg.project).toBeDefined();
    });

    it('should throw TypeError when update receives undefined', () => {
      // toRecord() guard: undefined is not a valid config object
      expect(() => mgr.update(undefined as unknown as DeepPartial<ForgeConfig>))
        .toThrow(TypeError);
    });

    it('should heal corrupt input via defaults in loadFromObject (asForgeConfig guard passes because deepMerge supplies version/project)', () => {
      // deepMerge with DEFAULT_CONFIG always provides version and project,
      // so asForgeConfig guard passes. Verify the result is valid.
      const corruptRaw: Record<string, unknown> = {
        version: undefined,
        project: undefined,
      };
      const result = mgr.loadFromObject(corruptRaw as unknown as DeepPartial<ForgeConfig>);
      expect(result.valid).toBe(true);
      const cfg = mgr.getRef();
      expect(cfg.version).toBeDefined();
      expect(cfg.project).toBeDefined();
    });

    it('should throw TypeError when toRecord receives a primitive via constructor', () => {
      // toRecord() guard rejects non-object inputs
      expect(() => new ForgeConfigManager('bad' as unknown as DeepPartial<ForgeConfig>))
        .toThrow(TypeError);
      expect(() => new ForgeConfigManager(42 as unknown as DeepPartial<ForgeConfig>))
        .toThrow(TypeError);
    });
  });

  describe('dispose', () => {
    it('should clean up listeners and validators', () => {
      const listener = vi.fn();
      mgr.onChange(listener);
      mgr.addValidator(() => null);
      mgr.dispose();

      // After dispose, listener should not be called
      mgr.update({ project: { maxIterations: 99 } });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
