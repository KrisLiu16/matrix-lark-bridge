/**
 * forge-loop-detection.ts — LoopDetectionMiddleware
 *
 * Detects repetitive output patterns using sliding-window hash comparison
 * and Jaccard similarity. When a loop is detected, injects a warning into
 * the conversation and optionally aborts the pipeline.
 *
 * Reference: DeerFlow LoopDetectionMiddleware (sliding window hash, 3-tier escalation)
 */

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  MiddlewareMessage,
} from './types/middleware';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LoopDetectionConfig {
  /** Number of recent iterations to keep in the sliding window (default: 10) */
  windowSize: number;

  /**
   * Jaccard similarity threshold (0–1). Two outputs with similarity above
   * this value are considered "similar enough" to count as a repeat.
   * Default: 0.85
   */
  similarityThreshold: number;

  /**
   * How many consecutive similar outputs trigger a loop verdict.
   * Default: 3
   */
  maxConsecutiveRepeats: number;

  /**
   * When true the middleware will set `ctx.metadata.aborted = true` once
   * a loop is confirmed (after escalation). Default: false
   */
  abortOnLoop: boolean;

  /**
   * Number of consecutive repeats at which to abort (if abortOnLoop is true).
   * Must be >= maxConsecutiveRepeats. Default: 5
   */
  abortThreshold: number;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
  windowSize: 10,
  similarityThreshold: 0.85,
  maxConsecutiveRepeats: 3,
  abortOnLoop: false,
  abortThreshold: 5,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HashEntry {
  /** Simple numeric hash of the output content */
  hash: number;
  /** Set of shingles (for Jaccard comparison) */
  shingles: Set<string>;
  /** ISO timestamp */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Hashing & similarity helpers
// ---------------------------------------------------------------------------

/**
 * djb2 — fast, deterministic 32-bit string hash.
 * Good enough for equality checks; collisions are acceptable because we
 * fall back to Jaccard similarity when hashes differ.
 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * Build a set of character-level n-gram shingles from a string.
 * Shingle size 3 gives a good trade-off between precision and memory.
 */
function buildShingles(text: string, n = 3): Set<string> {
  const shingles = new Set<string>();
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i <= normalized.length - n; i++) {
    shingles.add(normalized.slice(i, i + n));
  }
  return shingles;
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty (no data → no similarity).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  // Iterate over the smaller set for efficiency
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract the "output content" from a middleware context.
 * We concatenate assistant messages since last user message — that's the
 * relevant output for loop detection.
 */
function extractOutputContent(ctx: MiddlewareContext): string {
  const messages = ctx.messages;
  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  // Collect all assistant content after that
  const parts: string[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      parts.push(messages[i].content);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Circular buffer
// ---------------------------------------------------------------------------

class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private _size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  get size(): number {
    return this._size;
  }

  /**
   * Return items from oldest to newest.
   */
  toArray(): T[] {
    const result: T[] = [];
    if (this._size === 0) return result;
    const start =
      this._size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }
    return result;
  }

  /**
   * Return the last `n` items (newest first).
   */
  lastN(n: number): T[] {
    const all = this.toArray();
    return all.slice(-Math.min(n, all.length));
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this._size = 0;
  }
}

// ---------------------------------------------------------------------------
// Loop detection result
// ---------------------------------------------------------------------------

export interface LoopDetectionResult {
  /** Whether a loop was detected */
  loopDetected: boolean;
  /** Number of consecutive similar outputs observed */
  consecutiveRepeats: number;
  /** Similarity score of the most recent pair (0–1) */
  lastSimilarity: number;
  /** Escalation level: 'none' | 'warning' | 'abort' */
  escalation: 'none' | 'warning' | 'abort';
}

// ---------------------------------------------------------------------------
// LoopDetectionMiddleware
// ---------------------------------------------------------------------------

export class LoopDetectionMiddleware implements Middleware {
  readonly name = 'loop-detection';
  readonly priority = 115; // runs after quality-gate (110) in afterIteration
  readonly enabled = true;
  readonly continueOnError = true; // non-fatal — don't break the pipeline

  private config: LoopDetectionConfig;
  private window: CircularBuffer<HashEntry>;

  constructor(config?: Partial<LoopDetectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.abortThreshold < this.config.maxConsecutiveRepeats) {
      this.config.abortThreshold = this.config.maxConsecutiveRepeats;
    }
    this.window = new CircularBuffer<HashEntry>(this.config.windowSize);
  }

  // -----------------------------------------------------------------------
  // Middleware interface
  // -----------------------------------------------------------------------

  shouldRun(ctx: MiddlewareContext): boolean {
    // Only run if we have messages to analyze (skip setup phases)
    return ctx.messages.length > 0 && ctx.iteration !== undefined;
  }

  async execute(
    ctx: MiddlewareContext,
    next: MiddlewareNext,
  ): Promise<MiddlewareContext> {
    // Run downstream first (we analyze output *after* it's produced)
    const result = await next();

    // Perform detection on the result
    const detection = this.detect(result);

    // Store detection state in the context state bag (namespaced)
    result.state['loop-detection:result'] = detection;
    result.state['loop-detection:consecutiveRepeats'] = detection.consecutiveRepeats;

    if (detection.loopDetected) {
      // Set the well-known flag for other middlewares / the engine
      result.state['loop-detection:detected'] = true;

      if (detection.escalation === 'warning') {
        this.injectWarning(result, detection);
      } else if (detection.escalation === 'abort') {
        this.injectAbort(result, detection);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Core detection logic
  // -----------------------------------------------------------------------

  /**
   * Analyze the current output against the sliding window.
   * Returns a structured detection result.
   */
  private detect(ctx: MiddlewareContext): LoopDetectionResult {
    const output = extractOutputContent(ctx);

    // Edge case: empty output
    if (!output.trim()) {
      return {
        loopDetected: false,
        consecutiveRepeats: 0,
        lastSimilarity: 0,
        escalation: 'none',
      };
    }

    const hash = djb2Hash(output);
    const shingles = buildShingles(output);
    const entry: HashEntry = {
      hash,
      shingles,
      timestamp: new Date().toISOString(),
    };

    // Count consecutive similar outputs (walking backwards from latest)
    const recent = this.window.lastN(this.config.maxConsecutiveRepeats + 1);
    let consecutiveRepeats = 1; // current output counts as 1
    let lastSimilarity = 0;

    for (let i = recent.length - 1; i >= 0; i--) {
      const prev = recent[i];
      const similar = this.isSimilar(entry, prev);
      if (i === recent.length - 1) {
        // Track similarity to the immediately preceding entry
        lastSimilarity = prev.hash === hash
          ? 1.0
          : jaccardSimilarity(shingles, prev.shingles);
      }
      if (similar) {
        consecutiveRepeats++;
      } else {
        break; // chain broken
      }
    }

    // Push current entry into the window *after* comparison
    this.window.push(entry);

    // Determine loop status and escalation
    const loopDetected = consecutiveRepeats >= this.config.maxConsecutiveRepeats;
    let escalation: LoopDetectionResult['escalation'] = 'none';

    if (loopDetected) {
      if (
        this.config.abortOnLoop &&
        consecutiveRepeats >= this.config.abortThreshold
      ) {
        escalation = 'abort';
      } else {
        escalation = 'warning';
      }
    }

    return { loopDetected, consecutiveRepeats, lastSimilarity, escalation };
  }

  /**
   * Compare two hash entries for similarity.
   * Fast path: identical hash → identical content.
   * Slow path: Jaccard similarity above threshold.
   */
  private isSimilar(a: HashEntry, b: HashEntry): boolean {
    if (a.hash === b.hash) return true;
    return jaccardSimilarity(a.shingles, b.shingles) >= this.config.similarityThreshold;
  }

  // -----------------------------------------------------------------------
  // Escalation actions
  // -----------------------------------------------------------------------

  /**
   * Inject a system warning message telling the agent to change its approach.
   */
  private injectWarning(
    ctx: MiddlewareContext,
    detection: LoopDetectionResult,
  ): void {
    const warning: MiddlewareMessage = {
      role: 'system',
      content: [
        `[LoopDetection] WARNING: ${detection.consecutiveRepeats} consecutive similar outputs detected.`,
        'Your recent outputs are repeating. Please:',
        '1. Re-read the original task requirements',
        '2. Try a fundamentally different approach',
        '3. If stuck, explicitly state what is blocking you',
        `Similarity score: ${(detection.lastSimilarity * 100).toFixed(1)}%`,
      ].join('\n'),
    };
    ctx.messages.push(warning);
  }

  /**
   * Set the abort flag on metadata and inject a final system message.
   */
  private injectAbort(
    ctx: MiddlewareContext,
    detection: LoopDetectionResult,
  ): void {
    ctx.metadata.aborted = true;
    ctx.metadata.abortReason =
      `Loop detected: ${detection.consecutiveRepeats} consecutive similar outputs ` +
      `(similarity: ${(detection.lastSimilarity * 100).toFixed(1)}%)`;

    const abort: MiddlewareMessage = {
      role: 'system',
      content: [
        `[LoopDetection] ABORT: ${detection.consecutiveRepeats} consecutive similar outputs.`,
        'Pipeline aborted to prevent infinite loop.',
        `Reason: ${ctx.metadata.abortReason}`,
      ].join('\n'),
    };
    ctx.messages.push(abort);
  }

  // -----------------------------------------------------------------------
  // Public helpers
  // -----------------------------------------------------------------------

  /** Reset the sliding window (e.g., on phase transition). */
  reset(): void {
    this.window.clear();
  }

  /** Get current window size (for diagnostics). */
  get currentWindowSize(): number {
    return this.window.size;
  }

  /** Get current config (read-only). */
  getConfig(): Readonly<LoopDetectionConfig> {
    return { ...this.config };
  }
}
