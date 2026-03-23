/**
 * DeepForge 2.0 — Middleware Pipeline Type Definitions
 *
 * Defines the complete type system for DeepForge's middleware pipeline:
 * - Koa-style onion model with `(ctx, next) => Promise<ctx>`
 * - Priority-based ordering (lower numbers execute first)
 * - Lifecycle hooks: beforeRun / afterRun / beforeIteration / afterIteration / onComplete
 * - Conditional execution via `shouldRun` predicate
 * - Per-middleware timeout and error isolation
 *
 * Inspired by DeerFlow's layered middleware architecture, adapted for
 * DeepForge's TypeScript multi-agent orchestration engine.
 *
 * @module types/middleware
 */

// ─── Re-export core types used by middleware consumers ───
// These mirror the shapes from the main types.ts to keep middleware self-contained.
// When integrated, replace with: import type { ForgePhase, ForgeProject } from '../../types.js';

/** Forge execution phase — mirrors ForgePhase from types.ts */
export type ForgePhase =
  | 'setup'
  | 'planning'
  | 'executing'
  | 'critiquing'
  | 'verifying'
  | 'iterating'
  | 'completing'
  | 'paused'
  | 'completed';

// ============ Messages ============

/**
 * Minimal message shape flowing through the middleware pipeline.
 * Compatible with LLM chat message formats (OpenAI, Anthropic).
 */
export interface MiddlewareMessage {
  /** Message role in the conversation */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content of the message */
  content: string;
  /** Optional sender name (for multi-agent conversations) */
  name?: string;
  /** Tool call ID for tool-response messages */
  toolCallId?: string;
}

// ============ Hook Errors ============

/**
 * Represents an error captured during lifecycle hook execution.
 * Collected by the pipeline engine and surfaced via `ctx.state.hookErrors`.
 */
export interface HookError {
  /** Error message from the caught exception */
  message: string;
  /** Name of the hook function that threw */
  hook: string;
}

/**
 * Well-known keys in the middleware state bag.
 * Extends `Record<string, unknown>` so middleware can still add arbitrary keys.
 */
export interface MiddlewareState extends Record<string, unknown> {
  /** Hook errors collected during lifecycle hook execution */
  hookErrors?: HookError[];
}

// ============ Context ============

/**
 * Project configuration subset visible to middleware.
 * Provides read-only access to relevant project settings without
 * exposing the full ForgeProject internals.
 */
export interface MiddlewareContextConfig {
  /** Unique project identifier */
  projectId: string;
  /** LLM model identifier (e.g. "claude-opus-4-6") */
  model: string;
  /** LLM effort/quality level */
  effort: string;
  /** Maximum concurrent task execution slots */
  maxConcurrent: number;
  /** Current execution phase */
  phase: ForgePhase;
  /** Current iteration number (1-based), if inside an iteration */
  iteration?: number;
  /** Arbitrary config extensions from presets or plugins */
  [key: string]: unknown;
}

/**
 * Iteration snapshot — represents the current iteration's state
 * as visible to middleware during execution.
 */
export interface MiddlewareIterationInfo {
  /** 1-based iteration number */
  number: number;
  /** Total tasks in this iteration */
  taskCount: number;
  /** Number of tasks completed so far */
  completedCount: number;
  /** Number of tasks that have failed */
  failedCount: number;
  /** Whether the previous iteration's critic cleared */
  previousCriticCleared?: boolean;
  /** Whether the previous iteration's verifier passed */
  previousVerifierPassed?: boolean;
}

/**
 * Metadata attached to a pipeline invocation.
 * Tracks execution progress, timing, and abort state.
 */
