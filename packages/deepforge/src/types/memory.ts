/**
 * DeepForge 2.0 — Memory System Types
 *
 * Defines all types for the persistent memory subsystem:
 * - Memory entries with provenance, confidence, and relevance scoring
 * - Tiered history and user context for prompt injection
 * - Query/filter API for structured retrieval
 * - Cross-project memory sharing
 *
 * Improvements over v1:
 * - MemoryType enum replaces MemoryCategory for clearer semantics
 * - MemoryEntry adds relevanceScore for retrieval ranking
 * - MemoryQuery provides structured filter/sort/pagination
 * - CrossProjectMemoryConfig enables knowledge sharing across projects
 * - MemoryStoreConfig consolidates storage backend configuration
 *
 * @see DeerFlow memory_config.py for reference configuration
 * @see DeerFlow memory_middleware.py for extraction pipeline reference
 */

// ============ Memory Type Enum ============

/**
 * Classification of a memory entry.
 * Each type has different retention and relevance decay characteristics.
 */
export enum MemoryType {
  /** Objective facts about the user, project, or environment. Long-lived. */
  Fact = 'fact',
  /** Decisions made during a project — rationale and outcome. Medium-lived. */
  Decision = 'decision',
  /** Derived insights and patterns observed across interactions. Long-lived. */
  Insight = 'insight',
  /** External references: URLs, docs, tools, contacts. Long-lived, low decay. */
  Reference = 'reference',
}

// ============ Memory Source ============

/**
 * How a memory entry was created.
 * Explicit entries (user-stated) receive higher base confidence than inferred ones.
 */
export enum MemorySource {
  /** Directly stated by the user ("I prefer X"). */
  Explicit = 'explicit',
  /** Extracted by LLM from conversation context. */
  Inferred = 'inferred',
  /** Injected programmatically via API. */
  Programmatic = 'programmatic',
  /** Imported from another project's memory store. */
  CrossProject = 'cross_project',
}

// ============ Memory Entry ============

/**
 * A single memory entry with full provenance and scoring metadata.
 *
 * Core fields required by task spec: id, content, type, tags, timestamp, relevanceScore.
 * Extended with confidence, source, and project origin for production use.
 */
export interface MemoryEntry {
  /** Unique identifier (uuid v4). */
  id: string;
  /** Human-readable content of the memory. */
  content: string;
  /** Classification type. */
  type: MemoryType;
  /** Free-form tags for filtering and grouping. */
  tags: string[];
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /**
   * Relevance score for retrieval ranking, 0–1.
   * Combines confidence, recency, and access frequency.
   * Recalculated on each query by the memory store.
   */
  relevanceScore: number;
  /** LLM-assigned confidence in the fact's correctness, 0–1. */
  confidence: number;
  /** How this entry was created. */
  source: MemorySource;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** Project ID that originated this entry (for cross-project tracking). */
  projectId?: string;
  /** Number of times this entry has been retrieved/used. */
  accessCount: number;
  /** ISO-8601 timestamp of last access. */
  lastAccessedAt?: string;
}

// ============ User Context ============

/**
 * Three-axis user context — summarized by LLM from conversation history.
 * Inspired by DeerFlow's userContext structure, with an additional preferences axis.
 */
export interface UserContext {
  /** Current working context (project, task, environment). */
  workContext: string;
  /** Personal context (role, team, domain expertise). */
  personalContext: string;
  /** What the user is currently focused on / recently mentioned. */
  topOfMind: string;
  /** Accumulated preferences and working style. */
  preferences: string;
}

// ============ Memory History ============

/**
 * Tiered conversation history at different granularity levels.
 * Each tier is a prose summary, not raw messages.
 */
export interface MemoryHistory {
  /** Summary of interactions in recent sessions (detailed). */
  recentSessions: string;
  /** Summary of earlier interactions (condensed). */
  earlierContext: string;
  /** Long-term background and accumulated knowledge. */
  longTermBackground: string;
}

// ============ Memory Snapshot ============

/**
 * Complete serialized memory state.
 * Persisted atomically (temp file + rename) for crash safety.
 */
export interface MemorySnapshot {
  /** Schema version for forward-compatible migrations. */
  version: number;
  /** Three-axis user context. */
  userContext: UserContext;
  /** Tiered conversation history. */
  history: MemoryHistory;
  /** All memory entries, ordered by relevanceScore desc. */
  entries: MemoryEntry[];
  /** ISO-8601 timestamp of last snapshot update. */
  updatedAt: string;
  /** Project ID this snapshot belongs to. */
  projectId: string;
}

// ============ Memory Query ============

