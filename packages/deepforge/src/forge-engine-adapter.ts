/**
 * DeepForge 2.0 — Engine Initialization Adapter
 *
 * Factory functions to create and destroy all engine subsystems from
 * a unified ForgeConfig. This is the single integration point that
 * wires EventBus, Memory, ConfigManager, Pipeline, and Semaphore together.
 *
 * Design decisions:
 * - Each subsystem is created with config slices extracted from ForgeConfig
 * - Memory events are bridged to ForgeEventBus automatically
 * - Pipeline receives the EventBus as its event emitter
 * - Semaphore callbacks emit structured events to the EventBus
 * - destroyForgeSubsystems() calls dispose/cleanup on each subsystem
 * - Uses only `as const` assertions (8 occurrences) — zero as any, as unknown, or Record casts
 *
 * @module forge-engine-adapter
 */

import type { ForgeConfig } from './types/config';
import type { ForgeEventBusConfig, ForgeEvent } from './types/event';
import type { MemoryStoreConfig } from './types/memory';
import type { PipelineConfig, MiddlewareEventEmitter } from './types/middleware';
import type { SemaphoreCallbacks } from './forge-semaphore';

import { MemoryEventType } from './types/memory';

import { ForgeEventBus, createForgeEvent } from './forge-events';
import { ForgeMemory } from './forge-memory';
import { ForgeConfigManager } from './forge-config';
import { MiddlewarePipeline } from './forge-middleware';
import { AsyncSemaphore } from './forge-semaphore';
import { ForgeDashboard } from './forge-dashboard';

// ─── Subsystem Container ─────────────────────────────────────────────────────

/** All engine subsystems, created together and destroyed together. */
export interface ForgeSubsystems {
  /** Structured event stream — pub/sub with history and persistence. */
  eventBus: ForgeEventBus;
  /** Cross-session persistent memory with prompt injection. */
  memory: ForgeMemory;
  /** Central configuration manager with validation and hot-reload. */
  configManager: ForgeConfigManager;
  /** Middleware pipeline engine (onion model). */
  pipeline: MiddlewarePipeline;
  /** Async semaphore for concurrency control. */
  semaphore: AsyncSemaphore;
  /** Aggregated dashboard state manager — consumes events for UI rendering. */
  dashboard: ForgeDashboard;
}

// ─── Config Extraction Helpers ───────────────────────────────────────────────

/**
 * Extract ForgeEventBusConfig from the top-level ForgeConfig.events section.
 */
function extractEventBusConfig(config: ForgeConfig): ForgeEventBusConfig {
  return {
    historyLimit: config.events.bufferSize,
    emitHandlerErrors: true,
    // persistToDisk is handled at ForgeConfig level; if enabled,
    // the engine should set jsonlPath at a higher level based on project dir
    jsonlPath: config.events.persistToDisk
      ? '.deepforge/forge-events.jsonl'
      : undefined,
  };
}

/**
 * Extract MemoryStoreConfig from the top-level ForgeConfig.memory section.
 */
function extractMemoryConfig(config: ForgeConfig): Partial<MemoryStoreConfig> {
  return {
    enabled: config.memory.enabled,
    storagePath: config.memory.storagePath,
    maxEntries: config.memory.maxEntries,
    debounceMs: config.memory.debounceMs,
    pruneConfidenceThreshold: config.memory.pruneConfidenceThreshold,
    pruneRelevanceThreshold: config.memory.pruneRelevanceThreshold,
    autoExtract: config.memory.autoExtract,
    injectionCount: config.memory.injectionCount,
    injectionEnabled: config.memory.injectionEnabled,
    maxInjectionTokens: config.memory.maxInjectionTokens,
  };
}

/**
 * Extract PipelineConfig from the top-level ForgeConfig.
 * globalTimeout is derived from concurrency.acquireTimeoutMs as a sensible default.
 */
function extractPipelineConfig(config: ForgeConfig): PipelineConfig {
  return {
    globalTimeout: config.concurrency.acquireTimeoutMs * 4, // pipeline-level timeout
    continueOnError: false,
    maxMiddleware: 30,
  };
}

// ─── Pipeline EventEmitter Adapter (F1 fix) ─────────────────────────────────

/**
 * Wraps a ForgeEventBus into the MiddlewareEventEmitter interface expected
 * by MiddlewarePipeline's constructor.
 *
 * MiddlewareEventEmitter.emit() accepts a plain object with {type, timestamp, message, middlewareName, ...}.
 * ForgeEventBus.emit() accepts a discriminated ForgeEvent union.
 * This adapter maps middleware events to 'middleware_enter' / 'middleware_exit' / 'middleware_error'
 * ForgeEvent shapes.
 */