export interface MiddlewareMetadata {
  /** Unique ID for this pipeline run (UUID v4) */
  runId: string;
  /** Ordered list of middleware names in the execution chain */
  chain: string[];
  /** Index of the currently executing middleware in the chain */
  currentIndex: number;
  /** ISO 8601 timestamp when this pipeline run started */
  startedAt: string;
  /** Accumulated execution time per middleware (name → milliseconds) */
  timing: Record<string, number>;
  /** Whether `abort()` has been called on this run */
  aborted: boolean;
  /** Human-readable reason if the run was aborted */
  abortReason?: string;
}

/**
 * The context object passed through each middleware in the pipeline.
 *
 * Middleware receives this context and returns a (potentially modified) copy.
 * The `state` bag enables inter-middleware communication without tight coupling.
 *
 * @example
 * ```ts
 * const myMiddleware: MiddlewareFn = async (ctx, next) => {
 *   ctx.state['my-key'] = computeValue(ctx.messages);
 *   const result = await next();
 *   // Post-processing after downstream middleware
 *   return result;
 * };
 * ```
 */
export interface MiddlewareContext {
  /** Current conversation messages (mutable — middleware may prepend/append) */
  messages: MiddlewareMessage[];

  /** Read-only project configuration snapshot */
  config: Readonly<MiddlewareContextConfig>;

  /** Current iteration info (undefined during setup phase) */
  iteration: MiddlewareIterationInfo | undefined;

  /**
   * Mutable state bag for inter-middleware data sharing.
   * Middleware should namespace their keys to avoid collisions
   * (e.g. `'quality-gate:verdict'`, `'memory:retrieved'`).
   * Includes well-known typed keys like `hookErrors`.
   */
  state: MiddlewareState;

  /** Pipeline execution metadata (timing, chain, abort state) */
  metadata: MiddlewareMetadata;
}

// ============ Middleware Function ============

/**
 * Callback to invoke the next middleware in the chain.
 * If not called, downstream middleware is skipped (short-circuit).
 */
export type MiddlewareNext = () => Promise<MiddlewareContext>;

/**
 * Core middleware function signature — Koa-style onion model.
 *
 * Each middleware:
 * 1. Receives the current context and a `next` callback
 * 2. May modify the context before calling `next()`
 * 3. Must call `next()` to continue the chain (or return early to short-circuit)
 * 4. May post-process the result returned by `next()`
 * 5. Returns the (potentially modified) context
 *
 * @example
 * ```ts
 * const timingMiddleware: MiddlewareFn = async (ctx, next) => {
 *   const start = Date.now();
 *   const result = await next();
 *   result.metadata.timing['my-timing'] = Date.now() - start;
 *   return result;
 * };
 * ```
 */
export type MiddlewareFn = (
  ctx: MiddlewareContext,
  next: MiddlewareNext,
) => Promise<MiddlewareContext>;

// ============ Middleware Options ============

/**
 * Configuration for registering a middleware in the pipeline.
 */
export interface MiddlewareOptions {
  /**
   * Human-readable name used in logs, timing reports, and chain metadata.
   * Must be unique within a pipeline instance.
   */
  name: string;

  /**
   * Whether this middleware is active. Disabled middleware is silently skipped.
   * @default true
   */
  enabled?: boolean;

  /**
   * Execution priority — lower numbers run first (outer layers of the onion).
   *
   * Recommended ranges (aligned with DeerFlow):
   * -  10: Thread/data setup
   * -  20: File handling, uploads
   * -  30: Sandbox management
   * -  40: Error recovery, dangling call fixes
   * -  50: Context enrichment (default)
   * -  60: Task/progress tracking
   * -  70: Metadata, titles
   * -  80: Memory management
   * -  90: Media processing
   * - 100: Concurrency/subagent limits
   * - 110: Loop detection, clarification
   *
   * @default 50
   */
  priority?: number;

  /**
   * Per-middleware timeout in milliseconds.
   * If exceeded, the middleware is aborted and marked as 'timeout'.
   * Set to 0 to disable timeout for this middleware.
   * @default 30000
   */
  timeout?: number;