/** Sort field options for memory queries. */
export type MemorySortField = 'relevanceScore' | 'confidence' | 'timestamp' | 'updatedAt' | 'accessCount';

/** Sort direction. */
export type SortDirection = 'asc' | 'desc';

/**
 * Structured query for memory retrieval with filtering, sorting, and pagination.
 */
export interface MemoryQuery {
  /** Filter criteria — all specified filters are AND-combined. */
  filters: MemoryQueryFilters;
  /** Maximum number of results to return. Default: 20. */
  limit: number;
  /** Sort field. Default: 'relevanceScore'. */
  sortBy: MemorySortField;
  /** Sort direction. Default: 'desc'. */
  sortDirection: SortDirection;
  /** Offset for pagination. Default: 0. */
  offset: number;
}

/**
 * Filter criteria for memory queries.
 * All specified fields are AND-combined; array fields use OR within (any match).
 */
export interface MemoryQueryFilters {
  /** Filter by memory types (any match). */
  types?: MemoryType[];
  /** Filter by tags (any match). */
  tags?: string[];
  /** Filter by sources (any match). */
  sources?: MemorySource[];
  /** Minimum confidence threshold (inclusive). */
  minConfidence?: number;
  /** Minimum relevance score (inclusive). */
  minRelevance?: number;
  /** Only entries created after this ISO-8601 timestamp. */
  createdAfter?: string;
  /** Only entries updated after this ISO-8601 timestamp. */
  updatedAfter?: string;
  /** Full-text search in content (case-insensitive substring match). */
  contentSearch?: string;
  /** Filter by originating project ID. */
  projectId?: string;
}

// ============ Memory Store Interface ============

/**
 * Abstract memory store — supports CRUD, querying, and prompt injection.
 * Implementations may use in-memory cache + file persistence, database, etc.
 */
export interface MemoryStore {
  /** Load snapshot from persistent storage. Creates default if not found. */
  load(): Promise<MemorySnapshot>;

  /** Persist current snapshot atomically. */
  save(snapshot: MemorySnapshot): Promise<void>;

  /** Add a new entry. Returns the created entry with generated id and timestamps. */
  addEntry(entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>): Promise<MemoryEntry>;

  /** Update an existing entry by id. Returns updated entry or null if not found. */
  updateEntry(
    id: string,
    patch: Partial<Pick<MemoryEntry, 'content' | 'type' | 'confidence' | 'tags' | 'relevanceScore'>>,
  ): Promise<MemoryEntry | null>;

  /** Remove an entry by id. Returns true if deleted. */
  removeEntry(id: string): Promise<boolean>;

  /** Query entries with structured filters, sorting, and pagination. */
  query(query: Partial<MemoryQuery>): Promise<MemoryEntry[]>;

  /**
   * Get the top N most relevant entries for prompt injection.
   * Entries are ranked by relevanceScore and filtered by minConfidence.
   */
  getTopEntries(n?: number): Promise<MemoryEntry[]>;

  /** Update user context (partial merge). */
  updateUserContext(patch: Partial<UserContext>): Promise<UserContext>;

  /** Update history (partial merge). */
  updateHistory(patch: Partial<MemoryHistory>): Promise<MemoryHistory>;
}

// ============ Memory Store Config ============

/**
 * Configuration for the memory store backend.
 * Controls storage location, limits, and persistence behavior.
 */
export interface MemoryStoreConfig {
  /** Whether the memory system is enabled. Default: true. */
  enabled: boolean;
  /** Path to the persistent memory file (JSON). Default: '.deepforge/memory.json'. */
  storagePath: string;
  /** Maximum number of entries to retain. Oldest low-relevance entries pruned first. */
  maxEntries: number;
  /**
   * Debounce interval (ms) for batching memory saves.
   * Prevents excessive I/O during rapid updates. DeerFlow default: 30000.
   */
  debounceMs: number;
  /** Minimum confidence to keep an entry during pruning. Default: 0.3. */
  pruneConfidenceThreshold: number;
  /** Minimum relevance to keep an entry during pruning. Default: 0.1. */
  pruneRelevanceThreshold: number;
  /**
   * Whether to automatically extract memories from conversations via LLM.
   * When false, only explicit addEntry calls create entries.
   */
  autoExtract: boolean;
  /** Number of top entries to inject into prompt. Default: 15. */
  injectionCount: number;
  /** Whether to inject memories into prompts. Default: true. */
  injectionEnabled: boolean;
  /** Maximum tokens allowed for memory injection block. Default: 2000. */
  maxInjectionTokens: number;
}

