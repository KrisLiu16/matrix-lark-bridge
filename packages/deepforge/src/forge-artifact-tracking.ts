/**
 * DeepForge 2.0 — ArtifactTrackingMiddleware
 *
 * Middleware that tracks artifacts produced during forge execution:
 * - Scans iteration output for file paths, code blocks, and document references
 * - Maintains an ArtifactRegistry with deduplication (DeerFlow merge_artifacts pattern)
 * - Emits artifact lifecycle events via a pluggable event emitter
 * - Implements standard Middleware interface: name + execute(ctx, next)
 *
 * Improvements over v1:
 * - Implements class-based Middleware interface from types/middleware.ts
 * - DeerFlow-style merge dedup: same-path artifacts merge rather than duplicate
 * - Event emission for artifact:added / artifact:modified / artifact:removed
 * - Proper state namespacing ('artifact-tracking:*')
 * - No inline type redefinitions — imports from types/middleware
 *
 * Zero external dependencies beyond Node.js fs/path.
 *
 * @module forge-artifact-tracking
 */

import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, relative, extname } from 'node:path';

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  MiddlewareMessage,
} from './types/middleware';

// ============ Artifact Types ============

/** Artifact classification categories */
export type ArtifactCategory =
  | 'code'
  | 'document'
  | 'data'
  | 'config'
  | 'test'
  | 'analysis'
  | 'design'
  | 'report';

/** A single tracked artifact in the registry */
export interface ArtifactRecord {
  /** Unique artifact ID (deterministic: hash of normalized path) */
  id: string;
  /** Artifact classification */
  type: ArtifactCategory;
  /** Relative path from project root */
  path: string;
  /** Role or agent that created/last modified this artifact */
  creator: string;
  /** ISO-8601 first-seen timestamp */
  createdAt: string;
  /** ISO-8601 last-modified timestamp */
  updatedAt: string;
  /** File size in bytes (0 if not on disk) */
  sizeBytes: number;
  /** Version counter — incremented on each merge/update */
  version: number;
  /** Task ID that produced this artifact (if known) */
  taskId?: string;
  /** Short description (inferred or explicit) */
  description?: string;
}

/** The artifact registry — keyed by normalized path for O(1) dedup */
export interface ArtifactRegistry {
  /** All tracked artifacts keyed by normalized relative path */
  entries: Map<string, ArtifactRecord>;
  /** ISO-8601 timestamp of last scan */
  lastScanAt: string;
}

/** Summary of changes after a tracking scan */
export interface ArtifactTrackingSummary {
  totalArtifacts: number;
  added: string[];
  modified: string[];
  removed: string[];
}

/** Filesystem snapshot entry */
interface FsEntry {
  mtimeMs: number;
  sizeBytes: number;
}

/** Configuration for ArtifactTrackingMiddleware */
export interface ArtifactTrackingConfig {
  /** Root directory of the project */
  projectRoot: string;
  /** Subdirectory to scan for artifacts (relative to projectRoot) */
  artifactsDir: string;
  /** Directories to skip during scan */
  ignoreDirs: string[];
  /** Default role name when not available from context */
  defaultRole: string;
}

/** Minimal event emitter interface (decoupled from ForgeEventBus) */
export interface ArtifactEventEmitter {
  emit(event: {
    type: string;
    timestamp: string;
    message: string;
    source: string;
    [key: string]: unknown;
  }): void | Promise<void>;
}

// ============ Constants ============

const STATE_KEY_SUMMARY = 'artifact-tracking:summary';
const STATE_KEY_REGISTRY = 'artifact-tracking:registry';
const DEFAULT_IGNORE_DIRS = ['node_modules', '.git', '__pycache__', '.artifact-index'];

// ============ Extension → Category Mapping ============

const EXT_CATEGORY: Record<string, ArtifactCategory> = {
  '.ts': 'code',
  '.js': 'code',
  '.tsx': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.c': 'code',
  '.h': 'code',
  '.sh': 'code',
  '.md': 'document',
  '.txt': 'document',
  '.json': 'data',
  '.csv': 'data',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
};