  /**
   * If true, errors thrown by this middleware are caught and logged,
   * and execution continues with the next middleware.
   * If false (default), an error aborts the entire pipeline.
   * @default false
   */
  continueOnError?: boolean;

  /**
   * Optional predicate evaluated at runtime with the current context.
   * If it returns `false`, this middleware is skipped for this invocation.
   * Useful for phase-specific or config-conditional middleware.
   *
   * @example
   * ```ts
   * shouldRun: (ctx) => ctx.config.phase === 'executing'
   * ```
   */
  shouldRun?: (ctx: MiddlewareContext) => boolean;
}

// ============ Middleware Interface (class-based) ============

/**
 * Class-based middleware interface.
 *
 * Use this when middleware needs internal state, configuration,
 * or lifecycle management. For simple stateless middleware,
 * prefer the functional `MiddlewareFn` signature instead.
 *
 * @example
 * ```ts
 * class LoggingMiddleware implements Middleware {
 *   readonly name = 'logging';
 *   readonly priority = 10;
 *
 *   async execute(ctx: MiddlewareContext, next: MiddlewareNext) {
 *     console.log(`[${ctx.config.phase}] Running pipeline...`);
 *     const result = await next();
 *     console.log(`Pipeline completed in ${result.metadata.timing}`);
 *     return result;
 *   }
 * }
 * ```
 */
export interface Middleware {
  /** Unique middleware name */
  readonly name: string;

  /**
   * Execution priority (lower = earlier).
   * @see MiddlewareOptions.priority for recommended ranges
   */
  readonly priority: number;

  /**
   * Whether this middleware is currently active.
   * @default true
   */
  readonly enabled?: boolean;

  /**
   * Per-middleware timeout in milliseconds.
   * @default 30000
   */
  readonly timeout?: number;

  /**
   * If true, errors are caught and skipped instead of aborting the pipeline.
   * @default false
   */
  readonly continueOnError?: boolean;

  /** Optional runtime predicate — return false to skip this invocation */
  shouldRun?(ctx: MiddlewareContext): boolean;

  /** The middleware handler — same semantics as MiddlewareFn */
  execute(ctx: MiddlewareContext, next: MiddlewareNext): Promise<MiddlewareContext>;
}

// ============ Registration ============

/**
 * Internal registration record stored by the pipeline engine.
 * Combines the resolved handler function with fully-defaulted options.
 */
export interface MiddlewareRegistration {
  /** The middleware handler function */
  fn: MiddlewareFn;
  /** Fully resolved options (all defaults applied) */
  options: Required<Omit<MiddlewareOptions, 'shouldRun'>> & {
    shouldRun?: (ctx: MiddlewareContext) => boolean;
  };
}

// ============ Step & Pipeline Results ============

/** Outcome status of a single middleware execution step */
export type MiddlewareStatus = 'executed' | 'skipped' | 'error' | 'timeout' | 'aborted';

/**
 * Execution result for a single middleware step.
 * Collected by the pipeline engine for observability.
 */
export interface MiddlewareStepResult {
  /** Middleware name */
  name: string;
  /** Outcome status */
  status: MiddlewareStatus;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Error message if status is 'error' or 'timeout' */
  error?: string;
}

/**
 * Complete result of a pipeline run.
 * Contains the final context, per-step results, and aggregate metrics.
 */
export interface MiddlewareResult {
  /** Final context after all middleware have executed */
  context: MiddlewareContext;
  /** Whether the pipeline completed without fatal errors */
  success: boolean;
  /** Per-middleware step results in execution order */
  steps: MiddlewareStepResult[];
  /** Total pipeline duration in milliseconds */
  totalDurationMs: number;
  /** Middleware name that caused a short-circuit (if any) */
  shortCircuitedBy?: string;
  /** Top-level error message if the pipeline itself failed */
  error?: string;
}

// ============ Pipeline Configuration ============

