/**
 * DeepForge 2.0 — PresetRegistry Unit Tests
 *
 * Covers:
 *  1. Constructor & 5 built-in presets
 *  2. get / list / listIds / has queries
 *  3. extends inheritance resolution
 *  4. Template variable {{var}} substitution
 *  5. Circular inheritance detection
 *  6. exportJSON / importPreset serialization
 *  7. findByTag search
 *  8. register custom preset
 *  9. Built-in preset memory field validation (maxEntries/storagePath/debounceMs)
 * 10. remove preset
 * 11. resolve with overrideVars
 * 12. Validation & validators
 * 13. Singleton access (getPresetRegistry / resetPresetRegistry)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PresetRegistry,
  getPresetRegistry,
  resetPresetRegistry,
  type SerializedPreset,
} from '../forge-presets';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BUILTIN_IDS = ['default', 'fast', 'thorough', 'research', 'ci'];

function makeCustomPreset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custom-test',
    name: 'Custom Test',
    description: 'A custom test preset',
    tags: ['test', 'custom'],
    config: { project: { effort: 'low' as const } },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PresetRegistry', () => {
  let registry: PresetRegistry;

  beforeEach(() => {
    registry = new PresetRegistry();
  });

  // ── 1. Constructor & built-in presets ─────────────────────────────────────

  describe('constructor & built-in presets', () => {
    it('registers exactly 5 built-in presets', () => {
      expect(registry.listIds()).toHaveLength(5);
    });

    it('contains all expected preset ids', () => {
      for (const id of BUILTIN_IDS) {
        expect(registry.has(id)).toBe(true);
      }
    });

    it('default preset has no extends', () => {
      const def = registry.get('default');
      expect(def).toBeDefined();
      expect(def!.extends).toBeUndefined();
    });

    it('fast, thorough, research, ci all extend default', () => {
      for (const id of ['fast', 'thorough', 'research', 'ci']) {
        expect(registry.get(id)!.extends).toBe('default');
      }
    });
  });

  // ── 2. get / list / listIds / has queries ─────────────────────────────────

  describe('get / list / listIds / has', () => {
    it('get returns preset by id', () => {
      const p = registry.get('fast');
      expect(p).toBeDefined();
      expect(p!.id).toBe('fast');
    });

    it('get returns undefined for unknown id', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('has returns false for unknown id', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('list returns array of ConfigPreset objects', () => {
      const all = registry.list();
      expect(all).toHaveLength(5);
      expect(all.every((p) => typeof p.id === 'string')).toBe(true);
    });

    it('listIds returns array of string ids', () => {
      const ids = registry.listIds();
      expect(ids.sort()).toEqual([...BUILTIN_IDS].sort());
    });
  });

  // ── 3. extends inheritance resolution ─────────────────────────────────────

  describe('extends inheritance resolution', () => {
    it('resolve("default") returns default config directly', () => {
      const cfg = registry.resolve('default');
      expect(cfg.version).toBe('2.0');
      expect(cfg.project?.model).toBe('claude-sonnet-4-20250514');
    });

    it('resolve("fast") merges fast config on top of default', () => {
      const cfg = registry.resolve('fast');
      // fast overrides
      expect(cfg.project?.effort).toBe('medium');
      expect(cfg.project?.maxConcurrent).toBe(10);
      // inherited from default
      expect(cfg.version).toBe('2.0');
      expect(cfg.project?.model).toBe('claude-sonnet-4-20250514');
    });

    it('resolve("thorough") inherits default and overrides quality', () => {
      const cfg = registry.resolve('thorough');
      expect(cfg.quality?.passThreshold).toBe(0.9);
      expect(cfg.quality?.maxAutoRetries).toBe(5);
      // still has default's version
      expect(cfg.version).toBe('2.0');
    });

    it('multi-level inheritance works (child → parent → grandparent)', () => {
      // Register a preset extending "fast"
      registry.register({
        id: 'ultra-fast',
        name: 'Ultra Fast',
        description: 'Even faster than fast',
        tags: ['speed'],
        extends: 'fast',
        config: { project: { maxIterations: 2 } },
      });

      const cfg = registry.resolve('ultra-fast');
      // from ultra-fast
      expect(cfg.project?.maxIterations).toBe(2);
      // from fast
      expect(cfg.project?.effort).toBe('medium');
      expect(cfg.project?.maxConcurrent).toBe(10);
      // from default (grandparent)
      expect(cfg.version).toBe('2.0');
    });

    it('throws for unknown preset id', () => {
      expect(() => registry.resolve('no-such-preset')).toThrow('not found');
    });
  });

  // ── 4. Template variable {{var}} substitution ─────────────────────────────

  describe('template variable substitution', () => {
    it('substitutes {{var}} placeholders in string values', () => {
      registry.register({
        id: 'template-test',
        name: 'Template Test',
        description: 'Tests template variables',
        tags: ['test'],
        variables: { projectName: 'myproject' },
        config: {
          memory: { storagePath: '.deepforge/{{projectName}}/memory' },
        },
      });

      const cfg = registry.resolve('template-test');
      expect(cfg.memory?.storagePath).toBe('.deepforge/myproject/memory');
    });

    it('overrideVars take precedence over preset variables', () => {
      registry.register({
        id: 'var-override',
        name: 'Var Override',
        description: 'Variable override test',
        tags: ['test'],
        variables: { name: 'original' },
        config: {
          memory: { storagePath: '{{name}}/path' },
        },
      });

      const cfg = registry.resolve('var-override', { name: 'overridden' });
      expect(cfg.memory?.storagePath).toBe('overridden/path');
    });

    it('leaves unresolved {{var}} placeholders intact', () => {
      registry.register({
        id: 'unresolved-var',
        name: 'Unresolved',
        description: 'Test unresolved vars',
        tags: ['test'],
        config: {
          memory: { storagePath: '{{unknown}}/path' },
        },
      });

      const cfg = registry.resolve('unresolved-var');
      expect(cfg.memory?.storagePath).toBe('{{unknown}}/path');
    });

    it('substitutes variables inherited from parent chain', () => {
      registry.register({
        id: 'parent-vars',
        name: 'Parent Vars',
        description: 'Parent with vars',
        tags: ['test'],
        variables: { env: 'production' },
        config: {
          memory: { storagePath: '{{env}}/mem' },
        },
      });

      registry.register({
        id: 'child-vars',
        name: 'Child Vars',
        description: 'Child inheriting vars',
        tags: ['test'],
        extends: 'parent-vars',
        config: {},
      });

      const cfg = registry.resolve('child-vars');
      expect(cfg.memory?.storagePath).toBe('production/mem');
    });
  });

  // ── 5. Circular inheritance detection ─────────────────────────────────────

  describe('circular inheritance detection', () => {
    it('throws on self-referencing extends', () => {
      // Manually set up a circular reference by overwriting
      const p = registry.get('default')!;
      (p as any).extends = 'default';
      expect(() => registry.resolve('default')).toThrow(/[Cc]ircular/);
      // Clean up
      delete (p as any).extends;
    });

    it('throws on A → B → A cycle', () => {
      registry.register({
        id: 'cycle-a',
        name: 'Cycle A',
        description: 'Cycle test A',
        tags: ['test'],
        config: {},
      });
      registry.register({
        id: 'cycle-b',
        name: 'Cycle B',
        description: 'Cycle test B',
        tags: ['test'],
        extends: 'cycle-a',
        config: {},
      });
      // Create cycle
      const a = registry.get('cycle-a')!;
      (a as any).extends = 'cycle-b';

      expect(() => registry.resolve('cycle-a')).toThrow(/[Cc]ircular/);
    });
  });

  // ── 6. exportJSON / importPreset serialization ────────────────────────────

  describe('exportJSON / importPreset', () => {
    it('exportJSON returns valid JSON string', () => {
      const json = registry.exportJSON('default');
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('exported preset contains expected fields', () => {
      const json = registry.exportJSON('fast');
      const data: SerializedPreset = JSON.parse(json);
      expect(data.name).toBe('fast');
      expect(data.description).toBeTruthy();
      expect(Array.isArray(data.tags)).toBe(true);
      expect(data.extends).toBe('default');
      expect(data.config).toBeDefined();
    });

    it('exportJSON throws for unknown preset', () => {
      expect(() => registry.exportJSON('nonexistent')).toThrow('not found');
    });

    it('importPreset from JSON string registers the preset', () => {
      const json = registry.exportJSON('fast');
      const data: SerializedPreset = JSON.parse(json);
      data.name = 'imported-fast';

      registry.importPreset(JSON.stringify(data));
      expect(registry.has('imported-fast')).toBe(true);
    });

    it('importPreset from object registers the preset', () => {
      const data: SerializedPreset = {
        name: 'from-obj',
        description: 'Imported from object',
        tags: ['imported'],
        config: { project: { effort: 'low' } },
      };

      registry.importPreset(data);
      expect(registry.has('from-obj')).toBe(true);
      expect(registry.get('from-obj')!.description).toBe('Imported from object');
    });

    it('round-trip export → import preserves config', () => {
      const json = registry.exportJSON('thorough');
      const data: SerializedPreset = JSON.parse(json);
      data.name = 'thorough-copy';

      registry.importPreset(data);
      const original = registry.resolve('thorough');
      const copy = registry.resolve('thorough-copy');

      // Both should have the same quality settings
      expect(copy.quality?.passThreshold).toBe(original.quality?.passThreshold);
      expect(copy.quality?.maxAutoRetries).toBe(original.quality?.maxAutoRetries);
    });

    it('exportAll returns JSON array of all presets', () => {
      const json = registry.exportAll();
      const arr = JSON.parse(json);
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.length).toBe(5);
    });
  });

  // ── 7. findByTag search ───────────────────────────────────────────────────

  describe('findByTag', () => {
    it('finds presets with matching tag', () => {
      const speed = registry.findByTag('speed');
      expect(speed.length).toBeGreaterThanOrEqual(1);
      expect(speed.some((p) => p.id === 'fast')).toBe(true);
    });

    it('returns empty array for non-matching tag', () => {
      expect(registry.findByTag('nonexistent-tag')).toHaveLength(0);
    });

    it('finds multiple presets sharing a tag', () => {
      const quality = registry.findByTag('quality');
      expect(quality.some((p) => p.id === 'thorough')).toBe(true);
    });

    it('ci preset is found by "ci" and "automation" tags', () => {
      expect(registry.findByTag('ci').some((p) => p.id === 'ci')).toBe(true);
      expect(registry.findByTag('automation').some((p) => p.id === 'ci')).toBe(true);
    });
  });

  // ── 8. register custom preset ────────────────────────────────────────────

  describe('register custom preset', () => {
    it('registers a valid custom preset', () => {
      registry.register(makeCustomPreset());
      expect(registry.has('custom-test')).toBe(true);
    });

    it('overwrites existing preset with same id', () => {
      registry.register(makeCustomPreset({ description: 'first' }));
      registry.register(makeCustomPreset({ description: 'second' }));
      expect(registry.get('custom-test')!.description).toBe('second');
    });

    it('rejects preset without id', () => {
      expect(() =>
        registry.register(makeCustomPreset({ id: '' })),
      ).toThrow(/id/i);
    });

    it('rejects preset with invalid id format (uppercase)', () => {
      expect(() =>
        registry.register(makeCustomPreset({ id: 'BadName' })),
      ).toThrow(/id/i);
    });

    it('rejects preset with id starting with hyphen', () => {
      expect(() =>
        registry.register(makeCustomPreset({ id: '-bad' })),
      ).toThrow(/id/i);
    });

    it('rejects preset without description', () => {
      expect(() =>
        registry.register(makeCustomPreset({ description: '' })),
      ).toThrow(/description/i);
    });

    it('rejects preset with non-array tags', () => {
      expect(() =>
        registry.register(makeCustomPreset({ tags: 'not-array' })),
      ).toThrow(/tags/i);
    });

    it('rejects preset extending nonexistent parent', () => {
      expect(() =>
        registry.register(makeCustomPreset({ extends: 'no-such-parent' })),
      ).toThrow(/not found/i);
    });

    it('accepts preset extending existing parent', () => {
      expect(() =>
        registry.register(makeCustomPreset({ extends: 'default' })),
      ).not.toThrow();
    });
  });

  // ── 9. Built-in preset memory field validation ────────────────────────────

  describe('built-in preset memory field names', () => {
    const VALID_MEMORY_FIELDS = ['enabled', 'maxEntries', 'storagePath', 'debounceMs'];
    const OLD_FIELD_NAMES = ['maxItems', 'filePath', 'saveInterval', 'path', 'limit'];

    it('default preset uses correct memory field names', () => {
      const mem = registry.get('default')!.config.memory as Record<string, unknown>;
      expect(mem).toBeDefined();
      // Has correct fields
      expect(mem.maxEntries).toBeDefined();
      expect(mem.storagePath).toBeDefined();
      expect(mem.debounceMs).toBeDefined();
      // Does not have old field names
      for (const old of OLD_FIELD_NAMES) {
        expect(mem[old]).toBeUndefined();
      }
    });

    it('fast preset memory uses debounceMs (not saveInterval)', () => {
      const mem = registry.get('fast')!.config.memory as Record<string, unknown>;
      expect(mem).toBeDefined();
      expect(mem.debounceMs).toBeDefined();
      expect(mem.saveInterval).toBeUndefined();
    });

    it('thorough preset memory uses maxEntries (not maxItems)', () => {
      const mem = registry.get('thorough')!.config.memory as Record<string, unknown>;
      expect(mem).toBeDefined();
      expect(mem.maxEntries).toBeDefined();
      expect(mem.maxItems).toBeUndefined();
    });

    it('research preset memory uses all correct field names', () => {
      const mem = registry.get('research')!.config.memory as Record<string, unknown>;
      expect(mem).toBeDefined();
      expect(mem.maxEntries).toBeDefined();
      expect(mem.debounceMs).toBeDefined();
      for (const old of OLD_FIELD_NAMES) {
        expect(mem[old]).toBeUndefined();
      }
    });

    it('ci preset memory uses maxEntries (not maxItems)', () => {
      const mem = registry.get('ci')!.config.memory as Record<string, unknown>;
      expect(mem).toBeDefined();
      expect(mem.maxEntries).toBeDefined();
      expect(mem.maxItems).toBeUndefined();
    });

    it('all built-in presets with memory config use only valid fields', () => {
      for (const id of BUILTIN_IDS) {
        const preset = registry.get(id)!;
        const mem = preset.config.memory;
        if (!mem) continue;
        const memKeys = Object.keys(mem);
        for (const key of memKeys) {
          expect(VALID_MEMORY_FIELDS).toContain(key);
        }
      }
    });
  });

  // ── 10. remove preset ─────────────────────────────────────────────────────

  describe('remove', () => {
    it('removes an existing preset', () => {
      expect(registry.remove('fast')).toBe(true);
      expect(registry.has('fast')).toBe(false);
    });

    it('returns false for non-existent preset', () => {
      expect(registry.remove('nonexistent')).toBe(false);
    });

    it('removed preset no longer appears in list', () => {
      registry.remove('ci');
      const ids = registry.listIds();
      expect(ids).not.toContain('ci');
    });
  });

  // ── 11. resolve with overrideVars ─────────────────────────────────────────

  describe('resolve with overrideVars', () => {
    it('overrideVars substitute into resolved config strings', () => {
      registry.register({
        id: 'override-test',
        name: 'Override Test',
        description: 'Tests override vars',
        tags: ['test'],
        config: {
          memory: { storagePath: '/data/{{team}}/mem' },
        },
      });

      const cfg = registry.resolve('override-test', { team: 'alpha' });
      expect(cfg.memory?.storagePath).toBe('/data/alpha/mem');
    });
  });

  // ── 12. Validation & custom validators ────────────────────────────────────

  describe('custom validators', () => {
    it('addValidator is called during register', () => {
      registry.addValidator((config) => {
        if (config.project?.maxIterations && config.project.maxIterations > 100) {
          return 'maxIterations too high';
        }
        return null;
      });

      expect(() =>
        registry.register({
          id: 'too-many-iters',
          name: 'Too Many',
          description: 'Exceeds iteration limit',
          tags: ['test'],
          config: { project: { maxIterations: 200 } },
        }),
      ).toThrow(/maxIterations too high/);
    });

    it('validator passes for valid config', () => {
      registry.addValidator((config) => {
        if (config.project?.maxIterations && config.project.maxIterations > 100) {
          return 'too high';
        }
        return null;
      });

      expect(() =>
        registry.register({
          id: 'ok-iters',
          name: 'OK',
          description: 'Within iteration limit',
          tags: ['test'],
          config: { project: { maxIterations: 50 } },
        }),
      ).not.toThrow();
    });
  });

  // ── 13. Singleton access ──────────────────────────────────────────────────

  describe('getPresetRegistry / resetPresetRegistry', () => {
    it('getPresetRegistry returns same instance', () => {
      resetPresetRegistry();
      const a = getPresetRegistry();
      const b = getPresetRegistry();
      expect(a).toBe(b);
    });

    it('resetPresetRegistry creates fresh instance', () => {
      const a = getPresetRegistry();
      a.register(makeCustomPreset());
      resetPresetRegistry();
      const b = getPresetRegistry();
      expect(b.has('custom-test')).toBe(false);
    });
  });
});
