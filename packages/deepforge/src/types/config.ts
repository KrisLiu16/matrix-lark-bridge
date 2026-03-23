/**
 * DeepForge 2.0 — Configuration System Types
 *
 * Complete type definitions for configuration management:
 * - ForgeConfig: top-level configuration structure
 * - ConfigVersion: schema versioning and migration support
 * - ConfigPreset: reusable configuration templates
 * - ConfigOverride: runtime configuration patching
 * - ConfigValidationResult: structured validation feedback
 *
 * Compatible with existing ForgeProject / ForgeState in types.ts.
 * All subsystem configs (middleware, memory, events, concurrency, quality)
 * are co-located here so a single import covers the full config surface.
 */

// ============ Utility Types ============

/** Recursively make all properties optional. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

/** Extract dot-separated paths from an object type (1 level deep for perf). */
export type ConfigPath<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}` | `${K}.${keyof T[K] & string}`
        : `${K}`;
    }[keyof T & string]
  : never;

// ============ Per-Middleware Config ============

/** Configuration for a single middleware in the pipeline. */
export interface MiddlewareItemConfig {
  /** Whether this middleware is active. */
  enabled: boolean;
  /** Execution order — lower values run first. */
  order: number;
  /** Arbitrary middleware-specific parameters. */
  params: Record<string, unknown>;
}

/**
 * Named middleware configurations used by the pipeline.
 *
 * Built-in keys are strongly typed; additional user-defined middleware
 * can be added via the index signature.
 */
export interface MiddlewareConfig {
  /** Enriches task prompts with project context and iteration history. */
  contextEnrichment: MiddlewareItemConfig;
  /** Injects / persists cross-iteration memory facts. */
  memory: MiddlewareItemConfig;
  /** Blocks iteration advancement unless quality thresholds are met. */
  qualityGate: MiddlewareItemConfig;
  /** Limits parallel sub-agent execution via semaphore. */
  concurrencyLimit: MiddlewareItemConfig;
  /** Structured logging of pipeline events. */
  logging: MiddlewareItemConfig;
  /** Escape hatch for user-defined middleware. */
  [custom: string]: MiddlewareItemConfig;
}

// ============ Memory Config ============

/**
 * Configuration for the cross-session memory subsystem.
 * Field names aligned with MemoryStoreConfig in types/memory.ts.
 */
export interface MemoryConfig {
  /** Whether the memory system is enabled. */
  enabled: boolean;
  /** Path to the persistent memory file (JSON). Default: '.deepforge/memory.json'. */
  storagePath: string;
  /** Maximum number of entries to retain. Oldest low-relevance entries pruned first. */
  maxEntries: number;
  /** Debounce interval (ms) for batching memory saves. Default: 30000. */
  debounceMs: number;
  /** Minimum confidence to keep an entry during pruning. Default: 0.3. */
  pruneConfidenceThreshold: number;
  /** Minimum relevance to keep an entry during pruning. Default: 0.1. */
  pruneRelevanceThreshold: number;
  /** Whether to automatically extract memories from conversations via LLM. */
  autoExtract: boolean;
  /** Number of top entries to inject into prompt. Default: 15. */
  injectionCount: number;
  /** Whether to inject memories into prompts. Default: true. */
  injectionEnabled: boolean;
  /** Maximum tokens allowed for memory injection block. Default: 2000. */
  maxInjectionTokens: number;
}

// ============ Event Config ============

/** Configuration for the ForgeEventBus. */
export interface EventConfig {
  /** Enable the event bus. When false, emit() is a no-op. */
  enabled: boolean;
  /** Maximum events kept in the in-memory ring buffer before oldest are discarded. */
  bufferSize: number;
  /** Restrict emission to these event types. Empty array means all types are allowed. */
  allowedTypes: string[];
  /** Whether to persist events to forge-events.jsonl on disk. */
  persistToDisk: boolean;
}

// ============ Concurrency Config ============

/** Configuration for the AsyncSemaphore and task scheduling. */
export interface ConcurrencyConfig {
  /** Maximum number of parallel sub-agent tasks. Maps to semaphore capacity. */
  maxWorkers: number;
  /** Maximum queued tasks before back-pressure rejects new acquisitions. */
  queueLimit: number;
  /** Timeout in milliseconds for acquiring a semaphore slot. 0 means wait indefinitely. */
  acquireTimeoutMs: number;
}

// ============ Quality Config ============

/** Configuration for the quality gate / structured verdict system. */
export interface QualityConfig {
  /** Use structured JSON verdict instead of free-text critic output. */
  structuredVerdict: boolean;
  /** Automatically retry on critic rejection, up to this many times per iteration. */
  maxAutoRetries: number;
  /** Minimum confidence score (0-1) required to pass the quality gate. */
  passThreshold: number;
}

// ============ Project Defaults Config ============

/** Default values applied to new ForgeProject instances. */
export interface ProjectDefaultsConfig {
  /** Default LLM model identifier. */
  model: string;
  /** Default effort level for task execution. */
  effort: 'low' | 'medium' | 'high';
  /** Default maximum concurrent sub-agent tasks. */
  maxConcurrent: number;
  /** Default maximum iterations before auto-completion. */
  maxIterations: number;
  /** Default cost limit in USD. Execution pauses when exceeded. */
  costLimitUsd: number;
}

// ============ Notification Config ============

/** Controls which lifecycle events trigger external notifications. */
export interface NotificationConfig {
  /** Notify on phase transitions (e.g. planning -> executing). */
  onPhaseChange: boolean;
  /** Notify when a task fails. */
  onTaskFail: boolean;
  /** Notify when an iteration completes. */
  onIterationComplete: boolean;
  /** Notify when the entire forge run completes. */
  onRunComplete: boolean;
}

// ============ Top-Level ForgeConfig ============

/**
 * Complete configuration for a DeepForge 2.0 instance.
 *
 * This is the canonical shape that ForgeConfigManager validates against.
 * Subsystem modules read their respective slices at runtime.
 */
export interface ForgeConfig {
  /** Semantic version of this config schema (e.g. "2.0.0"). */
  version: string;
  /** Project-level defaults. */
  project: ProjectDefaultsConfig;
  /** Middleware pipeline settings. */
  middleware: MiddlewareConfig;
  /** Memory subsystem settings. */
  memory: MemoryConfig;
  /** Event bus settings. */
  events: EventConfig;
  /** Concurrency control settings. */
  concurrency: ConcurrencyConfig;
  /** Quality gate settings. */
  quality: QualityConfig;
  /** Notification delivery settings. */
  notifications: NotificationConfig;
}

// ============ Config Versioning ============

/**
 * Metadata for a specific config schema version.
 * Used by the migration system to upgrade configs across versions.
 */
export interface ConfigVersion {
  /** Schema version string (semver, e.g. "2.0.0"). */
  version: string;
  /** JSON-Schema URI for external validation tooling (optional). */
  schema: string;
  /** The version this schema can be automatically migrated from. Null if no migration path. */
  migrateFrom: string | null;
}

/** All known config versions, ordered oldest to newest. */
export type KnownConfigVersion = '1.0' | '1.1' | '2.0';

/** Current config schema version constant. */
export const CURRENT_CONFIG_VERSION: KnownConfigVersion = '2.0';

/**
 * A migration function that transforms config from one schema version to the next.
 * May be async to support migrations that need I/O (e.g. reading defaults from disk).
 */
export type ConfigMigrator = (
  oldConfig: Record<string, unknown>,
) => ForgeConfig | Promise<ForgeConfig>;

/** Describes a single migration step between two adjacent versions. */
export interface ConfigMigrationStep {
  /** Source version. */
  from: KnownConfigVersion;
  /** Target version. */
  to: KnownConfigVersion;
  /** The migration function. */
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

// ============ Config Presets ============

/**
 * A named configuration template that can be applied on top of defaults.
 *
 * Presets support inheritance (`extends`) and template variables.
 * The `config` field is deep-merged onto the base config.
 */
export interface ConfigPreset {
  /** Runtime identifier used by PresetRegistry for lookup/removal. */
  id?: string;
  /** Unique preset identifier (lowercase alphanumeric, hyphens/underscores allowed). */
  name: string;
  /** Human-readable description of the preset's purpose. */
  description: string;
  /** Partial config that gets deep-merged onto defaults (or parent preset). */
  config: DeepPartial<ForgeConfig>;
  /** Searchable tags for discovery (e.g. ["speed", "quality", "debug"]). */
  tags: string[];
  /** Optional parent preset name — this preset inherits its config first. */
  extends?: string;
  /** Template variables: keys like "{{maxWorkers}}" are substituted in string values. */
  variables?: Record<string, string | number | boolean>;
}

// ============ Config Override ============

/**
 * A runtime configuration override.
 *
 * Overrides are applied on top of the resolved config (defaults + preset)
 * and take highest priority. They are typically set via API calls,
 * environment variables, or CLI flags and are not persisted.
 */
export interface ConfigOverride {
  /** Dot-path of the config key to override (e.g. "concurrency.maxWorkers"). */
  path: string;
  /** The override value. Must match the type of the target field. */
  value: unknown;
  /** Origin of this override for auditability. */
  source: ConfigOverrideSource;
  /** ISO timestamp when the override was applied. */
  appliedAt: string;
  /** Optional TTL in milliseconds. After expiry the override is removed. 0 = permanent. */
  ttlMs: number;
}

/** Where a config override originated from. */
export type ConfigOverrideSource = 'env' | 'cli' | 'api' | 'preset' | 'migration' | 'user';

// ============ Config Validation ============

/** A single validation error with path and contextual info. */
export interface ConfigValidationError {
  /** Dot-path of the offending field (e.g. "quality.passThreshold"). */
  path: string;
  /** Human-readable description of the validation failure. */
  message: string;
  /** The value that failed validation (if available). */
  value?: unknown;
  /** Severity: "error" blocks usage, "warning" is advisory. */
  severity: 'error' | 'warning';
}

/**
 * Result of validating a configuration object.
 *
 * `valid` is true only when there are zero errors (warnings are allowed).
 */
export interface ConfigValidationResult {
  /** Whether the config passed all error-level validations. */
  valid: boolean;
  /** List of validation issues found (both errors and warnings). */
  errors: ConfigValidationError[];
  /** The config version string that was validated against. */
  validatedVersion: string;
  /** ISO timestamp of when validation was performed. */
  validatedAt: string;
}

/**
 * A pluggable validator function.
 *
 * Returns null on success, or a human-readable error message on failure.
 * Validators are run in registration order; the first failure stops the chain.
 */
export type ConfigValidator = (
  config: DeepPartial<ForgeConfig>,
) => string | null;

// ============ Config Change Tracking ============

/** Records a single config mutation for audit / event bus integration. */
export interface ConfigPropertyChange {
  /** ISO timestamp of the change. */
  timestamp: string;
  /** Dot-path of the changed key (e.g. "memory.maxEntries"). */
  path: string;
  /** Value before the change (undefined for new keys). */
  oldValue: unknown;
  /** Value after the change (undefined for deletions). */
  newValue: unknown;
  /** What triggered this change. */
  source: ConfigOverrideSource;
}

/** Callback signature for config change listeners. */
export type ConfigChangeListener = (
  newConfig: ForgeConfig,
  oldConfig: ForgeConfig,
  changedPaths: string[],
) => void;

/** Callback signature for config error listeners (watcher errors, reload failures). */
export type ConfigErrorListener = (
  error: Error,
  source: 'watcher' | 'reload',
) => void;

// ============ Config Snapshot ============

/** An immutable snapshot of config state, used for rollback. */
export interface ConfigSnapshot {
  /** Unique snapshot identifier. */
  id: string;
  /** ISO timestamp when the snapshot was taken. */
  timestamp: string;
  /** Deep-cloned config data at snapshot time. */
  data: ForgeConfig;
  /** Optional label for human identification (e.g. "before-migration"). */
  label?: string;
}

// ============ Schema Validation (structural) ============

/** Descriptor for a single field in the config schema. Used by structural validators. */
export interface SchemaField {
  /** Expected JavaScript type. */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Whether the field must be present. */
  required?: boolean;
  /** Default value if the field is absent. */
  default?: unknown;
  /** Allowed values (enum constraint). */
  enum?: unknown[];
  /** Minimum value (for numbers) or minimum length (for strings/arrays). */
  min?: number;
  /** Maximum value (for numbers) or maximum length (for strings/arrays). */
  max?: number;
  /** Schema for array items. */
  items?: SchemaField;
  /** Schema for object properties. */
  properties?: SchemaDefinition;
}

/** A map of field names to their schema descriptors. */
export type SchemaDefinition = Record<string, SchemaField>;