/** Sensible defaults comparable to DeerFlow's production configuration. */
export const DEFAULT_MEMORY_STORE_CONFIG: MemoryStoreConfig = {
  enabled: true,
  storagePath: '.deepforge/memory.json',
  maxEntries: 200,
  debounceMs: 30_000,
  pruneConfidenceThreshold: 0.3,
  pruneRelevanceThreshold: 0.1,
  autoExtract: true,
  injectionCount: 15,
  injectionEnabled: true,
  maxInjectionTokens: 2000,
};

// ============ Cross-Project Memory Config ============

/**
 * Configuration for sharing memory entries across projects.
 * Enables knowledge transfer (e.g., user preferences, learned facts)
 * between related DeepForge projects.
 */
export interface CrossProjectMemoryConfig {
  /** Whether cross-project memory sharing is enabled. Default: false. */
  enabled: boolean;
  /**
   * Directory containing memory files from other projects.
   * Each project's memory is a separate JSON file named by project ID.
   */
  sharedMemoryDir: string;
  /**
   * Which memory types to share across projects.
   * Typically Facts and References are shared; Decisions are project-specific.
   */
  shareableTypes: MemoryType[];
  /** Minimum confidence for an entry to be shared. Default: 0.7. */
  shareConfidenceThreshold: number;
  /** Maximum entries to import from each external project. Default: 50. */
  maxImportPerProject: number;
  /**
   * Relevance decay factor applied to imported entries (0–1).
   * Imported entries start with relevanceScore * decayFactor.
   * Default: 0.8 (20% penalty for cross-project entries).
   */
  importRelevanceDecay: number;
  /**
   * Project IDs to explicitly include. If empty, all discovered projects are considered.
   */
  includeProjects: string[];
  /**
   * Project IDs to explicitly exclude from sharing.
   */
  excludeProjects: string[];
}

/** Sensible defaults for cross-project memory. */
export const DEFAULT_CROSS_PROJECT_CONFIG: CrossProjectMemoryConfig = {
  enabled: false,
  sharedMemoryDir: '.deepforge/shared-memory',
  shareableTypes: [MemoryType.Fact, MemoryType.Reference],
  shareConfidenceThreshold: 0.7,
  maxImportPerProject: 50,
  importRelevanceDecay: 0.8,
  includeProjects: [],
  excludeProjects: [],
};

// ============ Memory Extraction (LLM interface) ============

/** Result of LLM-driven memory extraction from a conversation turn. */
export interface MemoryExtractionResult {
  /** New or updated entries extracted from the conversation. */
  entries: Array<Omit<MemoryEntry, 'id' | 'timestamp' | 'updatedAt' | 'accessCount' | 'lastAccessedAt'>>;
  /** Partial user context updates (if any). */
  userContextUpdate?: Partial<UserContext>;
  /** Partial history updates (if any). */
  historyUpdate?: Partial<MemoryHistory>;
}

/** A queued memory update waiting for debounce flush. */
export interface MemoryUpdateEntry {
  /** The conversation messages to extract from. */
  messages: Array<{ role: string; content: string }>;
  /** ISO-8601 timestamp of when the entry was queued. */
  queuedAt: string;
  /** Project ID for context. */
  projectId: string;
}

// ============ Memory Event Types ============

/**
 * Events emitted by the memory subsystem.
 * These integrate with ForgeEventBus for observability.
 */
export enum MemoryEventType {
  /** Memory system initialized and loaded. */
  Loaded = 'memory:loaded',
  /** New entry added. */
  EntryAdded = 'memory:entry_added',
  /** Existing entry updated. */
  EntryUpdated = 'memory:entry_updated',
  /** Entry removed. */
  EntryRemoved = 'memory:entry_removed',
  /** Entries pruned due to capacity/threshold. */
  Pruned = 'memory:pruned',
  /** Snapshot saved to disk. */
  Saved = 'memory:saved',
  /** LLM extraction completed. */
  Extracted = 'memory:extracted',
  /** Cross-project entries imported. */
  CrossProjectImported = 'memory:cross_project_imported',
  /** User context updated. */
  ContextUpdated = 'memory:context_updated',
}

/** Payload for memory events emitted to ForgeEventBus. */
export interface MemoryEventPayload {
  /** The event type. */
  eventType: MemoryEventType;
  /** Number of entries affected (for batch operations). */
  entryCount?: number;
  /** Entry IDs affected. */
  entryIds?: string[];
  /** Source project ID (for cross-project events). */
  sourceProjectId?: string;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
  /** Number of entries remaining after the operation. */
  remainingCount?: number;
}
