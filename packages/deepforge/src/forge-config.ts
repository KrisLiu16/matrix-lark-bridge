/**
 * DeepForge 2.0 — ForgeConfigManager
 *
 * Configuration loading, validation, versioning, migration, hot-reload,
 * snapshots/rollback, environment overrides, and preset application.
 *
 * Designed to be the single source of truth for runtime configuration.
 * All other subsystems (middleware, memory, events, etc.) read their
 * respective config slices from ForgeConfigManager.get().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ForgeConfig,
  DeepPartial,
  KnownConfigVersion,
  ConfigMigrationStep,
  ConfigPreset,
  ConfigOverride,
  ConfigOverrideSource,
  ConfigValidationError,
  ConfigValidationResult,
  ConfigChangeListener,
  ConfigErrorListener,
  ConfigPropertyChange,
  ConfigSnapshot,
  ConfigValidator,
  SchemaField,
  SchemaDefinition,
} from './types/config';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CURRENT_VERSION: KnownConfigVersion = '2.0';

/** Default configuration matching ForgeConfig v2.0 schema. */
export const DEFAULT_CONFIG: ForgeConfig = {
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
    storagePath: '.deepforge/memory.json',
    maxEntries: 200,
    debounceMs: 30_000,
    pruneConfidenceThreshold: 0.3,
    pruneRelevanceThreshold: 0.1,
    autoExtract: false,
    injectionCount: 15,
    injectionEnabled: true,
    maxInjectionTokens: 2000,
  },
  events: {
    enabled: true,
    bufferSize: 500,
    allowedTypes: [],
    persistToDisk: false,
  },
  concurrency: {
    maxWorkers: 5,
    queueLimit: 20,
    acquireTimeoutMs: 30_000,
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
};

// ─── Schema Definition (v2.0) ────────────────────────────────────────────────

const MIDDLEWARE_ITEM_SCHEMA: SchemaDefinition = {
  enabled: { type: 'boolean', required: true },
  order: { type: 'number', required: true, min: 0, max: 1000 },
  params: { type: 'object', required: true },
};

const CONFIG_SCHEMA: SchemaDefinition = {
  version: { type: 'string', required: true, enum: ['1.0', '1.1', '2.0'] },
  project: {
    type: 'object',
    required: true,
    properties: {
      model: { type: 'string', required: true },
      effort: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
      maxConcurrent: { type: 'number', required: true, min: 1, max: 100 },
      maxIterations: { type: 'number', required: true, min: 1, max: 200 },
      costLimitUsd: { type: 'number', required: true, min: 0 },
    },
  },
  middleware: {
    type: 'object',
    required: true,
    properties: {
      contextEnrichment: { type: 'object', properties: MIDDLEWARE_ITEM_SCHEMA },
      memory: { type: 'object', properties: MIDDLEWARE_ITEM_SCHEMA },
      qualityGate: { type: 'object', properties: MIDDLEWARE_ITEM_SCHEMA },
      concurrencyLimit: { type: 'object', properties: MIDDLEWARE_ITEM_SCHEMA },
      logging: { type: 'object', properties: MIDDLEWARE_ITEM_SCHEMA },
    },
  },
  memory: {
    type: 'object',
    required: true,
    properties: {
      enabled: { type: 'boolean', required: true },
      storagePath: { type: 'string', required: true },
      maxEntries: { type: 'number', required: true, min: 1 },
      debounceMs: { type: 'number', required: true, min: 0 },
      pruneConfidenceThreshold: { type: 'number', required: true, min: 0, max: 1 },
      pruneRelevanceThreshold: { type: 'number', required: true, min: 0, max: 1 },
      autoExtract: { type: 'boolean', required: true },
      injectionCount: { type: 'number', required: true, min: 0 },
      injectionEnabled: { type: 'boolean', required: true },
      maxInjectionTokens: { type: 'number', required: true, min: 0 },
    },
  },
  events: {
    type: 'object',
    required: true,
    properties: {
      enabled: { type: 'boolean', required: true },
      bufferSize: { type: 'number', required: true, min: 1 },
      allowedTypes: { type: 'array', items: { type: 'string' } },
      persistToDisk: { type: 'boolean' },
    },
  },
  concurrency: {
    type: 'object',
    required: true,
    properties: {
      maxWorkers: { type: 'number', required: true, min: 1, max: 100 },
      queueLimit: { type: 'number', required: true, min: 1 },
      acquireTimeoutMs: { type: 'number', required: true, min: 0 },
    },
  },
  quality: {
    type: 'object',
    required: true,
    properties: {
      structuredVerdict: { type: 'boolean', required: true },
      maxAutoRetries: { type: 'number', required: true, min: 0, max: 20 },
      passThreshold: { type: 'number', required: true, min: 0, max: 1 },
    },
  },
  notifications: {
    type: 'object',
    properties: {
      onPhaseChange: { type: 'boolean' },
      onTaskFail: { type: 'boolean' },
      onIterationComplete: { type: 'boolean' },
      onRunComplete: { type: 'boolean' },
    },
  },
};