function createPipelineEventEmitter(eventBus: ForgeEventBus): MiddlewareEventEmitter {
  return {
    emit(event: {
      type: string;
      timestamp: string;
      message: string;
      middlewareName: string;
      durationMs?: number;
      error?: string;
    }): void {
      // Map the generic middleware event to a typed ForgeEvent
      let forgeEvent: ForgeEvent;

      if (event.error) {
        forgeEvent = createForgeEvent({
          type: 'middleware_error' as const,
          timestamp: event.timestamp,
          message: event.message,
          middlewareName: event.middlewareName,
          error: event.error,
          recovered: true, // pipeline continues if continueOnError is set
        });
      } else if (event.durationMs !== undefined) {
        forgeEvent = createForgeEvent({
          type: 'middleware_exit' as const,
          timestamp: event.timestamp,
          message: event.message,
          middlewareName: event.middlewareName,
          durationMs: event.durationMs,
        });
      } else {
        forgeEvent = createForgeEvent({
          type: 'middleware_enter' as const,
          timestamp: event.timestamp,
          message: event.message,
          middlewareName: event.middlewareName,
          hook: 'execute',
        });
      }

      // Fire-and-forget — pipeline must not block on event emission
      void eventBus.emit(forgeEvent);
    },
  };
}

// ─── Memory ↔ EventBus Bridge (F2 fix) ───────────────────────────────────────

/**
 * Wire ForgeMemory events into ForgeEventBus.
 *
 * ForgeMemory uses a callback-based event emitter (MemoryEventEmitter).
 * This function bridges those callbacks into structured ForgeEventBus events.
 *
 * MemoryUpdateEvent requires: { type, timestamp, message, entryCount, updateSource }
 * MemoryPruneEvent requires: { type, timestamp, message, prunedCount, remainingCount }
 */
function bridgeMemoryToEventBus(memory: ForgeMemory, eventBus: ForgeEventBus): void {
  const updateTypes: ReadonlySet<MemoryEventType> = new Set([
    MemoryEventType.Loaded,
    MemoryEventType.Saved,
    MemoryEventType.EntryAdded,
    MemoryEventType.EntryUpdated,
    MemoryEventType.EntryRemoved,
    MemoryEventType.ContextUpdated,
    MemoryEventType.Extracted,
    MemoryEventType.CrossProjectImported,
  ]);

  memory.setEventEmitter((payload) => {
    const isPrune = payload.eventType === MemoryEventType.Pruned;
    const isUpdate = updateTypes.has(payload.eventType);

    if (!isUpdate && !isPrune) return; // Unknown event type — skip silently

    if (isPrune) {
      const prunedCount = payload.entryIds?.length ?? payload.entryCount ?? 0;
      const event = createForgeEvent({
        type: 'memory_prune' as const,
        message: `Memory pruned: ${prunedCount} entries removed`,
        source: 'ForgeMemory',
        prunedCount,
        remainingCount: payload.remainingCount ?? -1, // -1 = unknown; pruneEntries always provides this value
      });
      void eventBus.emit(event);
    } else {
      const event = createForgeEvent({
        type: 'memory_update' as const,
        message: `Memory ${payload.eventType}: ${payload.entryCount ?? 0} entries`,
        source: 'ForgeMemory',
        entryCount: payload.entryCount ?? 0,
        updateSource: payload.eventType,
      });
      void eventBus.emit(event);
    }
  });
}

// ─── Semaphore ↔ EventBus Bridge ─────────────────────────────────────────────

/**
 * Create SemaphoreCallbacks that emit structured events to the ForgeEventBus.
 *
 * SemaphoreAcquireEvent: { taskId, activeCount, maxPermits }
 * SemaphoreReleaseEvent: { taskId, activeCount }
 * SemaphoreTimeoutEvent: { taskId, waitedMs }
 *
 * Note: SemaphoreStats provides running/waiting/available/max, but the event
 * interfaces use taskId/activeCount/maxPermits. Since the semaphore callback
 * doesn't provide taskId, we use a placeholder — the engine should set the
 * real taskId when wrapping semaphore.withLock() calls.
 */