const DIR_CATEGORY: Record<string, ArtifactCategory> = {
  research: 'analysis',
  analysis: 'analysis',
  design: 'design',
  reports: 'report',
  test: 'test',
  tests: 'test',
  config: 'config',
  data: 'data',
};

// ============ Helpers ============

/** Generate a deterministic ID from a path */
function pathToId(path: string): string {
  // Simple hash: djb2
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) & 0x7fffffff;
  }
  return `art-${hash.toString(36)}`;
}

/** Classify an artifact by its path */
function classifyArtifact(relativePath: string): ArtifactCategory {
  // Directory-based classification takes priority
  const parts = relativePath.split('/');
  for (const part of parts) {
    if (DIR_CATEGORY[part]) return DIR_CATEGORY[part];
  }

  // Check for test file patterns
  if (relativePath.includes('.test.') || relativePath.includes('.spec.')) {
    return 'test';
  }

  // Fall back to extension
  const ext = extname(relativePath);
  return EXT_CATEGORY[ext] ?? 'data';
}

/** Recursively walk a directory, returning relative paths */
function walkDir(dir: string, baseDir: string, ignoreDirs: string[]): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (ignoreDirs.includes(entry.name)) continue;
      results.push(...walkDir(fullPath, baseDir, ignoreDirs));
    } else if (entry.isFile()) {
      results.push(relative(baseDir, fullPath));
    }
  }
  return results;
}