// ─── Migrations ──────────────────────────────────────────────────────────────

const MIGRATIONS: ConfigMigrationStep[] = [
  {
    from: '1.0',
    to: '1.1',
    migrate(config: Record<string, unknown>): Record<string, unknown> {
      return {
        ...config,
        version: '1.1',
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
          debounceMs: 30_000,
          pruneConfidenceThreshold: 0.3,
          pruneRelevanceThreshold: 0.1,
          autoExtract: false,
          injectionCount: 15,
          injectionEnabled: true,
          maxInjectionTokens: 2000,
        },
      };
    },
  },
  {
    from: '1.1',
    to: '2.0',
    migrate(config: Record<string, unknown>): Record<string, unknown> {
      const mw = (config.middleware ?? {}) as Record<string, unknown>;
      return {
        ...config,
        version: '2.0',
        middleware: {
          ...mw,
          contextEnrichment: {
            ...(mw.contextEnrichment as Record<string, unknown> ?? {}),
            enabled: true,
          },
          memory: {
            ...(mw.memory as Record<string, unknown> ?? {}),
            enabled: true,
          },
        },
        memory: {
          ...(config.memory as Record<string, unknown> ?? {}),
          enabled: true,
          maxEntries: 200,
        },
        events: {
          enabled: true,
          bufferSize: 500,
          allowedTypes: [],
          persistToDisk: false,
        },
        concurrency: {
          maxWorkers: (config.project as Record<string, unknown> | undefined)?.maxConcurrent ?? 5,
          queueLimit: 20,
          acquireTimeoutMs: 30_000,
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
      };
    },
  },
];

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Check if a value is a plain object (not array, null, Date, etc.). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

/** Deep-merge `source` into `target`. Source wins on conflict. Returns new object. */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const sv = (source as Record<string, unknown>)[key];
    const tv = result[key];
    if (isPlainObject(sv) && isPlainObject(tv)) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as T;
}

/** Recursive deep equality check (handles objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
  }

  return false;
}

/** Compute dotted paths that differ between two objects. */
function diffPaths(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  prefix = '',
): string[] {
  const paths: string[] = [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    const p = prefix ? `${prefix}.${key}` : key;
    const av = a[key];
    const bv = b[key];
    if (isPlainObject(av) && isPlainObject(bv)) {
      paths.push(...diffPaths(
        av as Record<string, unknown>,
        bv as Record<string, unknown>,
        p,
      ));
    } else if (!deepEqual(av, bv)) {
      paths.push(p);
    }
  }
  return paths;
}

/** Validate a config object against a schema definition. */
function validateSchema(
  obj: Record<string, unknown>,
  schema: SchemaDefinition,
  prefix = '',
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  for (const [key, field] of Object.entries(schema)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (value === undefined || value === null) {
      if (field.required) {
        errors.push({ path: p, message: 'required field is missing', severity: 'error' });
      }
      continue;
    }

    if (field.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push({ path: p, message: `expected array, got ${typeof value}`, value, severity: 'error' });
        continue;
      }
      if (field.items) {
        for (let i = 0; i < (value as unknown[]).length; i++) {
          const item = (value as unknown[])[i];
          if (typeof item !== field.items.type) {
            errors.push({
              path: `${p}[${i}]`,
              message: `expected ${field.items.type}, got ${typeof item}`,
              value: item,
              severity: 'error',
            });
          }
        }
      }
    } else if (field.type === 'object') {
      if (!isPlainObject(value)) {
        errors.push({ path: p, message: `expected object, got ${typeof value}`, value, severity: 'error' });
        continue;
      }
      if (field.properties) {
        errors.push(...validateSchema(value as Record<string, unknown>, field.properties, p));
      }
    } else if (typeof value !== field.type) {
      errors.push({ path: p, message: `expected ${field.type}, got ${typeof value}`, value, severity: 'error' });
      continue;
    }

    if (field.enum && !field.enum.includes(value)) {
      errors.push({
        path: p,
        message: `value must be one of [${field.enum.join(', ')}]`,
        value,
        severity: 'error',
      });
    }

    if (field.type === 'number' && typeof value === 'number') {
      if (field.min !== undefined && value < field.min) {
        errors.push({ path: p, message: `value ${value} below minimum ${field.min}`, value, severity: 'error' });
      }
      if (field.max !== undefined && value > field.max) {
        errors.push({ path: p, message: `value ${value} exceeds maximum ${field.max}`, value, severity: 'error' });
      }
    }
  }

  return errors;
}