function createSemaphoreCallbacks(eventBus: ForgeEventBus): SemaphoreCallbacks {
  return {
    onAcquire: (stats) => {
      const event = createForgeEvent({
        type: 'semaphore_acquire' as const,
        message: `Semaphore acquired: ${stats.running}/${stats.max} slots in use`,
        source: 'AsyncSemaphore',
        taskId: `sem-task-${stats.totalAcquired}`,
        activeCount: stats.running,
        maxPermits: stats.max,
      });
      void eventBus.emit(event);
    },
    onRelease: (stats) => {
      const event = createForgeEvent({
        type: 'semaphore_release' as const,
        message: `Semaphore released: ${stats.running}/${stats.max} slots in use`,
        source: 'AsyncSemaphore',
        taskId: `sem-task-${stats.totalReleased}`,
        activeCount: stats.running,
      });
      void eventBus.emit(event);
    },
    onTimeout: (stats) => {
      // TODO: SemaphoreStats does not carry the actual wait duration.
      // The timeout fires after the configured `timeoutMs` in AcquireOptions,
      // but that value is not forwarded to the callback. To get accurate
      // waitedMs, the engine layer should wrap withLock() to measure elapsed
      // time and override this field on the emitted event.
      const event = createForgeEvent({
        type: 'semaphore_timeout' as const,
        message: `Semaphore acquire timed out: ${stats.waiting} waiters, ${stats.totalTimedOut} total timeouts`,
        source: 'AsyncSemaphore',
        taskId: `sem-timeout-${stats.totalTimedOut}`,
        waitedMs: -1, // unavailable from SemaphoreStats; see TODO above
      });
      void eventBus.emit(event);
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create all engine subsystems from a unified ForgeConfig.
 *
 * This is the primary integration point. Call this once during engine
 * initialization. The returned subsystems are fully wired:
 * - Memory events → EventBus
 * - Semaphore callbacks → EventBus
 * - Pipeline → EventBus (via constructor)
 * - ConfigManager holds the validated config
 *
 * @param config - The full ForgeConfig (validated)
 * @returns All subsystems, ready for use
 *
 * @example
 * ```ts
 * const config = configManager.get();
 * const subsystems = createForgeSubsystems(config);
 *
 * // Use in engine:
 * await subsystems.semaphore.withLock(() => runTask());
 * await subsystems.pipeline.execute(ctx);
 * await subsystems.memory.injectToPrompt();
 *
 * // Cleanup:
 * await destroyForgeSubsystems(subsystems);
 * ```
 */
export function createForgeSubsystems(
  config: ForgeConfig,
  options?: { projectId?: string; title?: string },
): ForgeSubsystems {
  // 1. EventBus — created first, other subsystems depend on it
  const eventBusConfig = extractEventBusConfig(config);
  const eventBus = ForgeEventBus.create(eventBusConfig);

  // 2. Memory — wired to EventBus via bridge
  const memoryConfig = extractMemoryConfig(config);
  const memory = new ForgeMemory(memoryConfig);
  bridgeMemoryToEventBus(memory, eventBus);

  // 3. ConfigManager — initialized with the provided config
  const configManager = new ForgeConfigManager(config);

  // 4. Pipeline — receives EventBus wrapped as MiddlewareEventEmitter
  const pipelineConfig = extractPipelineConfig(config);
  const pipelineEmitter = createPipelineEventEmitter(eventBus);
  const pipeline = new MiddlewarePipeline(pipelineConfig, pipelineEmitter);

  // 5. Semaphore — callbacks emit events to EventBus
  const semaphoreCallbacks = createSemaphoreCallbacks(eventBus);
  const semaphore = new AsyncSemaphore(
    config.concurrency.maxWorkers,
    semaphoreCallbacks,
  );

  // 6. Dashboard — subscribes to EventBus for aggregated state tracking
  const dashboard = new ForgeDashboard(
    options?.projectId ?? 'deepforge',
    options?.title ?? 'DeepForge Session',
  );
  dashboard.subscribeToEventBus(eventBus);

  return { eventBus, memory, configManager, pipeline, semaphore, dashboard };
}

// ─── Teardown ────────────────────────────────────────────────────────────────

/**
 * Gracefully destroy all engine subsystems.
 *
 * Calls dispose/cleanup methods on each subsystem in reverse creation order:
 * 1. Semaphore — reject queued waiters
 * 2. Pipeline — clear all middleware and hooks
 * 3. ConfigManager — stop file watching, clear listeners
 * 4. Dashboard — unsubscribe from EventBus, reset state
 * 5. Memory — flush pending saves, clear timers
 * 6. EventBus — remove all listeners
 *
 * Safe to call multiple times (idempotent for most subsystems).
 */
export async function destroyForgeSubsystems(subsystems: ForgeSubsystems): Promise<void> {
  const { semaphore, configManager, memory, eventBus, dashboard } = subsystems;

  // 1. Semaphore: reject all queued waiters
  semaphore.dispose();

  // 2. Pipeline: clear all middleware and hooks
  subsystems.pipeline.clear();

  // 3. ConfigManager: stop watching, clear listeners/validators
  configManager.dispose();

  // 4. Dashboard: dispose (unsubscribe from EventBus + reset state)
  dashboard.dispose();

  // 5. Memory: flush pending debounced saves, clear timers
  await memory.dispose();

  // 6. EventBus: remove all listeners (history is kept for post-mortem)
  eventBus.removeAllListeners();
}