/** Take a filesystem snapshot */
function takeSnapshot(
  projectRoot: string,
  artifactsDir: string,
  ignoreDirs: string[],
): Map<string, FsEntry> {
  const fullDir = join(projectRoot, artifactsDir);
  const files = walkDir(fullDir, projectRoot, ignoreDirs);
  const snapshot = new Map<string, FsEntry>();

  for (const relPath of files) {
    try {
      const stat = statSync(join(projectRoot, relPath));
      snapshot.set(relPath, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // File may vanish between readdir and stat — skip silently
    }
  }
  return snapshot;
}

/**
 * Extract artifact references from messages.
 * Scans assistant messages for file paths and code block filenames.
 */
function extractArtifactRefs(messages: MiddlewareMessage[]): string[] {
  const refs: string[] = [];
  const pathPattern = /(?:artifacts\/[\w./-]+\.\w+)/g;
  const codeBlockPattern = /```\w*\s+\/\/(.*?\.\w+)/g;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // Match file paths like artifacts/src/foo.ts
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(msg.content)) !== null) {
      refs.push(match[0]);
    }

    // Match code block file references
    while ((match = codeBlockPattern.exec(msg.content)) !== null) {
      refs.push(match[1].trim());
    }
  }

  // DeerFlow merge_artifacts pattern: deduplicate while preserving order
  return mergeArtifacts(refs);
}

/**
 * DeerFlow-style merge: deduplicate artifact paths while preserving order.
 * Equivalent to Python's `list(dict.fromkeys(existing + new))`.
 */
function mergeArtifacts(existing: string[], incoming?: string[]): string[] {
  const combined = incoming ? [...existing, ...incoming] : existing;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of combined) {
    const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

// ============ ArtifactTrackingMiddleware ============

/**
 * Middleware that tracks artifacts produced during forge execution.
 *
 * Lifecycle:
 * 1. Before next(): takes a filesystem snapshot
 * 2. Calls next() — downstream middleware and LLM execution happen
 * 3. After next(): takes another snapshot, diffs, and updates the registry
 * 4. Also scans output messages for artifact references
 * 5. Emits events for added/modified/removed artifacts
 * 6. Attaches summary to ctx.state for downstream consumers
 *
 * @example
 * ```ts
 * const tracker = new ArtifactTrackingMiddleware({
 *   projectRoot: '/path/to/project',
 * });
 * pipeline.use(tracker.execute.bind(tracker), {
 *   name: tracker.name,
 *   priority: tracker.priority,
 * });
 * ```
 */
export class ArtifactTrackingMiddleware implements Middleware {
  readonly name = 'artifact-tracking';
  readonly priority = 65; // after task-tracking (60), before memory (80)
  readonly enabled = true;
  readonly timeout = 10_000;
  readonly continueOnError = true; // tracking failure should not abort the pipeline

  private readonly config: ArtifactTrackingConfig;
  private readonly registry: ArtifactRegistry;
  private readonly eventEmitter: ArtifactEventEmitter | null;

  constructor(
    config: Partial<ArtifactTrackingConfig> & { projectRoot: string },
    eventEmitter?: ArtifactEventEmitter,
  ) {
    this.config = {
      artifactsDir: config.artifactsDir ?? 'artifacts',
      ignoreDirs: config.ignoreDirs ?? DEFAULT_IGNORE_DIRS,
      defaultRole: config.defaultRole ?? 'unknown',
      projectRoot: config.projectRoot,
    };
    this.registry = {
      entries: new Map(),
      lastScanAt: new Date().toISOString(),
    };
    this.eventEmitter = eventEmitter ?? null;
  }

  /** Optional: check that artifacts dir exists */
  shouldRun(ctx: MiddlewareContext): boolean {
    const dir = join(this.config.projectRoot, this.config.artifactsDir);
    return existsSync(dir);
  }

  /**
   * Standard Middleware.execute — onion-model handler.
   *
   * Takes a snapshot before next(), diffs after next(), updates
   * the registry with merge-dedup, and emits events.
   */
  async execute(ctx: MiddlewareContext, next: MiddlewareNext): Promise<MiddlewareContext> {
    // 1. Capture pre-execution snapshot
    const snapshotBefore = takeSnapshot(
      this.config.projectRoot,
      this.config.artifactsDir,
      this.config.ignoreDirs,
    );

    // 2. Execute downstream
    const result = await next();

    // 3. Capture post-execution snapshot
    const snapshotAfter = takeSnapshot(
      this.config.projectRoot,
      this.config.artifactsDir,
      this.config.ignoreDirs,
    );

    // 4. Diff snapshots
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    for (const [path, entry] of snapshotAfter) {
      const before = snapshotBefore.get(path);
      if (!before) {
        added.push(path);
      } else if (before.mtimeMs !== entry.mtimeMs || before.sizeBytes !== entry.sizeBytes) {
        modified.push(path);
      }
    }

    for (const path of snapshotBefore.keys()) {
      if (!snapshotAfter.has(path)) {
        removed.push(path);
      }
    }

    // 5. Extract references from output messages
    const messageRefs = extractArtifactRefs(result.messages);

    // 6. Merge all discovered paths (dedup)
    const allDiscovered = mergeArtifacts([...added, ...modified], messageRefs);

    // 7. Determine creator from context
    const creator =
      (result.state['currentRole'] as string) ??
      (result.state['role'] as string) ??
      this.config.defaultRole;
    const taskId = result.state['currentTaskId'] as string | undefined;
    const now = new Date().toISOString();

    // 8. Update registry — merge pattern (same path → update, not duplicate)
    for (const path of added) {
      const fsEntry = snapshotAfter.get(path)!;
      this.mergeIntoRegistry(path, {
        sizeBytes: fsEntry.sizeBytes,
        creator,
        taskId,
        now,
        isNew: true,
      });
    }

    for (const path of modified) {
      const fsEntry = snapshotAfter.get(path)!;
      this.mergeIntoRegistry(path, {
        sizeBytes: fsEntry.sizeBytes,
        creator,
        taskId,
        now,
        isNew: false,
      });
    }

    for (const path of removed) {
      this.registry.entries.delete(path);
      this.emitArtifactEvent('artifact:removed', path, creator);
    }

    // Register message-referenced artifacts that aren't on disk yet
    for (const ref of messageRefs) {
      if (!this.registry.entries.has(ref) && !added.includes(ref) && !modified.includes(ref)) {
        this.mergeIntoRegistry(ref, {
          sizeBytes: 0,
          creator,
          taskId,
          now,
          isNew: true,
        });
      }
    }

    this.registry.lastScanAt = now;

    // 9. Build summary and attach to context state
    const summary: ArtifactTrackingSummary = {
      totalArtifacts: this.registry.entries.size,
      added,
      modified,
      removed,
    };

    result.state[STATE_KEY_SUMMARY] = summary;
    result.state[STATE_KEY_REGISTRY] = this.getRegistrySnapshot();

    return result;
  }

  // ── Registry Operations ──

  /**
   * Merge an artifact into the registry.
   * If the path already exists, updates metadata and bumps version (DeerFlow merge pattern).
   * If new, creates a fresh record.
   */
  private mergeIntoRegistry(
    path: string,
    opts: {
      sizeBytes: number;
      creator: string;
      taskId?: string;
      now: string;
      isNew: boolean;
    },
  ): void {
    const existing = this.registry.entries.get(path);

    if (existing) {
      // Merge: update mutable fields, bump version
      existing.updatedAt = opts.now;
      existing.creator = opts.creator;
      existing.sizeBytes = opts.sizeBytes;
      existing.version += 1;
      if (opts.taskId) existing.taskId = opts.taskId;
      this.emitArtifactEvent('artifact:modified', path, opts.creator);
    } else {
      // New entry
      const record: ArtifactRecord = {
        id: pathToId(path),
        type: classifyArtifact(path),
        path,
        creator: opts.creator,
        createdAt: opts.now,
        updatedAt: opts.now,
        sizeBytes: opts.sizeBytes,
        version: 1,
        taskId: opts.taskId,
      };
      this.registry.entries.set(path, record);
      this.emitArtifactEvent('artifact:added', path, opts.creator);
    }
  }

  /**
   * Manually register an artifact from outside the middleware pipeline.
   * Uses merge semantics — safe to call multiple times for the same path.
   */
  registerArtifact(
    path: string,
    opts?: { description?: string; creator?: string; taskId?: string; category?: ArtifactCategory },
  ): ArtifactRecord {
    const fullPath = join(this.config.projectRoot, path);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      // File may not exist yet
    }

    const now = new Date().toISOString();
    const creator = opts?.creator ?? this.config.defaultRole;

    this.mergeIntoRegistry(path, {
      sizeBytes,
      creator,
      taskId: opts?.taskId,
      now,
      isNew: !this.registry.entries.has(path),
    });

    const record = this.registry.entries.get(path)!;
    if (opts?.description) record.description = opts.description;
    if (opts?.category) record.type = opts.category;

    return record;
  }

  // ── Query API ──

  /** Get all tracked artifacts as an array */
  getEntries(): ArtifactRecord[] {
    return Array.from(this.registry.entries.values());
  }

  /** Get artifacts by category */
  getByCategory(category: ArtifactCategory): ArtifactRecord[] {
    return this.getEntries().filter(e => e.type === category);
  }

  /** Get artifacts by creator/role */
  getByCreator(creator: string): ArtifactRecord[] {
    return this.getEntries().filter(e => e.creator === creator);
  }

  /** Get a single artifact by path */
  getByPath(path: string): ArtifactRecord | undefined {
    return this.registry.entries.get(path);
  }

  /** Get total artifact count */
  get totalCount(): number {
    return this.registry.entries.size;
  }

  /** Get a plain-object snapshot of the registry (for serialization) */
  getRegistrySnapshot(): Record<string, ArtifactRecord> {
    const snapshot: Record<string, ArtifactRecord> = {};
    for (const [key, value] of this.registry.entries) {
      snapshot[key] = { ...value };
    }
    return snapshot;
  }

  // ── Event Emission ──

  private emitArtifactEvent(
    eventType: 'artifact:added' | 'artifact:modified' | 'artifact:removed',
    path: string,
    creator: string,
  ): void {
    if (!this.eventEmitter) return;
    try {
      void this.eventEmitter.emit({
        type: eventType,
        timestamp: new Date().toISOString(),
        message: `${eventType}: ${path} by ${creator}`,
        source: 'artifact-tracking',
        path,
        creator,
      });
    } catch {
      // Event emission must never break the middleware
    }
  }
}

// ============ Factory ============

/**
 * Create an ArtifactTrackingMiddleware with default configuration.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param eventEmitter - Optional event emitter for artifact lifecycle events
 */
export function createArtifactTracker(
  projectRoot: string,
  eventEmitter?: ArtifactEventEmitter,
): ArtifactTrackingMiddleware {
  return new ArtifactTrackingMiddleware({ projectRoot }, eventEmitter);
}