/** Set a value at a dotted path in an object. */
function setPath(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segments = dottedPath.split('.');
  let target = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!isPlainObject(target[seg])) {
      target[seg] = {};
    }
    target = target[seg] as Record<string, unknown>;
  }
  target[segments[segments.length - 1]] = value;
}

/** Get a value at a dotted path from an object. */
function getPath(obj: Record<string, unknown>, dottedPath: string): unknown {
  const segments = dottedPath.split('.');
  let current: unknown = obj;
  for (const seg of segments) {
    if (!isPlainObject(current)) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Apply FORGE_* environment variables as config overrides. */
function collectEnvOverrides(): ConfigOverride[] {
  const overrides: ConfigOverride[] = [];
  const now = new Date().toISOString();

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith('FORGE_') || envVal === undefined) continue;

    // FORGE_PROJECT_MAX_CONCURRENT → project.maxConcurrent
    const raw = envKey.slice('FORGE_'.length).toLowerCase();
    const dottedPath = envToDottedPath(raw);
    if (!dottedPath) continue;

    overrides.push({
      path: dottedPath,
      value: envVal,
      source: 'env',
      appliedAt: now,
      ttlMs: 0,
    });
  }

  return overrides;
}

/** Convert FORGE_ env var suffix to a config dotted path via heuristic matching. */
function envToDottedPath(raw: string): string | null {
  // Map underscore-separated env segments to known config paths.
  // E.g. "project_max_concurrent" → "project.maxConcurrent"
  const KNOWN_PATHS: Record<string, string> = {
    'project_model': 'project.model',
    'project_effort': 'project.effort',
    'project_max_concurrent': 'project.maxConcurrent',
    'project_max_iterations': 'project.maxIterations',
    'project_cost_limit_usd': 'project.costLimitUsd',
    'memory_enabled': 'memory.enabled',
    'memory_storage_path': 'memory.storagePath',
    'memory_max_entries': 'memory.maxEntries',
    'memory_debounce_ms': 'memory.debounceMs',
    'memory_prune_confidence_threshold': 'memory.pruneConfidenceThreshold',
    'memory_prune_relevance_threshold': 'memory.pruneRelevanceThreshold',
    'memory_auto_extract': 'memory.autoExtract',
    'memory_injection_count': 'memory.injectionCount',
    'memory_injection_enabled': 'memory.injectionEnabled',
    'memory_max_injection_tokens': 'memory.maxInjectionTokens',
    'events_enabled': 'events.enabled',
    'events_buffer_size': 'events.bufferSize',
    'concurrency_max_workers': 'concurrency.maxWorkers',
    'concurrency_queue_limit': 'concurrency.queueLimit',
    'concurrency_acquire_timeout_ms': 'concurrency.acquireTimeoutMs',
    'quality_structured_verdict': 'quality.structuredVerdict',
    'quality_max_auto_retries': 'quality.maxAutoRetries',
    'quality_pass_threshold': 'quality.passThreshold',
    'notifications_on_phase_change': 'notifications.onPhaseChange',
    'notifications_on_task_fail': 'notifications.onTaskFail',
    'notifications_on_iteration_complete': 'notifications.onIterationComplete',
    'notifications_on_run_complete': 'notifications.onRunComplete',
  };

  return KNOWN_PATHS[raw] ?? null;
}

/** Coerce a string env value to match the type of an existing config value. */
function coerceEnvValue(envVal: string, existingValue: unknown): unknown {
  if (typeof existingValue === 'number') {
    const n = Number(envVal);
    return Number.isNaN(n) ? existingValue : n;
  }
  if (typeof existingValue === 'boolean') {
    return envVal === 'true' || envVal === '1';
  }
  return envVal;
}

/** Deep clone using structuredClone (preserves Date, RegExp, etc.). */
function clone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Centralized cast helpers — all ForgeConfig ↔ Record<string, unknown> casts
 * go through these two functions to reduce inline casts.
 * Migration functions use direct Record casts for schema flexibility.
 */
