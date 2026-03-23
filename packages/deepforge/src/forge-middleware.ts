/**
 * DeepForge 2.0 — Middleware Pipeline Engine
 *
 * Koa-style onion model with priority-based ordering, lifecycle hooks,
 * conditional skip, error isolation, execution timing, and ForgeEventBus integration.
 *
 * Hooks: beforeRun / afterRun / beforeIteration / afterIteration / onComplete
 *
 * Backward compatible: when no middleware is registered, execute() is a no-op
 * that returns the input context unchanged (zero overhead).
 *
 * @module forge-middleware
 */

// ─────────────── Imported Types ───────────────
// All core middleware types come from the canonical type definitions.
// This module re-exports them for backward compatibility.

import type {
  MiddlewareMessage,
  MiddlewareContextConfig,
  MiddlewareIterationInfo,
  MiddlewareMetadata,
  MiddlewareContext,
  MiddlewareNext,
  MiddlewareFn,
  MiddlewareOptions,
  MiddlewareRegistration,
  MiddlewareStatus,
  MiddlewareStepResult,
  MiddlewareResult,
  MiddlewarePipelineConfig,
  ForgePhase,
  PipelineConfig,
  LifecycleHook,
  AfterRunHook,
  PipelineHooks,
  MiddlewareEventEmitter,
  HookError,
} from './types/middleware';

// Re-export all imported types so consumers of this module
// don't need to change their import paths.
export type {
  MiddlewareMessage,
  MiddlewareContextConfig,
  MiddlewareIterationInfo,
  MiddlewareMetadata,
  MiddlewareContext,
  MiddlewareNext,
  MiddlewareFn,
  MiddlewareOptions,
  MiddlewareRegistration,
  MiddlewareStatus,
  MiddlewareStepResult,
  MiddlewareResult,
  MiddlewarePipelineConfig,
  ForgePhase,
  PipelineConfig,
  LifecycleHook,
  AfterRunHook,
  PipelineHooks,
  MiddlewareEventEmitter,
  HookError,
};

// ─────────────── Helpers ───────────────