/**
 * Configuration for the MiddlewarePipeline engine.
 */
export interface MiddlewarePipelineConfig {
  /**
   * Global timeout for the entire pipeline run in milliseconds.
   * Individual middleware timeouts are separate and run concurrently.
   * @default 120000
   */
  globalTimeout: number;

  /**
   * Whether to continue executing remaining middleware after one throws.
   * When true, errors are recorded in step results but don't abort the pipeline.
   * Individual middleware can override this via `continueOnError`.
   * @default false
   */
  continueOnError: boolean;

  /**
   * Maximum number of middleware registrations allowed.
   * Prevents accidental runaway registration.
   * @default 20
   */
  maxMiddleware: number;

  /**
   * Hook called before the pipeline starts executing middleware.
   * Receives the initial context. Can be used for logging, validation, or setup.
   */
  onBeforeRun?: (ctx: MiddlewareContext) => void | Promise<void>;

  /**
   * Hook called after the pipeline completes (success or failure).
   * Receives the full pipeline result including per-step metrics.
   */
  onAfterRun?: (result: MiddlewareResult) => void | Promise<void>;

  /**
   * Hook called before each iteration begins (phase transitions to 'planning').
   * Receives the iteration number and current context.
   */
  onBeforeIteration?: (iteration: number, ctx: MiddlewareContext) => void | Promise<void>;

  /**
   * Hook called after each iteration completes (all tasks done, critic/verifier finished).
   * Receives the iteration number and final context.
   */
  onAfterIteration?: (iteration: number, ctx: MiddlewareContext) => void | Promise<void>;

  /**
   * Hook called when the entire forge run completes (phase transitions to 'completed').
   * Receives the final pipeline result.
   */
  onComplete?: (result: MiddlewareResult) => void | Promise<void>;
}

/**
 * Convenience alias with all fields optional — used by MiddlewarePipeline constructor.
 * Internally defaults are applied from PIPELINE_CONFIG_DEFAULTS.
 */
export type PipelineConfig = Partial<Pick<MiddlewarePipelineConfig, 'globalTimeout' | 'continueOnError' | 'maxMiddleware'>>;

// ============ Lifecycle Hook Types (Pipeline Engine) ============

/** Hook receiving a context (used for beforeRun, beforeIteration, afterIteration) */
export type LifecycleHook = (ctx: MiddlewareContext) => void | Promise<void>;

/** Hook receiving a pipeline result (used for afterRun, onComplete) */
export type AfterRunHook = (result: MiddlewareResult) => void | Promise<void>;

/** All hook arrays managed by the pipeline engine */
export interface PipelineHooks {
  beforeRun: LifecycleHook[];
  afterRun: AfterRunHook[];
  beforeIteration: LifecycleHook[];
  afterIteration: LifecycleHook[];
  onComplete: AfterRunHook[];
}

// ============ Event Bus Integration ============

/**
 * Minimal event emitter interface for ForgeEventBus integration.
 * Decoupled from the concrete ForgeEventBus class to avoid circular deps.
 */
export interface MiddlewareEventEmitter {
  emit(event: {
    type: string;
    timestamp: string;
    message: string;
    middlewareName: string;
    durationMs?: number;
    error?: string;
  }): void | Promise<void>;
}

// ============ Lifecycle Hooks (Class-based Middleware) ============

/**
 * Optional lifecycle hooks that class-based middleware can implement.
 * Called by the pipeline engine at registration and teardown time.
 */
export interface MiddlewareLifecycle {
  /** Called once when the middleware is registered in a pipeline */
  onRegister?(): void | Promise<void>;
  /** Called once when the pipeline is being destroyed/torn down */
  onDestroy?(): void | Promise<void>;
}

/**
 * Full middleware definition — used when implementing middleware as a class
 * that also needs lifecycle management.
 */
export interface MiddlewareDefinition extends MiddlewareLifecycle {
  /** The middleware handler function */
  handle: MiddlewareFn;
  /** Registration options */
  options: MiddlewareOptions;
}