function toRecord(config: ForgeConfig | DeepPartial<ForgeConfig>): Record<string, unknown> {
  if (config == null || typeof config !== 'object') {
    throw new TypeError(`toRecord: expected non-null object, got ${config === null ? 'null' : typeof config}`);
  }
  return config as unknown as Record<string, unknown>;
}

function asForgeConfig(record: Record<string, unknown>): ForgeConfig {
  if (record == null || typeof record !== 'object') {
    throw new TypeError(`asForgeConfig: expected non-null object, got ${record === null ? 'null' : typeof record}`);
  }
  if (!('version' in record)) {
    throw new Error('asForgeConfig: record missing required "version" field');
  }
  if (!('project' in record)) {
    throw new Error('asForgeConfig: record missing required "project" field');
  }
  return record as unknown as ForgeConfig;
}

// ─── ForgeConfigManager ─────────────────────────────────────────────────────

/**
 * Central configuration manager for DeepForge.
 *
 * Responsibilities:
 * 1. Load config from file or object, with automatic version migration
 * 2. Validate against the v2.0 schema
 * 3. Apply environment variable overrides (FORGE_* prefix)
 * 4. Apply runtime overrides with source tracking and optional TTL
 * 5. Apply configuration presets with inheritance resolution
 * 6. Deep-merge user config on top of defaults
 * 7. Track change history and notify listeners
 * 8. Snapshot/rollback for safe experimentation
 * 9. File watching for hot-reload
 */
export class ForgeConfigManager {
  private config: ForgeConfig;
  private listeners: ConfigChangeListener[] = [];
  private errorListeners: ConfigErrorListener[] = [];
  private validators: ConfigValidator[] = [];
  private snapshots: ConfigSnapshot[] = [];
  private overrides: ConfigOverride[] = [];
  private changeHistory: ConfigPropertyChange[] = [];
  private filePath: string | null = null;
  private watchAbort: AbortController | null = null;