let _runCounter = 0;
function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${(++_runCounter).toString(36)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Middleware "${label}" timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─────────────── MiddlewarePipeline ───────────────

/**
 * Middleware pipeline engine with onion-model execution.
 *
 * ```ts
 * const pipeline = new MiddlewarePipeline();
 * pipeline.use(myMiddleware, { name: 'logger', priority: 10 });
 * const result = await pipeline.execute(ctx);
 * ```
 *
 * Integration with ForgeEventBus:
 * ```ts
 * const bus = ForgeEventBus.shared();
 * const pipeline = new MiddlewarePipeline({ globalTimeout: 60_000 }, bus);
 * // Middleware lifecycle events are automatically emitted to the bus.
 * ```
 */
export class MiddlewarePipeline {
  private registrations: MiddlewareRegistration[] = [];
  private sorted = false;
  private readonly pipelineConfig: Required<PipelineConfig>;
  private readonly hooks: PipelineHooks = {
    beforeRun: [],
    afterRun: [],
    beforeIteration: [],
    afterIteration: [],
    onComplete: [],
  };
  private readonly eventEmitter: MiddlewareEventEmitter | null;

  constructor(config?: PipelineConfig, eventEmitter?: MiddlewareEventEmitter) {
    this.pipelineConfig = {
      globalTimeout: config?.globalTimeout ?? 120_000,
      continueOnError: config?.continueOnError ?? false,
      maxMiddleware: config?.maxMiddleware ?? 30,
    };
    this.eventEmitter = eventEmitter ?? null;
  }

  // ─── Registration ───

  /**
   * Register a middleware function with options.
   * If a middleware with the same name already exists, it is replaced (last wins).
   * Throws if the maximum middleware limit is reached.
   */
  use(fn: MiddlewareFn, options: MiddlewareOptions): this {
    if (this.registrations.length >= this.pipelineConfig.maxMiddleware) {
      throw new Error(
        `Pipeline limit reached: max ${this.pipelineConfig.maxMiddleware} middleware allowed`,
      );
    }
    const idx = this.registrations.findIndex(
      (r) => r.options.name === options.name,
    );
    const reg: MiddlewareRegistration = {
      fn,
      options: {
        name: options.name,
        enabled: options.enabled ?? true,
        priority: options.priority ?? 50,
        timeout: options.timeout ?? 30_000,
        continueOnError: options.continueOnError ?? false,
        shouldRun: options.shouldRun,
        blocking: options.blocking ?? false,
      },
    };
    if (idx >= 0) {
      this.registrations[idx] = reg;
    } else {
      this.registrations.push(reg);
    }
    this.sorted = false;
    return this;
  }

  /** Remove a middleware by name. Returns true if found. */
  remove(name: string): boolean {
    const idx = this.registrations.findIndex((r) => r.options.name === name);
    if (idx >= 0) {
      this.registrations.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Check if a middleware is registered by name. */
  has(name: string): boolean {
    return this.registrations.some((r) => r.options.name === name);
  }

  /** Return registered middleware names in priority order. */
  get chain(): string[] {
    this.ensureSorted();
    return this.registrations.map((r) => r.options.name);
  }

  /** Number of registered middleware. */
  get size(): number {
    return this.registrations.length;
  }

  /** Remove all middleware registrations and hooks. */
  clear(): void {
    this.registrations = [];
    this.sorted = false;
    this.hooks.beforeRun.length = 0;
    this.hooks.afterRun.length = 0;
    this.hooks.beforeIteration.length = 0;
    this.hooks.afterIteration.length = 0;
    this.hooks.onComplete.length = 0;
  }

  // ─── Lifecycle Hook Registration ───

  /** Register a hook called before the pipeline starts executing middleware. */
  onBeforeRun(hook: LifecycleHook): this {
    this.hooks.beforeRun.push(hook);
    return this;
  }

  /** Register a hook called after all middleware have finished (or errored). */
  onAfterRun(hook: AfterRunHook): this {
    this.hooks.afterRun.push(hook);
    return this;
  }

  /** Register a hook called at the start of an iteration (before middleware). */
  onBeforeIteration(hook: LifecycleHook): this {
    this.hooks.beforeIteration.push(hook);
    return this;
  }

  /** Register a hook called at the end of an iteration (after middleware). */
  onAfterIteration(hook: LifecycleHook): this {
    this.hooks.afterIteration.push(hook);
    return this;
  }

  /** Register a hook called when the engine signals project completion. */
  onComplete(hook: AfterRunHook): this {
    this.hooks.onComplete.push(hook);
    return this;
  }

  // ─── Execution ───

  /**
   * Execute all registered middleware in priority order using the onion model.
   *
   * When no middleware is registered, returns the input context unchanged
   * (backward compatible — zero overhead).
   */
  async execute(ctx: MiddlewareContext): Promise<MiddlewareResult> {
    const pipelineStart = Date.now();
    const steps: MiddlewareStepResult[] = [];

    // Backward compat: nothing to do
    if (this.registrations.length === 0) {
      return {
        context: ctx,
        success: true,
        steps: [],
        totalDurationMs: 0,
      };
    }

    this.ensureSorted();

    // Populate metadata
    const runId = generateRunId();
    ctx.metadata = {
      ...ctx.metadata,
      runId,
      chain: this.registrations.map((r) => r.options.name),
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    };

    // Fire beforeRun hooks
    await this.fireHooks(this.hooks.beforeRun, ctx);

    let finalCtx = ctx;
    let success = true;
    let shortCircuitedBy: string | undefined;
    let topError: string | undefined;

    try {
      finalCtx = await this.executeWithGlobalTimeout(ctx, steps);
    } catch (err) {
      success = false;
      topError = err instanceof Error ? err.message : String(err);
      if (ctx.metadata.aborted) {
        shortCircuitedBy = ctx.metadata.abortReason ?? 'abort()';
      }
    }

    const result: MiddlewareResult = {
      context: finalCtx,
      success,
      steps,
      totalDurationMs: Date.now() - pipelineStart,
      shortCircuitedBy,
      error: topError,
    };

    // Fire afterRun hooks (best-effort)
    await this.fireAfterHooks(this.hooks.afterRun, result);

    return result;
  }

  /**
   * Fire beforeIteration hooks.
   * Called by the engine at the start of each iteration.
   */
  async fireBeforeIteration(ctx: MiddlewareContext): Promise<void> {
    await this.fireHooks(this.hooks.beforeIteration, ctx);
  }

  /**
   * Fire afterIteration hooks.
   * Called by the engine at the end of each iteration.
   */
  async fireAfterIteration(ctx: MiddlewareContext): Promise<void> {
    await this.fireHooks(this.hooks.afterIteration, ctx);
  }

  /**
   * Fire onComplete hooks.
   * Called by the engine when the project finishes.
   */
  async fireOnComplete(result: MiddlewareResult): Promise<void> {
    await this.fireAfterHooks(this.hooks.onComplete, result);
  }

  // ─── Internals ───

  /** Sort registrations by priority (stable sort — insertion order for equal priority). */
  private ensureSorted(): void {
    if (this.sorted) return;
    this.registrations.sort((a, b) => a.options.priority - b.options.priority);
    this.sorted = true;
  }

  /** Build the onion chain and execute with global timeout. */
  private async executeWithGlobalTimeout(
    ctx: MiddlewareContext,
    steps: MiddlewareStepResult[],
  ): Promise<MiddlewareContext> {
    const run = this.buildOnion(ctx, steps);
    if (this.pipelineConfig.globalTimeout > 0) {
      return withTimeout(run, this.pipelineConfig.globalTimeout, 'pipeline');
    }
    return run;
  }

  /**
   * Build and execute the onion-model chain.
   *
   * Each middleware receives a `next()` that invokes the next middleware.
   * Middleware can run logic before and after `next()` (onion layers).
   */
  private async buildOnion(
    ctx: MiddlewareContext,
    steps: MiddlewareStepResult[],
  ): Promise<MiddlewareContext> {
    const regs = this.registrations;
    let index = -1;

    const dispatch = async (i: number, current: MiddlewareContext): Promise<MiddlewareContext> => {
      if (i <= index) {
        throw new Error('next() called multiple times within the same middleware');
      }
      index = i;

      // Past the last middleware — return context (innermost layer)
      if (i >= regs.length) return current;

      const reg = regs[i];
      current.metadata.currentIndex = i;

      // ── Skip: disabled ──
      if (!reg.options.enabled) {
        steps.push({ name: reg.options.name, status: 'skipped', durationMs: 0, blocking: reg.options.blocking });
        return dispatch(i + 1, current);
      }

      // ── Skip: shouldRun predicate ──
      if (reg.options.shouldRun && !reg.options.shouldRun(current)) {
        steps.push({ name: reg.options.name, status: 'skipped', durationMs: 0, blocking: reg.options.blocking });
        return dispatch(i + 1, current);
      }

      // ── Skip: pipeline aborted ──
      if (current.metadata.aborted) {
        steps.push({ name: reg.options.name, status: 'aborted', durationMs: 0, blocking: reg.options.blocking });
        return dispatch(i + 1, current);
      }

      // ── Execute middleware ──
      const stepStart = Date.now();
      const next: MiddlewareNext = () => dispatch(i + 1, current);

      // Emit middleware_enter event
      this.emitMiddlewareEvent('middleware_enter', reg.options.name, `Entering middleware: ${reg.options.name}`);

      try {
        let resultCtx: MiddlewareContext;

        if (reg.options.timeout > 0) {
          resultCtx = await withTimeout(
            reg.fn(current, next),
            reg.options.timeout,
            reg.options.name,
          );
        } else {
          resultCtx = await reg.fn(current, next);
        }

        const elapsed = Date.now() - stepStart;
        current.metadata.timing[reg.options.name] = elapsed;
        steps.push({ name: reg.options.name, status: 'executed', durationMs: elapsed, blocking: reg.options.blocking });

        // Emit middleware_exit event
        this.emitMiddlewareEvent('middleware_exit', reg.options.name, `Exited middleware: ${reg.options.name} (${elapsed}ms)`, elapsed);

        return resultCtx;
      } catch (err) {
        const elapsed = Date.now() - stepStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes('timed out');

        steps.push({
          name: reg.options.name,
          status: isTimeout ? 'timeout' : 'error',
          durationMs: elapsed,
          error: errMsg,
          blocking: reg.options.blocking,
        });

        // Emit middleware_error event
        this.emitMiddlewareEvent('middleware_error', reg.options.name, `Middleware error: ${reg.options.name} — ${errMsg}`, elapsed, errMsg);

        const canContinue =
          reg.options.continueOnError || this.pipelineConfig.continueOnError;

        if (canContinue) {
          return dispatch(i + 1, current);
        }

        throw err;
      }
    };

    return dispatch(0, ctx);
  }

  /** Fire lifecycle hooks (ctx-based). Errors are caught, logged, and propagated via ctx.state.hookErrors. */
  private async fireHooks(hooks: LifecycleHook[], ctx: MiddlewareContext): Promise<void> {
    const errors: HookError[] = [];
    for (const hook of hooks) {
      try {
        await hook(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hookName = hook.name || '(anonymous)';
        console.error('[forge-middleware] Hook error:', message);
        errors.push({ message, hook: hookName });
      }
    }
    if (errors.length > 0) {
      const existing: HookError[] = ctx.state.hookErrors ?? [];
      ctx.state.hookErrors = [...existing, ...errors];
    }
  }

  /** Fire afterRun / onComplete hooks (result-based). Errors are caught, logged, and propagated via result.context.state.hookErrors. */
  private async fireAfterHooks(hooks: AfterRunHook[], result: MiddlewareResult): Promise<void> {
    const errors: HookError[] = [];
    for (const hook of hooks) {
      try {
        await hook(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hookName = hook.name || '(anonymous)';
        console.error('[forge-middleware] AfterRun hook error:', message);
        errors.push({ message, hook: hookName });
      }
    }
    if (errors.length > 0) {
      const existing: HookError[] = result.context.state.hookErrors ?? [];
      result.context.state.hookErrors = [...existing, ...errors];
    }
  }

  /** Emit a middleware lifecycle event to the event bus (fire-and-forget). */
  private emitMiddlewareEvent(
    type: 'middleware_enter' | 'middleware_exit' | 'middleware_error',
    middlewareName: string,
    message: string,
    durationMs?: number,
    error?: string,
  ): void {
    if (!this.eventEmitter) return;
    try {
      // Fire-and-forget — don't block the pipeline on event handlers
      void this.eventEmitter.emit({
        type,
        timestamp: new Date().toISOString(),
        message,
        middlewareName,
        durationMs,
        error,
      });
    } catch {
      // Event emission must never break the pipeline
    }
  }
}

// ─────────────── Factory Helpers ───────────────

/**
 * Create a fresh MiddlewareContext with sensible defaults.
 * Used by the engine before entering the pipeline.
 */
export function createMiddlewareContext(
  overrides?: Partial<MiddlewareContext>,
): MiddlewareContext {
  return {
    messages: overrides?.messages ?? [],
    config: overrides?.config ?? {
      projectId: '',
      model: '',
      effort: 'medium',
      maxConcurrent: 5,
      phase: 'setup',
    },
    iteration: overrides?.iteration ?? undefined,
    state: overrides?.state ?? {},
    metadata: overrides?.metadata ?? {
      runId: '',
      chain: [],
      currentIndex: 0,
      startedAt: '',
      timing: {},
      aborted: false,
    },
  };
}

/**
 * Utility: create an abort handle for a context.
 * Calling the returned function sets `metadata.aborted = true` with a reason,
 * causing subsequent middleware in the chain to be skipped.
 */
export function createAbortHandle(ctx: MiddlewareContext): (reason?: string) => void {
  return (reason?: string) => {
    ctx.metadata.aborted = true;
    ctx.metadata.abortReason = reason ?? 'abort() called';
  };
}