// ============ Built-in Middleware Names ============

/**
 * Well-known middleware names for DeepForge's standard pipeline layers.
 * Aligned with DeerFlow's middleware concepts, adapted for the
 * TypeScript multi-agent orchestration architecture.
 */
export const MIDDLEWARE_NAMES = {
  /** Enriches context with project state, file contents, iteration history */
  CONTEXT_ENRICHMENT: 'context-enrichment',
  /** Evaluates output quality and emits structured verdicts */
  QUALITY_GATE: 'quality-gate',
  /** Retrieves and stores conversation memory */
  MEMORY: 'memory',
  /** Enforces concurrent task execution limits */
  CONCURRENCY: 'concurrency',
  /** Auto-summarizes large outputs to manage context window */
  SUMMARIZATION: 'summarization',
  /** Tracks task progress and updates iteration state */
  TASK_TRACKING: 'task-tracking',
  /** Handles errors gracefully with retry/fallback strategies */
  ERROR_RECOVERY: 'error-recovery',
  /** Tracks and reports LLM API cost per task */
  COST_TRACKING: 'cost-tracking',
  /** Emits ForgeEvents to the event bus for observability */
  EVENT_EMISSION: 'event-emission',
  /** Injects role-specific system prompts and context */
  ROLE_INJECTION: 'role-injection',
  /** Guards against runaway execution with configurable timeouts */
  TIMEOUT_GUARD: 'timeout-guard',
  /** Detects and breaks repetitive LLM output loops */
  LOOP_DETECTION: 'loop-detection',
  /** Tracks file artifacts and maintains the index */
  ARTIFACT_TRACKING: 'artifact-tracking',
} as const;

/** Union type of all built-in middleware name string literals */
export type BuiltinMiddlewareName =
  (typeof MIDDLEWARE_NAMES)[keyof typeof MIDDLEWARE_NAMES];

// ============ Abort Handle ============

/**
 * Abort handle for programmatically cancelling a pipeline run.
 * Middleware can check `signal.aborted` and the pipeline engine
 * uses it to coordinate cancellation across async boundaries.
 */
export interface AbortHandle {
  /** Whether abort has been requested */
  readonly aborted: boolean;
  /** Human-readable reason for the abort */
  readonly reason?: string;
  /** Request pipeline abort with an optional reason */
  abort(reason?: string): void;
}

// ============ Factory Helpers ============

/**
 * Input type for creating a MiddlewareContext.
 * All optional fields will be filled with defaults by the factory function.
 */
export interface CreateMiddlewareContextInput {
  /** Initial messages (defaults to empty array) */
  messages?: MiddlewareMessage[];
  /** Project config (required) */
  config: MiddlewareContextConfig;
  /** Current iteration info */
  iteration?: MiddlewareIterationInfo;
  /** Initial state bag entries */
  state?: MiddlewareState;
  /** Partial metadata overrides */
  metadata?: Partial<MiddlewareMetadata>;
}

/**
 * Default values for MiddlewareOptions.
 * Used by the pipeline engine when registering middleware with partial options.
 */
export const MIDDLEWARE_OPTION_DEFAULTS: Required<Omit<MiddlewareOptions, 'name' | 'shouldRun'>> = {
  enabled: true,
  priority: 50,
  timeout: 30_000,
  continueOnError: false,
};

/**
 * Default values for MiddlewarePipelineConfig.
 * Used when creating a pipeline without explicit configuration.
 */
export const PIPELINE_CONFIG_DEFAULTS: Required<Omit<MiddlewarePipelineConfig,
  'onBeforeRun' | 'onAfterRun' | 'onBeforeIteration' | 'onAfterIteration' | 'onComplete'
>> = {
  globalTimeout: 120_000,
  continueOnError: false,
  maxMiddleware: 20,
};