  constructor(initial?: DeepPartial<ForgeConfig>) {
    this.config = initial
      ? asForgeConfig(deepMerge(toRecord(clone(DEFAULT_CONFIG)), toRecord(initial)))
      : clone(DEFAULT_CONFIG);
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /** Load configuration from a JSON file. Migrates, merges with defaults, applies env overrides, validates. */
  loadFromFile(filePath: string): ConfigValidationResult {
    const resolved = path.resolve(filePath);
    this.filePath = resolved;

    if (!fs.existsSync(resolved)) {
      // No file — use defaults, considered valid
      return this.makeValidationResult([], this.config.version);
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } catch (err) {
      return this.makeValidationResult(
        [{ path: '', message: `Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' }],
        'unknown',
      );
    }

    return this.loadFromObject(raw);
  }

  /** Load configuration from a plain object. */
  loadFromObject(raw: Record<string, unknown>): ConfigValidationResult {
    // Step 1: Migrate to latest version
    const version = (raw.version as KnownConfigVersion) ?? '1.0';
    const migrated = this.migrateToLatest(raw, version);

    // Step 2: Deep merge with defaults
    const mergedRecord = deepMerge(toRecord(clone(DEFAULT_CONFIG)), migrated);
    const merged = asForgeConfig(mergedRecord);

    // Step 3: Apply environment overrides
    const envOverrides = collectEnvOverrides();
    for (const ov of envOverrides) {
      const existing = getPath(mergedRecord, ov.path);
      if (existing !== undefined) {
        const coerced = coerceEnvValue(ov.value as string, existing);
        setPath(mergedRecord, ov.path, coerced);
      }
    }

    // Step 4: Validate
    const errors = this.validateFull(mergedRecord);
    const result = this.makeValidationResult(errors, merged.version);

    if (result.valid) {
      const old = this.config;
      this.config = merged;
      this.recordChanges(old, merged, 'migration');
    }

    return result;
  }

  /** Save current config to a JSON file. */
  saveToFile(filePath?: string): void {
    const target = filePath ?? this.filePath;
    if (!target) throw new Error('No file path specified for save');

    const resolved = path.resolve(target);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, JSON.stringify(this.config, null, 2), 'utf-8');
    this.filePath = resolved;
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  /** Get the full resolved config (read-only clone). */
  get(): ForgeConfig {
    return clone(this.config);
  }

  /** Get a value by dotted path (e.g. "concurrency.maxWorkers"). */
  getPath<T = unknown>(dottedPath: string): T | undefined {
    return getPath(toRecord(this.config), dottedPath) as T | undefined;
  }

  /** Get the raw internal config reference (for performance-critical reads). */
  getRef(): Readonly<ForgeConfig> {
    return this.config;
  }

  // ── Updates ──────────────────────────────────────────────────────────────

  /** Partially update the config. Validates before applying. */
  update(partial: DeepPartial<ForgeConfig>): ConfigValidationResult {
    const old = this.config;
    const mergedRecord = deepMerge(toRecord(clone(old)), toRecord(partial));
    const merged = asForgeConfig(mergedRecord);

    const errors = this.validateFull(mergedRecord);
    const result = this.makeValidationResult(errors, merged.version);

    if (result.valid) {
      this.config = merged;
      this.recordChanges(old, merged, 'api');
    }

    return result;
  }

  // ── Runtime Overrides ────────────────────────────────────────────────────

  /** Apply a runtime override at a specific path. Highest priority. */
  applyOverride(dottedPath: string, value: unknown, source: ConfigOverrideSource = 'api', ttlMs = 0): ConfigValidationResult {
    const old = this.config;
    const candidate = toRecord(clone(old));
    setPath(candidate, dottedPath, value);

    const errors = this.validateFull(candidate);
    const result = this.makeValidationResult(errors, candidate.version as string);

    if (result.valid) {
      const override: ConfigOverride = {
        path: dottedPath,
        value,
        source,
        appliedAt: new Date().toISOString(),
        ttlMs,
      };
      this.overrides.push(override);
      this.config = asForgeConfig(candidate);
      this.recordChanges(old, this.config, source);
    }

    return result;
  }

  /** Remove all runtime overrides and revert to the base config. */
  clearOverrides(): void {
    if (this.overrides.length === 0) return;
    this.overrides = [];
    // Re-load from file or defaults to get clean state
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.loadFromFile(this.filePath);
    } else {
      const old = this.config;
      this.config = clone(DEFAULT_CONFIG);
      this.recordChanges(old, this.config, 'api');
    }
  }

  /** Get the list of active runtime overrides. */
  getOverrides(): ConfigOverride[] {
    return [...this.overrides];
  }

  /** Remove expired TTL-based overrides. Call periodically or before reads. */
  pruneExpiredOverrides(): number {
    const now = Date.now();
    const before = this.overrides.length;
    this.overrides = this.overrides.filter((ov) => {
      if (ov.ttlMs === 0) return true; // permanent
      const expiry = new Date(ov.appliedAt).getTime() + ov.ttlMs;
      return now < expiry;
    });
    const pruned = before - this.overrides.length;
    if (pruned > 0 && this.filePath && fs.existsSync(this.filePath)) {
      this.loadFromFile(this.filePath);
    }
    return pruned;
  }

  // ── Preset Application ──────────────────────────────────────────────────

  /** Apply a preset's config on top of the current config. */
  applyPreset(preset: ConfigPreset): ConfigValidationResult {
    return this.update(preset.config);
  }

  /** Reset to defaults, then apply a preset. */
  resetToPreset(preset: ConfigPreset): ConfigValidationResult {
    const old = this.config;
    this.config = clone(DEFAULT_CONFIG);
    const result = this.update(preset.config);
    if (!result.valid) {
      // Rollback on failure
      this.config = old;
    }
    return result;
  }

  // ── Migration ────────────────────────────────────────────────────────────

  private migrateToLatest(config: Record<string, unknown>, fromVersion: KnownConfigVersion): Record<string, unknown> {
    const versionOrder: KnownConfigVersion[] = ['1.0', '1.1', '2.0'];
    let current = { ...config };
    let version = fromVersion;
    let idx = versionOrder.indexOf(version);

    while (idx >= 0 && idx < versionOrder.length - 1) {
      const migration = MIGRATIONS.find((m) => m.from === version);
      if (!migration) break;
      current = migration.migrate(current);
      version = migration.to;
      idx = versionOrder.indexOf(version);
    }

    return current;
  }

  // ── Validation ───────────────────────────────────────────────────────────

  /** Run structural schema validation plus all custom validators. */
  private validateFull(data: Record<string, unknown>): ConfigValidationError[] {
    const errors = validateSchema(data, CONFIG_SCHEMA);

    // Run custom validators
    for (const validator of this.validators) {
      const err = validator(data as DeepPartial<ForgeConfig>);
      if (err) {
        errors.push({ path: '', message: err, severity: 'error' });
      }
    }

    return errors;
  }

  /** Validate arbitrary config data (public API). */
  validate(data: Record<string, unknown>): ConfigValidationResult {
    const errors = this.validateFull(data);
    return this.makeValidationResult(errors, (data.version as string) ?? 'unknown');
  }

  /** Register a custom validator. Returns an unsubscribe function. */
  addValidator(validator: ConfigValidator): () => void {
    this.validators.push(validator);
    return () => {
      this.validators = this.validators.filter((v) => v !== validator);
    };
  }

  private makeValidationResult(errors: ConfigValidationError[], version: string): ConfigValidationResult {
    return {
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors,
      validatedVersion: version,
      validatedAt: new Date().toISOString(),
    };
  }

  // ── Change Tracking ──────────────────────────────────────────────────────

  /** Register a listener for config changes. Returns an unsubscribe function. */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Register a listener for config errors (watcher/reload). Returns an unsubscribe function. */
  onError(listener: ConfigErrorListener): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }

  private emitError(error: unknown, source: 'watcher' | 'reload'): void {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) {
      try {
        listener(err, source);
      } catch {
        // Prevent error listener failures from cascading
      }
    }
  }

  /** Get the history of config changes. */
  getChangeHistory(): ConfigPropertyChange[] {
    return [...this.changeHistory];
  }

  private recordChanges(old: ForgeConfig, updated: ForgeConfig, source: ConfigOverrideSource): void {
    const oldRecord = toRecord(old);
    const updatedRecord = toRecord(updated);
    const changedPaths = diffPaths(oldRecord, updatedRecord);

    if (changedPaths.length === 0) return;

    // Record change events
    const now = new Date().toISOString();
    for (const p of changedPaths) {
      this.changeHistory.push({
        timestamp: now,
        path: p,
        oldValue: getPath(oldRecord, p),
        newValue: getPath(updatedRecord, p),
        source,
      });
    }

    // Cap history at 500 entries
    if (this.changeHistory.length > 500) {
      this.changeHistory = this.changeHistory.slice(-500);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(updated, old, changedPaths);
      } catch {
        // Listener errors must not crash the config system
      }
    }
  }

  // ── Snapshots / Rollback ─────────────────────────────────────────────────

  /** Take a snapshot of the current config. Returns the snapshot id. */
  snapshot(label?: string): string {
    const snap: ConfigSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      data: clone(this.config),
      label,
    };
    this.snapshots.push(snap);

    // Keep at most 50 snapshots
    if (this.snapshots.length > 50) {
      this.snapshots = this.snapshots.slice(-50);
    }

    return snap.id;
  }

  /** List all snapshots. */
  listSnapshots(): ConfigSnapshot[] {
    return this.snapshots.map((s) => ({ ...s, data: clone(s.data) }));
  }

  /** Rollback to a specific snapshot. */
  rollback(snapshotId: string): ConfigValidationResult {
    const snap = this.snapshots.find((s) => s.id === snapshotId);
    if (!snap) {
      return this.makeValidationResult(
        [{ path: '', message: `Snapshot "${snapshotId}" not found`, severity: 'error' }],
        this.config.version,
      );
    }

    const old = this.config;
    this.config = clone(snap.data);
    this.recordChanges(old, this.config, 'user');
    return this.makeValidationResult([], this.config.version);
  }

  // ── File Watching (Hot Reload) ───────────────────────────────────────────

  /** Start watching the config file for changes. Auto-reloads on modification. */
  watch(): void {
    if (!this.filePath) throw new Error('No file path to watch — load a file first');
    if (this.watchAbort) return; // already watching

    this.watchAbort = new AbortController();
    const watcher = fs.watch(
      this.filePath,
      { signal: this.watchAbort.signal },
      (eventType) => {
        if (eventType === 'change' && this.filePath) {
          try {
            this.loadFromFile(this.filePath);
          } catch (err: unknown) {
            this.emitError(err, 'reload');
          }
        }
      },
    );
    watcher.on('error', (err: unknown) => {
      this.emitError(err, 'watcher');
    });
  }

  /** Stop watching the config file. */
  unwatch(): void {
    this.watchAbort?.abort();
    this.watchAbort = null;
  }

  /** Whether the manager is currently watching for file changes. */
  get isWatching(): boolean {
    return this.watchAbort !== null;
  }

  // ── Disposal ─────────────────────────────────────────────────────────────

  /** Clean up all resources (watchers, listeners). */
  dispose(): void {
    this.unwatch();
    this.listeners = [];
    this.errorListeners = [];
    this.validators = [];
  }
}
