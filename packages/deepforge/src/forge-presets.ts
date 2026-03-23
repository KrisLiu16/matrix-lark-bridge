/**
 * DeepForge 2.0 — Preset Registry & Built-in Team Templates
 *
 * Provides:
 * - 5 built-in presets: default, fast, thorough, research, ci
 * - PresetRegistry with CRUD, inheritance resolution, template variables
 * - Import/export (JSON serialization) for sharing presets
 * - Integration with ForgeConfigManager via ConfigPreset interface
 */

import type {
  ForgeConfig,
  DeepPartial,
  ConfigPreset,
  ConfigValidator,
} from './types/config';
import { isPlainObject, deepMerge } from './forge-config';

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Recursively substitute {{varName}} placeholders in string values. */
function substituteVariables(
  obj: Record<string, unknown>,
  vars: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\{\{(\w+)\}\}/g, (_, name) =>
        name in vars ? String(vars[name]) : `{{${name}}}`,
      );
    } else if (isPlainObject(v)) {
      out[k] = substituteVariables(v as Record<string, unknown>, vars);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        isPlainObject(item)
          ? substituteVariables(item as Record<string, unknown>, vars)
          : typeof item === 'string'
            ? item.replace(/\{\{(\w+)\}\}/g, (_, name) =>
                name in vars ? String(vars[name]) : `{{${name}}}`,
              )
            : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Serialization Types ─────────────────────────────────────────────────────

/** JSON-serializable preset for import/export. */
export interface SerializedPreset {
  name: string;
  description: string;
  tags: string[];
  extends?: string;
  variables?: Record<string, string | number | boolean>;
  config: DeepPartial<ForgeConfig>;
}

// ─── Built-in Presets ────────────────────────────────────────────────────────

/** Balanced defaults for general-purpose orchestration. */
const PRESET_DEFAULT: ConfigPreset = {
  id: 'default',
  name: 'Default',
  description: 'Balanced defaults for general-purpose multi-agent orchestration',
  tags: ['general', 'balanced'],
  config: {
    version: '2.0',
    project: {
      model: 'claude-sonnet-4-20250514',
      effort: 'high',
      maxConcurrent: 5,
      maxIterations: 10,
      costLimitUsd: 50,
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
      maxEntries: 200,
      storagePath: '.deepforge/memory',
      debounceMs: 3000,
    },
    events: { enabled: true, bufferSize: 500, allowedTypes: [], persistToDisk: false },
    concurrency: { maxWorkers: 5, queueLimit: 20, acquireTimeoutMs: 30_000 },
    quality: { structuredVerdict: true, maxAutoRetries: 2, passThreshold: 0.7 },
    notifications: { onPhaseChange: true, onTaskFail: true, onIterationComplete: true, onRunComplete: true },
  },
};

/** Speed-optimized: fewer retries, relaxed quality gate, higher concurrency. */
const PRESET_FAST: ConfigPreset = {
  id: 'fast',
  name: 'Fast',
  description: 'Speed-optimized: relaxed quality gate, higher concurrency, fewer retries',
  tags: ['speed', 'draft', 'prototype'],
  extends: 'default',
  config: {
    project: {
      effort: 'medium',
      maxConcurrent: 10,
      maxIterations: 5,
      costLimitUsd: 20,
    },
    middleware: {
      qualityGate: { enabled: false, order: 30, params: {} },
    },
    concurrency: { maxWorkers: 10, queueLimit: 40, acquireTimeoutMs: 10_000 },
    quality: { structuredVerdict: false, maxAutoRetries: 0, passThreshold: 0.3 },
    memory: { debounceMs: 10_000 },
  },
};

/** High-quality: strict quality gate, more retries, conservative concurrency. */
const PRESET_THOROUGH: ConfigPreset = {
  id: 'thorough',
  name: 'Thorough',
  description: 'High-quality: strict quality gate, more retries, conservative concurrency',
  tags: ['quality', 'production', 'careful'],
  extends: 'default',
  config: {
    project: {
      effort: 'high',
      maxConcurrent: 3,
      maxIterations: 15,
      costLimitUsd: 100,
    },
    concurrency: { maxWorkers: 3, queueLimit: 10, acquireTimeoutMs: 60_000 },
    quality: { structuredVerdict: true, maxAutoRetries: 5, passThreshold: 0.9 },
    memory: { maxEntries: 500 },
  },
};

/** Research-oriented: high concurrency, relaxed gates, heavy memory use. */
const PRESET_RESEARCH: ConfigPreset = {
  id: 'research',
  name: 'Research & Exploration',
  description: 'High concurrency, relaxed quality gate, memory enabled for knowledge accumulation',
  tags: ['research', 'exploration', 'creative'],
  extends: 'default',
  config: {
    project: {
      effort: 'medium',
      maxConcurrent: 15,
      maxIterations: 20,
      costLimitUsd: 100,
    },
    middleware: {
      qualityGate: { enabled: false, order: 30, params: {} },
    },
    concurrency: { maxWorkers: 15, queueLimit: 50, acquireTimeoutMs: 30_000 },
    quality: { structuredVerdict: false, maxAutoRetries: 1, passThreshold: 0.4 },
    memory: { enabled: true, maxEntries: 1000, debounceMs: 5000 },
    events: { enabled: true, bufferSize: 2000 },
  },
};

/** CI/automation: strict, low-cost, no persistence. */
const PRESET_CI: ConfigPreset = {
  id: 'ci',
  name: 'CI / Automation',
  description: 'Strict quality gates, low cost limit, no memory persistence. For automated pipelines',
  tags: ['ci', 'automation', 'strict', 'pipeline'],
  extends: 'default',
  config: {
    project: {
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      maxConcurrent: 3,
      maxIterations: 2,
      costLimitUsd: 2,
    },
    middleware: {
      memory: { enabled: false, order: 20, params: {} },
      contextEnrichment: { enabled: false, order: 10, params: {} },
    },
    concurrency: { maxWorkers: 3, queueLimit: 10, acquireTimeoutMs: 15_000 },
    quality: { structuredVerdict: true, maxAutoRetries: 1, passThreshold: 0.85 },
    memory: { enabled: false, maxEntries: 50 },
    events: { enabled: true, bufferSize: 100, persistToDisk: true },
    notifications: { onTaskFail: true, onRunComplete: true, onPhaseChange: false, onIterationComplete: false },
  },
};

const BUILTIN_PRESETS: ConfigPreset[] = [
  PRESET_DEFAULT,
  PRESET_FAST,
  PRESET_THOROUGH,
  PRESET_RESEARCH,
  PRESET_CI,
];

// ─── Preset Registry ─────────────────────────────────────────────────────────

/**
 * Registry for configuration presets with inheritance, template variables,
 * and import/export support.
 *
 * Usage:
 *   const registry = new PresetRegistry();
 *   const config = registry.resolve('fast');
 *   configManager.update(config);
 */
export class PresetRegistry {
  private presets = new Map<string, ConfigPreset>();
  private validators: ConfigValidator[] = [];

  constructor() {
    for (const p of BUILTIN_PRESETS) {
      this.presets.set(p.id!, p);
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /** Register or overwrite a preset. Validates structure before storing. */
  register(preset: ConfigPreset): void {
    const key = preset.id ?? preset.name;
    const err = this.validatePresetStructure(preset);
    if (err) throw new Error(`Invalid preset "${key}": ${err}`);
    this.presets.set(key, preset);
  }

  /** Get a preset by id. */
  get(id: string): ConfigPreset | undefined {
    return this.presets.get(id);
  }

  /** Check if a preset exists. */
  has(id: string): boolean {
    return this.presets.has(id);
  }

  /** List all registered preset ids. */
  listIds(): string[] {
    return [...this.presets.keys()];
  }

  /** List all registered presets. */
  list(): ConfigPreset[] {
    return [...this.presets.values()];
  }

  /** Remove a preset by id. */
  remove(id: string): boolean {
    return this.presets.delete(id);
  }

  /** Search presets by tag. */
  findByTag(tag: string): ConfigPreset[] {
    return this.list().filter((p) => p.tags.includes(tag));
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  /**
   * Resolve a preset by walking the `extends` chain and merging configs.
   * Template variables are substituted in string values.
   *
   * @param id - Preset identifier to resolve
   * @param overrideVars - Extra variables merged on top of the preset's own
   * @returns Fully resolved partial config ready for deep-merge with defaults
   */
  resolve(
    id: string,
    overrideVars?: Record<string, string | number | boolean>,
  ): DeepPartial<ForgeConfig> {
    const chain = this.resolveInheritanceChain(id);

    // Merge configs bottom-up (root ancestor first)
    let merged: Record<string, unknown> = {};
    for (const p of chain) {
      merged = deepMerge(merged, p.config as Record<string, unknown>);
    }

    // Collect variables (later in chain overrides earlier)
    let vars: Record<string, string | number | boolean> = {};
    for (const p of chain) {
      if (p.variables) vars = { ...vars, ...p.variables };
    }
    if (overrideVars) vars = { ...vars, ...overrideVars };

    // Substitute template variables
    if (Object.keys(vars).length > 0) {
      merged = substituteVariables(merged, vars);
    }

    return merged as DeepPartial<ForgeConfig>;
  }

  // ── Import / Export ──────────────────────────────────────────────────────

  /** Export a preset to a JSON-serializable object. */
  exportPreset(id: string): SerializedPreset {
    const p = this.presets.get(id);
    if (!p) throw new Error(`Preset "${id}" not found`);
    return {
      name: p.id ?? p.name,
      description: p.description,
      tags: [...p.tags],
      ...(p.extends ? { extends: p.extends } : {}),
      ...(p.variables ? { variables: { ...p.variables } } : {}),
      config: structuredClone(p.config),
    };
  }

  /** Export a preset as a JSON string. */
  exportJSON(id: string): string {
    return JSON.stringify(this.exportPreset(id), null, 2);
  }

  /** Import a preset from a JSON string or object. */
  importPreset(input: string | SerializedPreset): void {
    const data: SerializedPreset = typeof input === 'string' ? JSON.parse(input) : input;
    this.register({
      id: data.name,
      name: data.name,
      description: data.description,
      tags: data.tags,
      config: data.config,
      ...(data.extends ? { extends: data.extends } : {}),
      ...(data.variables ? { variables: data.variables } : {}),
    });
  }

  /** Export all presets as a JSON array string. */
  exportAll(): string {
    return JSON.stringify(this.listIds().map((id) => this.exportPreset(id)), null, 2);
  }

  // ── Validation ───────────────────────────────────────────────────────────

  /** Add a custom config validator applied during preset registration. */
  addValidator(v: ConfigValidator): void {
    this.validators.push(v);
  }

  private validatePresetStructure(preset: ConfigPreset): string | null {
    if (!preset.id || typeof preset.id !== 'string') {
      return 'id is required and must be a non-empty string';
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(preset.id)) {
      return 'id must be lowercase alphanumeric (hyphens/underscores allowed, not leading)';
    }
    if (!preset.description) {
      return 'description is required';
    }
    if (!Array.isArray(preset.tags)) {
      return 'tags must be an array';
    }
    if (preset.extends && !this.presets.has(preset.extends)) {
      return `parent preset "${preset.extends}" not found`;
    }
    for (const v of this.validators) {
      const err = v(preset.config);
      if (err) return err;
    }
    return null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Walk the extends chain, detecting cycles. Returns root-first order. */
  private resolveInheritanceChain(id: string): ConfigPreset[] {
    const visited = new Set<string>();
    const chain: ConfigPreset[] = [];
    let current: string | undefined = id;

    while (current) {
      if (visited.has(current)) {
        throw new Error(`Circular preset inheritance: ${[...visited, current].join(' → ')}`);
      }
      const p = this.presets.get(current);
      if (!p) throw new Error(`Preset "${current}" not found`);
      visited.add(current);
      chain.unshift(p); // prepend so root ancestor is first
      current = p.extends;
    }

    return chain;
  }
}

// ─── Singleton Access ────────────────────────────────────────────────────────

let _defaultRegistry: PresetRegistry | undefined;

/** Get (or lazily create) the global preset registry. */
export function getPresetRegistry(): PresetRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new PresetRegistry();
  }
  return _defaultRegistry;
}

/** Reset the global registry (useful in tests). */
export function resetPresetRegistry(): void {
  _defaultRegistry = undefined;
}
