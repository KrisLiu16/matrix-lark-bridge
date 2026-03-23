/**
 * DeepForge 2.0 — Forge Memory System
 *
 * Cross-project persistent memory with:
 * - In-memory cache + JSON file persistence (atomic writes)
 * - Full CRUD on MemoryEntry with deduplication
 * - Structured querying with filters, sorting, pagination
 * - Relevance scoring combining confidence, recency, and access frequency
 * - Cross-project memory sharing via shared directory
 * - Debounced batch writes for I/O efficiency
 * - TTL-free capacity management (prune by confidence + relevance)
 * - extractFromProject(): post-project experience extraction
 * - injectToPrompt(): memory injection into Leader prompt
 * - Event integration via ForgeEventBus (optional)
 *
 * Inspired by DeerFlow's memory system (memory_middleware.py, memory_config.py).
 * @see types/memory.ts for all type definitions
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  MemoryEntry,
  MemorySnapshot,
  MemoryQuery,
  MemoryQueryFilters,
  MemoryStore,
  MemoryStoreConfig,
  UserContext,
  MemoryHistory,
  MemoryExtractionResult,
  CrossProjectMemoryConfig,
  MemoryEventPayload,
  MemorySortField,
  SortDirection,
} from './types/memory';

import {
  MemoryType,
  MemorySource,
  MemoryEventType,
  DEFAULT_MEMORY_STORE_CONFIG,
  DEFAULT_CROSS_PROJECT_CONFIG,
} from './types/memory';

// ============ Legacy Data Structures (v1 migration) ============

/** Shape of a single fact entry in the v1 schema (before rename to MemoryEntry). */
interface LegacyFact {
  id: string;
  content: string;
  category: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  confidence?: number;
  source: string;
}

/** Overlay type for v1 snapshots that had `facts` instead of `entries`. */
interface LegacySnapshotV1 extends Omit<MemorySnapshot, 'entries'> {
  facts?: LegacyFact[];
  entries?: MemoryEntry[];
}

// ============ Content Deduplication ============

/** Similarity threshold for deduplication (0–1). */
const DEDUP_THRESHOLD = 0.85;

/**
 * Normalize content for deduplication: lowercase, collapse whitespace,
 * strip punctuation (preserving CJK characters).
 */
function normalizeContent(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[^\w\s\u4e00-\u9fff]/g, '');
}

/**
 * Jaccard similarity on word sets. Returns 1.0 for exact normalized match.
 * Lightweight alternative to embedding-based similarity.
 */
function contentSimilarity(a: string, b: string): number {
  const na = normalizeContent(a);
  const nb = normalizeContent(b);
  if (na === nb) return 1.0;

  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1.0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============ Deep Equality ============

/**
 * Recursive deep equality check. Handles objects, arrays, and primitives.
 * Unlike JSON.stringify comparison, this is order-independent for object keys.
 *
 * Fixes v1 P2-11: JSON.stringify-based deep comparison is unreliable because
 * object property order is not guaranteed.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}

// ============ Atomic File I/O ============

/**
 * Write JSON atomically: write to temp file, then rename.
 * Prevents corruption on crash/power loss.
 */
function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read and parse JSON from file. Returns null if file missing or invalid.
 */
function readJSON<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ============ Relevance Scoring ============

/**
 * Compute a relevance score for a memory entry.
 *
 * Formula: 0.5 * confidence + 0.3 * recencyFactor + 0.2 * accessFactor
 *
 * - recencyFactor decays exponentially: e^(-daysSinceUpdate / 90)
 * - accessFactor: min(1, accessCount / 10) — saturates at 10 accesses
 *
 * All factors are clamped to [0, 1].
 */
function computeRelevance(entry: MemoryEntry, now: number): number {
  const daysSinceUpdate =
    (now - new Date(entry.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.exp(-daysSinceUpdate / 90);
  const accessFactor = Math.min(1, entry.accessCount / 10);

  return Math.max(
    0,
    Math.min(1, 0.5 * entry.confidence + 0.3 * recencyFactor + 0.2 * accessFactor),
  );
}

// ============ Snapshot Helpers ============

function createEmptySnapshot(projectId: string): MemorySnapshot {
  return {
    version: 2,
    userContext: {
      workContext: '',
      personalContext: '',
      topOfMind: '',
      preferences: '',
    },
    history: {
      recentSessions: '',
      earlierContext: '',
      longTermBackground: '',
    },
    entries: [],
    updatedAt: new Date().toISOString(),
    projectId,
  };
}

// ============ ForgeMemory ============

/**
 * Event emitter callback for memory events.
 * If ForgeEventBus is wired up, this forwards events to it.
 */
export type MemoryEventEmitter = (payload: MemoryEventPayload) => void;

/**
 * ForgeMemory — implements MemoryStore with in-memory cache, file persistence,
 * structured querying, cross-project sharing, and prompt injection.
 */
export class ForgeMemory implements MemoryStore {
  private config: MemoryStoreConfig;
  private crossProjectConfig: CrossProjectMemoryConfig;
  private snapshot: MemorySnapshot;
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fileMtime: number | null = null;
  private eventEmitter: MemoryEventEmitter | null = null;

  constructor(
    config?: Partial<MemoryStoreConfig>,
    crossProjectConfig?: Partial<CrossProjectMemoryConfig>,
  ) {
    this.config = { ...DEFAULT_MEMORY_STORE_CONFIG, ...config };
    this.crossProjectConfig = { ...DEFAULT_CROSS_PROJECT_CONFIG, ...crossProjectConfig };
    this.snapshot = createEmptySnapshot('');
  }

  /** Wire up an event emitter for memory lifecycle events. */
  setEventEmitter(emitter: MemoryEventEmitter): void {
    this.eventEmitter = emitter;
  }

  // ---- Lifecycle ----

  async load(): Promise<MemorySnapshot> {
    if (!this.config.enabled) return this.snapshot;

    const loaded = readJSON<MemorySnapshot>(this.config.storagePath);
    if (loaded && loaded.version) {
      this.snapshot = this.migrate(loaded);
      try {
        this.fileMtime = statSync(this.config.storagePath).mtimeMs;
      } catch {
        this.fileMtime = null;
      }
    } else {
      this.snapshot = createEmptySnapshot(this.snapshot.projectId);
    }
    this.dirty = false;
    this.emit({ eventType: MemoryEventType.Loaded, entryCount: this.snapshot.entries.length });
    return this.snapshot;
  }

  /** Force-reload from disk if file mtime has changed. */
  async reloadIfChanged(): Promise<boolean> {
    try {
      const stat = statSync(this.config.storagePath);
      if (this.fileMtime !== null && stat.mtimeMs === this.fileMtime) return false;
    } catch {
      return false;
    }
    await this.load();
    return true;
  }

  async save(snapshot?: MemorySnapshot): Promise<void> {
    if (!this.config.enabled) return;
    const snap = snapshot ?? this.snapshot;
    snap.updatedAt = new Date().toISOString();
    atomicWriteJSON(this.config.storagePath, snap);
    try {
      this.fileMtime = statSync(this.config.storagePath).mtimeMs;
    } catch {
      // ignore
    }
    this.dirty = false;
    this.emit({ eventType: MemoryEventType.Saved, entryCount: snap.entries.length });
  }

  /** Schedule a debounced save. Resets timer on each call. */
  private scheduleSave(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (this.dirty) {
        this.save().catch((err) => {
          // Log error but don't crash — debounce callbacks can't propagate rejections
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ForgeMemory] debounced save failed: ${msg}`);
        });
      }
      this.debounceTimer = null;
    }, this.config.debounceMs);
  }

  /** Flush any pending debounced save immediately. Returns the save promise. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.dirty) await this.save();
  }

  /** Destroy timers. Call on shutdown. */
  async dispose(): Promise<void> {
    await this.flush();
  }

  // ---- CRUD: Entries ----

  async addEntry(
    input: Omit<MemoryEntry, 'id' | 'timestamp' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>,
  ): Promise<MemoryEntry> {
    // Deduplication check
    const duplicate = this.snapshot.entries.find(
      (existing) => contentSimilarity(existing.content, input.content) >= DEDUP_THRESHOLD,
    );
    if (duplicate) {
      // Merge: bump confidence and update timestamp
      duplicate.confidence = Math.min(1, Math.max(duplicate.confidence, input.confidence));
      duplicate.updatedAt = new Date().toISOString();
      duplicate.relevanceScore = computeRelevance(duplicate, Date.now());
      this.markDirty();
      this.emit({
        eventType: MemoryEventType.EntryUpdated,
        entryIds: [duplicate.id],
        entryCount: 1,
      });
      return duplicate;
    }

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      timestamp: now,
      updatedAt: now,
      accessCount: 0,
      ...input,
    };
    entry.relevanceScore = computeRelevance(entry, Date.now());

    this.snapshot.entries.push(entry);
    this.enforceCapacity();
    this.markDirty();
    this.emit({
      eventType: MemoryEventType.EntryAdded,
      entryIds: [entry.id],
      entryCount: 1,
    });
    return entry;
  }

  async updateEntry(
    id: string,
    patch: Partial<Pick<MemoryEntry, 'content' | 'type' | 'confidence' | 'tags' | 'relevanceScore'>>,
  ): Promise<MemoryEntry | null> {
    const entry = this.snapshot.entries.find((e) => e.id === id);
    if (!entry) return null;

    if (patch.content !== undefined) entry.content = patch.content;
    if (patch.type !== undefined) entry.type = patch.type;
    if (patch.confidence !== undefined) entry.confidence = patch.confidence;
    if (patch.tags !== undefined) entry.tags = patch.tags;
    if (patch.relevanceScore !== undefined) entry.relevanceScore = patch.relevanceScore;
    entry.updatedAt = new Date().toISOString();
    entry.relevanceScore = computeRelevance(entry, Date.now());

    this.markDirty();
    this.emit({
      eventType: MemoryEventType.EntryUpdated,
      entryIds: [id],
      entryCount: 1,
    });
    return entry;
  }

  async removeEntry(id: string): Promise<boolean> {
    const idx = this.snapshot.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.snapshot.entries.splice(idx, 1);
    this.markDirty();
    this.emit({
      eventType: MemoryEventType.EntryRemoved,
      entryIds: [id],
      entryCount: 1,
    });
    return true;
  }

  /** Get a single entry by id, incrementing its access count. */
  getEntry(id: string): MemoryEntry | null {
    const entry = this.snapshot.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.accessCount++;
    entry.lastAccessedAt = new Date().toISOString();
    entry.relevanceScore = computeRelevance(entry, Date.now());
    this.markDirty();
    return entry;
  }

  // ---- Query ----

  async query(queryOpts: Partial<MemoryQuery>): Promise<MemoryEntry[]> {
    const filters = queryOpts.filters ?? {};
    const limit = queryOpts.limit ?? 20;
    const offset = queryOpts.offset ?? 0;
    const sortBy: MemorySortField = queryOpts.sortBy ?? 'relevanceScore';
    const sortDir: SortDirection = queryOpts.sortDirection ?? 'desc';

    let results = this.applyFilters(this.snapshot.entries, filters);

    // Refresh relevance scores before sorting
    const now = Date.now();
    for (const entry of results) {
      entry.relevanceScore = computeRelevance(entry, now);
    }

    // Sort
    results = [...results].sort((a, b) => {
      const aVal = this.getSortValue(a, sortBy);
      const bVal = this.getSortValue(b, sortBy);
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    // Pagination
    return results.slice(offset, offset + limit);
  }

  async getTopEntries(n?: number): Promise<MemoryEntry[]> {
    const count = n ?? this.config.injectionCount;
    const now = Date.now();

    // Refresh scores
    for (const entry of this.snapshot.entries) {
      entry.relevanceScore = computeRelevance(entry, now);
    }

    return [...this.snapshot.entries]
      .filter((e) => e.confidence >= this.config.pruneConfidenceThreshold)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, count);
  }

  // ---- User Context & History ----

  async updateUserContext(patch: Partial<UserContext>): Promise<UserContext> {
    Object.assign(this.snapshot.userContext, patch);
    this.markDirty();
    this.emit({ eventType: MemoryEventType.ContextUpdated });
    return { ...this.snapshot.userContext };
  }

  async updateHistory(patch: Partial<MemoryHistory>): Promise<MemoryHistory> {
    Object.assign(this.snapshot.history, patch);
    this.markDirty();
    return { ...this.snapshot.history };
  }

  // ---- extractFromProject ----

  /**
   * Extract reusable experience from a completed project.
   *
   * Analyzes feedback strings and role performance data to generate
   * memory entries. In a production setup, this would call an LLM
   * to extract structured facts; here we do deterministic extraction
   * from the provided inputs.
   *
   * @param projectSummary - High-level summary of the completed project
   * @param feedback - Critic/user feedback strings collected during the project
   * @param rolePerformance - Map of role name → performance notes
   * @returns ExtractionResult with newly created entries
   */
  async extractFromProject(
    projectSummary: string,
    feedback: string[],
    rolePerformance: Record<string, string>,
  ): Promise<MemoryExtractionResult> {
    const result: MemoryExtractionResult = {
      entries: [],
    };

    // Extract facts from feedback
    for (const fb of feedback) {
      const trimmed = fb.trim();
      if (!trimmed) continue;

      const entry = await this.addEntry({
        content: trimmed,
        type: MemoryType.Insight,
        confidence: 0.8,
        source: MemorySource.Inferred,
        tags: ['auto-extracted', 'feedback'],
        relevanceScore: 0,
        projectId: this.snapshot.projectId || undefined,
      });
      result.entries.push(entry);
    }

    // Extract role insights
    for (const [role, perf] of Object.entries(rolePerformance)) {
      if (!perf.trim()) continue;

      const entry = await this.addEntry({
        content: `[${role}] ${perf.trim()}`,
        type: MemoryType.Insight,
        confidence: 0.7,
        source: MemorySource.Inferred,
        tags: ['auto-extracted', 'role-insight', `role:${role}`],
        relevanceScore: 0,
        projectId: this.snapshot.projectId || undefined,
      });
      result.entries.push(entry);
    }

    // Extract project-level fact from summary
    if (projectSummary.trim()) {
      const entry = await this.addEntry({
        content: projectSummary.trim(),
        type: MemoryType.Fact,
        confidence: 0.6,
        source: MemorySource.Inferred,
        tags: ['auto-extracted', 'project-summary'],
        relevanceScore: 0,
        projectId: this.snapshot.projectId || undefined,
      });
      result.entries.push(entry);
    }

    // Run maintenance after extraction
    this.pruneEntries();

    this.emit({
      eventType: MemoryEventType.Extracted,
      entryCount: result.entries.length,
    });

    return result;
  }

  // ---- injectToPrompt ----

  /**
   * Build a `<memory>` XML block for injection into the Leader's system prompt.
   *
   * Includes: user context, top-ranked entries, and relevant history.
   * Respects maxInjectionTokens as a rough character limit (×4 heuristic).
   *
   * @param maxEntries - Override for number of entries to include
   * @returns Formatted string, or empty string if nothing to inject
   */
  async injectToPrompt(maxEntries?: number): Promise<string> {
    if (!this.config.enabled || !this.config.injectionEnabled) return '';

    const topEntries = await this.getTopEntries(maxEntries);
    const ctx = this.snapshot.userContext;
    const hist = this.snapshot.history;

    const hasContext = ctx.workContext || ctx.personalContext || ctx.topOfMind || ctx.preferences;
    const hasHistory = hist.recentSessions || hist.earlierContext || hist.longTermBackground;

    if (topEntries.length === 0 && !hasContext && !hasHistory) return '';

    const sections: string[] = ['<memory>'];
    const maxChars = this.config.maxInjectionTokens * 4; // rough token→char
    let charCount = 0;

    // User context section
    if (hasContext) {
      sections.push('<user_context>');
      if (ctx.workContext) sections.push(`  work: ${ctx.workContext}`);
      if (ctx.personalContext) sections.push(`  personal: ${ctx.personalContext}`);
      if (ctx.topOfMind) sections.push(`  focus: ${ctx.topOfMind}`);
      if (ctx.preferences) sections.push(`  preferences: ${ctx.preferences}`);
      sections.push('</user_context>');
      charCount += sections.join('\n').length;
    }

    // Entries section
    if (topEntries.length > 0) {
      sections.push('<entries>');
      for (const e of topEntries) {
        const line = `  - [${e.type} | conf:${e.confidence.toFixed(2)} | rel:${e.relevanceScore.toFixed(2)}] ${e.content}`;
        if (charCount + line.length > maxChars) break;
        sections.push(line);
        charCount += line.length;
      }
      sections.push('</entries>');
    }

    // History section (condensed)
    if (hasHistory && charCount < maxChars) {
      sections.push('<history>');
      if (hist.recentSessions) {
        const truncated = hist.recentSessions.slice(0, Math.max(0, maxChars - charCount));
        sections.push(`  recent: ${truncated}`);
        charCount += truncated.length;
      }
      if (hist.longTermBackground && charCount < maxChars) {
        const truncated = hist.longTermBackground.slice(0, Math.max(0, maxChars - charCount));
        sections.push(`  background: ${truncated}`);
      }
      sections.push('</history>');
    }

    sections.push('</memory>');
    return sections.join('\n');
  }

  // ---- Cross-Project Memory Sharing ----

  /**
   * Import qualifying entries from other projects' memory files.
   *
   * Scans sharedMemoryDir for JSON files, reads each as a MemorySnapshot,
   * and imports entries that meet the shareableTypes + confidence criteria.
   * Imported entries get a relevance decay penalty.
   *
   * @returns Number of entries imported
   */
  async importCrossProjectMemories(): Promise<number> {
    if (!this.crossProjectConfig.enabled) return 0;

    const dir = this.crossProjectConfig.sharedMemoryDir;
    if (!existsSync(dir)) return 0;

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const shareableTypes = new Set(this.crossProjectConfig.shareableTypes);
    const excludeSet = new Set(this.crossProjectConfig.excludeProjects);
    const includeSet = new Set(this.crossProjectConfig.includeProjects);
    let totalImported = 0;

    for (const file of files) {
      const projectId = basename(file, '.json');

      // Skip self
      if (projectId === this.snapshot.projectId) continue;

      // Apply include/exclude filters
      if (excludeSet.has(projectId)) continue;
      if (includeSet.size > 0 && !includeSet.has(projectId)) continue;

      const externalSnapshot = readJSON<MemorySnapshot>(join(dir, file));
      if (!externalSnapshot?.entries) continue;

      let importedFromProject = 0;

      for (const ext of externalSnapshot.entries) {
        if (importedFromProject >= this.crossProjectConfig.maxImportPerProject) break;
        if (!shareableTypes.has(ext.type)) continue;
        if (ext.confidence < this.crossProjectConfig.shareConfidenceThreshold) continue;

        // Check dedup against existing entries
        const isDup = this.snapshot.entries.some(
          (e) => contentSimilarity(e.content, ext.content) >= DEDUP_THRESHOLD,
        );
        if (isDup) continue;

        const now = new Date().toISOString();
        const imported: MemoryEntry = {
          ...ext,
          id: randomUUID(),
          source: MemorySource.CrossProject,
          projectId,
          timestamp: now,
          updatedAt: now,
          accessCount: 0,
          lastAccessedAt: undefined,
          relevanceScore: ext.relevanceScore * this.crossProjectConfig.importRelevanceDecay,
        };

        this.snapshot.entries.push(imported);
        importedFromProject++;
        totalImported++;
      }
    }

    if (totalImported > 0) {
      this.enforceCapacity();
      this.markDirty();
      this.emit({
        eventType: MemoryEventType.CrossProjectImported,
        entryCount: totalImported,
      });
    }

    return totalImported;
  }

  /**
   * Export current project's shareable entries to the shared memory directory.
   *
   * Creates a file named `{projectId}.json` in sharedMemoryDir containing
   * only entries that qualify for sharing (type + confidence).
   */
  async exportForSharing(): Promise<number> {
    if (!this.crossProjectConfig.enabled || !this.snapshot.projectId) return 0;

    const shareableTypes = new Set(this.crossProjectConfig.shareableTypes);
    const shareable = this.snapshot.entries.filter(
      (e) =>
        shareableTypes.has(e.type) &&
        e.confidence >= this.crossProjectConfig.shareConfidenceThreshold,
    );

    if (shareable.length === 0) return 0;

    const exportSnapshot: MemorySnapshot = {
      ...this.snapshot,
      entries: shareable,
    };

    const dir = this.crossProjectConfig.sharedMemoryDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const exportPath = join(dir, `${this.snapshot.projectId}.json`);
    atomicWriteJSON(exportPath, exportSnapshot);

    return shareable.length;
  }

  // ---- Capacity Management ----

  /**
   * Prune entries below confidence and relevance thresholds,
   * then enforce the maximum entry count.
   * Returns IDs of removed entries.
   */
  pruneEntries(): string[] {
    const removed: string[] = [];
    const now = Date.now();

    // Phase 1: Remove entries below confidence threshold
    this.snapshot.entries = this.snapshot.entries.filter((e) => {
      if (e.confidence < this.config.pruneConfidenceThreshold) {
        removed.push(e.id);
        return false;
      }
      return true;
    });

    // Phase 2: Remove entries below relevance threshold
    this.snapshot.entries = this.snapshot.entries.filter((e) => {
      e.relevanceScore = computeRelevance(e, now);
      if (e.relevanceScore < this.config.pruneRelevanceThreshold) {
        removed.push(e.id);
        return false;
      }
      return true;
    });

    // Phase 3: Cap enforcement
    this.enforceCapacity();

    if (removed.length > 0) {
      this.markDirty();
      this.emit({
        eventType: MemoryEventType.Pruned,
        entryCount: removed.length,
        entryIds: removed,
        remainingCount: this.snapshot.entries.length,
      });
    }

    return removed;
  }

  // ---- Snapshot Access ----

  /** Get the full current snapshot (read-only copy). */
  getSnapshot(): Readonly<MemorySnapshot> {
    return this.snapshot;
  }

  /** Get current entry count. */
  get entryCount(): number {
    return this.snapshot.entries.length;
  }

  /** Check if there are unsaved changes. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** Set the project ID for this memory instance. */
  setProjectId(projectId: string): void {
    this.snapshot.projectId = projectId;
  }

  // ---- Private Helpers ----

  private markDirty(): void {
    this.dirty = true;
    this.scheduleSave();
  }

  /** Enforce maxEntries cap by dropping lowest-relevance entries. */
  private enforceCapacity(): void {
    if (this.snapshot.entries.length <= this.config.maxEntries) return;
    this.snapshot.entries.sort((a, b) => b.relevanceScore - a.relevanceScore);
    this.snapshot.entries = this.snapshot.entries.slice(0, this.config.maxEntries);
  }

  /** Apply query filters to an entries array. */
  private applyFilters(entries: MemoryEntry[], filters: MemoryQueryFilters): MemoryEntry[] {
    let results = entries;

    if (filters.types?.length) {
      const typeSet = new Set(filters.types);
      results = results.filter((e) => typeSet.has(e.type));
    }

    if (filters.tags?.length) {
      const tagSet = new Set(filters.tags);
      results = results.filter((e) => e.tags.some((t) => tagSet.has(t)));
    }

    if (filters.sources?.length) {
      const sourceSet = new Set(filters.sources);
      results = results.filter((e) => sourceSet.has(e.source));
    }

    if (filters.minConfidence !== undefined) {
      results = results.filter((e) => e.confidence >= filters.minConfidence!);
    }

    if (filters.minRelevance !== undefined) {
      results = results.filter((e) => e.relevanceScore >= filters.minRelevance!);
    }

    if (filters.createdAfter) {
      const afterTs = new Date(filters.createdAfter).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() > afterTs);
    }

    if (filters.updatedAfter) {
      const afterTs = new Date(filters.updatedAfter).getTime();
      results = results.filter((e) => new Date(e.updatedAt).getTime() > afterTs);
    }

    if (filters.contentSearch) {
      const search = filters.contentSearch.toLowerCase();
      results = results.filter((e) => e.content.toLowerCase().includes(search));
    }

    if (filters.projectId) {
      results = results.filter((e) => e.projectId === filters.projectId);
    }

    return results;
  }

  /** Get a sortable value from an entry for a given sort field. */
  private getSortValue(entry: MemoryEntry, field: MemorySortField): number | string {
    switch (field) {
      case 'relevanceScore':
        return entry.relevanceScore;
      case 'confidence':
        return entry.confidence;
      case 'timestamp':
        return entry.timestamp;
      case 'updatedAt':
        return entry.updatedAt;
      case 'accessCount':
        return entry.accessCount;
    }
  }

  /** Migrate snapshot from older versions. */
  private migrate(snapshot: MemorySnapshot): MemorySnapshot {
    if (!snapshot.entries) snapshot.entries = [];
    if (!snapshot.userContext) {
      snapshot.userContext = { workContext: '', personalContext: '', topOfMind: '', preferences: '' };
    }
    if (!snapshot.history) {
      snapshot.history = { recentSessions: '', earlierContext: '', longTermBackground: '' };
    }
    // v1 → v2: rename facts → entries, map MemoryCategory → MemoryType
    const legacy = snapshot as unknown as LegacySnapshotV1;
    if (snapshot.version < 2 && legacy.facts) {
      snapshot.entries = legacy.facts.map((f: LegacyFact) => ({
        id: f.id,
        content: f.content,
        type: mapLegacyCategory(f.category),
        tags: f.tags ?? [],
        timestamp: f.createdAt,
        relevanceScore: f.confidence ?? 0.5,
        confidence: f.confidence ?? 0.5,
        source: mapLegacySource(f.source),
        updatedAt: f.updatedAt ?? f.createdAt,
        accessCount: 0,
        projectId: snapshot.projectId,
      }));
      delete legacy.facts;
    }
    // Ensure preferences field exists in userContext
    if (snapshot.userContext.preferences === undefined) {
      snapshot.userContext.preferences = '';
    }
    snapshot.version = 2;
    return snapshot;
  }

  /** Emit a memory event if an emitter is wired up. */
  private emit(payload: MemoryEventPayload): void {
    if (this.eventEmitter) {
      try {
        this.eventEmitter(payload);
      } catch {
        // never let event emission break memory operations
      }
    }
  }
}

// ============ Legacy Migration Helpers ============

/** Map v1 MemoryCategory strings to v2 MemoryType. */
function mapLegacyCategory(category: string): MemoryType {
  switch (category) {
    case 'preference':
    case 'fact':
    case 'context':
      return MemoryType.Fact;
    case 'skill':
    case 'feedback':
      return MemoryType.Insight;
    default:
      return MemoryType.Fact;
  }
}

/** Map v1 source strings to v2 MemorySource. */
function mapLegacySource(source: string): MemorySource {
  switch (source) {
    case 'explicit':
    case 'conversation':
      return MemorySource.Explicit;
    case 'inferred':
    case 'project_extraction':
      return MemorySource.Inferred;
    default:
      return MemorySource.Programmatic;
  }
}

// ============ Factory ============

/** Create a ForgeMemory instance with optional config overrides. */
export function createForgeMemory(
  config?: Partial<MemoryStoreConfig>,
  crossProjectConfig?: Partial<CrossProjectMemoryConfig>,
): ForgeMemory {
  return new ForgeMemory(config, crossProjectConfig);
}
