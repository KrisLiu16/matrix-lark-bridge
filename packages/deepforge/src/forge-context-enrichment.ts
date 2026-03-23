/**
 * DeepForge 2.0 — Context Enrichment Middleware
 *
 * Implements ContextEnrichmentMiddleware as a class-based Middleware.
 * Replaces the hardcoded forge-context.ts with a dynamic, layered
 * context injection system using token-budget-aware smart trimming.
 *
 * 5-layer context model (inspired by DeerFlow's format_memory_for_injection):
 *   Layer -1 (memory)    — Persistent memory facts & user context
 *   Layer  0 (brief)     — Project brief + current status + index (always)
 *   Layer  0.5 (trend)   — Iteration trend / progress summary
 *   Layer  1 (role)      — Role-specific report & plan
 *   Layer  1.5 (peers)   — Summaries from other roles + feedback
 *   Layer  2 (artifacts) — Available artifact file listing
 *
 * Token budget strategy (from DeerFlow's incremental allocation):
 *   1. Resolve all layers into ContextFragments
 *   2. Sort by priority (high = kept first)
 *   3. Incrementally allocate tokens: add fragments until budget exhausted
 *   4. Required fragments always included; non-required dropped by priority
 *
 * @module forge-context-enrichment
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
} from './types/middleware';
import type { MemoryEntry, UserContext } from './types/memory';

// ─────────────────── Configuration ───────────────────

/** Configuration for the context enrichment middleware. */
export interface ContextEnrichmentConfig {
  /** Maximum total token budget for injected context. @default 12000 */
  maxTokens: number;
  /** Sections to enable/disable individually. */
  enabledSections: ContextSectionFlags;
  /** Max characters to read per file. @default 4000 */
  maxFileChars: number;
  /** Max tail sections for log files. @default 5 */
  maxTailSections: number;
  /** File cache TTL in milliseconds. @default 10000 */
  cacheTtlMs: number;
}

/** Toggle individual context sections on/off. */
export interface ContextSectionFlags {
  memory: boolean;
  brief: boolean;
  status: boolean;
  index: boolean;
  trend: boolean;
  role: boolean;
  plan: boolean;
  peers: boolean;
  feedback: boolean;
  artifacts: boolean;
}

/** Default config values. */
export const DEFAULT_CONTEXT_ENRICHMENT_CONFIG: ContextEnrichmentConfig = {
  maxTokens: 12000,
  enabledSections: {
    memory: true,
    brief: true,
    status: true,
    index: true,
    trend: true,
    role: true,
    plan: true,
    peers: true,
    feedback: true,
    artifacts: true,
  },
  maxFileChars: 4000,
  maxTailSections: 5,
  cacheTtlMs: 10_000,
};

// ─────────────────── Context Layer Types ───────────────────

/** Identifier for each context layer, ordered by injection priority. */
export type ContextLayerId =
  | 'memory'
  | 'brief'
  | 'status'
  | 'index'
  | 'trend'
  | 'role'
  | 'plan'
  | 'peers'
  | 'feedback'
  | 'artifacts';

/** A single resolved context fragment ready for injection. */
export interface ContextFragment {
  layerId: ContextLayerId;
  heading: string;
  content: string;
  estimatedTokens: number;
  /** Higher priority = kept first when trimming. */
  priority: number;
  /** Required fragments are never trimmed. */
  required: boolean;
}

/** Result stored in ctx.state after enrichment. */
export interface ContextEnrichmentResult {
  prompt: string;
  tokenBreakdown: Record<ContextLayerId, number>;
  totalTokens: number;
  wasTrimmed: boolean;
  trimmedLayers: ContextLayerId[];
  fragmentCount: number;
}

/** State keys used by this middleware in ctx.state. */
export const CONTEXT_STATE_KEYS = {
  /** ContextEnrichmentInput — must be set before middleware runs */
  INPUT: 'context-enrichment:input',
  /** ContextEnrichmentResult — set after middleware runs */
  RESULT: 'context-enrichment:result',
  /** Warning string if trimming occurred */
  WARNING: 'context-enrichment:warning',
} as const;

/** Input that callers set in ctx.state[CONTEXT_STATE_KEYS.INPUT]. */
export interface ContextEnrichmentInput {
  /** Working directory containing project files */
  workDir: string;
  /** Current role name */
  role: string;
  /** Current iteration number */
  iteration: number;
  /** All project roles (for peer summary resolution) */
  allRoles: Array<{ name: string; label: string }>;
  /** Whether the role is 'leader' */
  isLeader?: boolean;
  /** Optional memory entries to inject (sorted by relevanceScore desc) */
  memoryEntries?: MemoryEntry[];
  /** Optional user context from memory system */
  userContext?: Partial<UserContext>;
  /** Config overrides (merged with defaults) */
  configOverrides?: Partial<ContextEnrichmentConfig>;
}

// ─────────────────── Token Estimation ───────────────────

/**
 * Estimate token count for mixed CJK/Latin text.
 * CJK chars ≈ 1.5 tokens each; Latin ≈ 4 chars per token.
 * Deliberately conservative to avoid exceeding limits.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let latinChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      cjkChars++;
    } else {
      latinChars++;
    }
  }
  return Math.ceil(cjkChars * 1.5 + latinChars / 4);
}

// ─────────────────── File Utilities ───────────────────

/** Cache entry for file reads. */
interface FileCacheEntry {
  content: string;
  ts: number;
}

/** File read cache shared across calls within a middleware instance. */
class FileCache {
  private cache = new Map<string, FileCacheEntry>();

  constructor(private ttlMs: number) {}

  read(path: string, maxChars: number): string {
    try {
      if (!existsSync(path)) return '';
      const now = Date.now();
      const cached = this.cache.get(path);
      if (cached && now - cached.ts < this.ttlMs) {
        return this.truncate(cached.content, maxChars);
      }
      const content = readFileSync(path, 'utf-8').trim();
      this.cache.set(path, { content, ts: now });
      return this.truncate(content, maxChars);
    } catch {
      return '';
    }
  }

  readTail(path: string, maxSections: number, maxChars: number): string {
    try {
      if (!existsSync(path)) return '';
      const content = readFileSync(path, 'utf-8').trim();
      const sections = content.split(/(?=^## )/m);
      if (sections.length <= maxSections) return this.truncate(content, maxChars);
      const kept = sections.slice(-maxSections);
      return this.truncate(
        `...(${sections.length - maxSections} earlier sections omitted)\n\n` + kept.join(''),
        maxChars,
      );
    } catch {
      return '';
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return content.substring(0, maxChars) + '\n\n...(truncated, use Read tool for full content)';
  }
}

/** List files recursively, excluding dotfiles. */
function listArtifactFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true })
      .map(String)
      .filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}

// ─────────────────── Layer Resolvers ───────────────────

/**
 * Each resolver returns an array of ContextFragments for its layer.
 * They take the input + config and use the file cache for I/O.
 */

function resolveMemoryLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
): ContextFragment[] {
  const fragments: ContextFragment[] = [];
  if (!config.enabledSections.memory) return fragments;

  const { userContext, memoryEntries } = input;

  // User context (3-axis model from DeerFlow)
  if (userContext) {
    const parts: string[] = [];
    if (userContext.workContext) parts.push(`工作上下文: ${userContext.workContext}`);
    if (userContext.personalContext) parts.push(`个人上下文: ${userContext.personalContext}`);
    if (userContext.topOfMind) parts.push(`当前关注: ${userContext.topOfMind}`);
    if (userContext.preferences) parts.push(`偏好: ${userContext.preferences}`);
    if (parts.length > 0) {
      const content = parts.join('\n');
      fragments.push({
        layerId: 'memory',
        heading: '用户记忆',
        content,
        estimatedTokens: estimateTokens(content),
        priority: 90,
        required: false,
      });
    }
  }

  // Memory entries (sorted by relevanceScore, from MemoryEntry type)
  if (memoryEntries && memoryEntries.length > 0) {
    const sorted = [...memoryEntries].sort((a, b) => b.relevanceScore - a.relevanceScore);
    const content = sorted
      .map(e => `- [${e.type}] ${e.content} (相关度: ${e.relevanceScore.toFixed(2)}, 置信度: ${e.confidence.toFixed(2)})`)
      .join('\n');
    fragments.push({
      layerId: 'memory',
      heading: '记忆条目',
      content,
      estimatedTokens: estimateTokens(content),
      priority: 80,
      required: false,
    });
  }

  return fragments;
}

function resolveBriefLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
  fileCache: FileCache,
): ContextFragment[] {
  const { workDir } = input;
  const { maxFileChars } = config;
  const fragments: ContextFragment[] = [];

  if (config.enabledSections.brief) {
    const brief = fileCache.read(join(workDir, 'brief.md'), maxFileChars);
    if (brief) {
      fragments.push({
        layerId: 'brief',
        heading: '项目简介',
        content: brief,
        estimatedTokens: estimateTokens(brief),
        priority: 100,
        required: true,
      });
    }
  }

  if (config.enabledSections.status) {
    const status = fileCache.read(join(workDir, 'status.md'), maxFileChars);
    if (status) {
      fragments.push({
        layerId: 'status',
        heading: '当前状态',
        content: status,
        estimatedTokens: estimateTokens(status),
        priority: 100,
        required: true,
      });
    }
  }

  if (config.enabledSections.index) {
    const index = fileCache.read(join(workDir, 'index.md'), maxFileChars);
    if (index) {
      const lineCount = index.split('\n').filter(l => l.trim()).length;
      fragments.push({
        layerId: 'index',
        heading: `产出索引（${lineCount} 条）`,
        content: index,
        estimatedTokens: estimateTokens(index),
        priority: 95,
        required: true,
      });
    }
  }

  return fragments;
}

function resolveTrendLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
  fileCache: FileCache,
): ContextFragment[] {
  if (!config.enabledSections.trend) return [];

  const { workDir, iteration } = input;
  const { maxTailSections, maxFileChars } = config;
  const fragments: ContextFragment[] = [];

  // Previous iteration summary from forge-state.json
  if (iteration > 1) {
    const statePath = join(workDir, 'forge-state.json');
    const summary = buildPreviousIterSummary(statePath, iteration);
    if (summary) {
      fragments.push({
        layerId: 'trend',
        heading: '上轮任务完成摘要',
        content: summary,
        estimatedTokens: estimateTokens(summary),
        priority: 70,
        required: false,
      });
    }
  }

  // Iteration log (tail of recent iterations)
  const iterLog = fileCache.readTail(
    join(workDir, 'iteration-log.md'),
    maxTailSections,
    maxFileChars,
  );
  if (iterLog) {
    fragments.push({
      layerId: 'trend',
      heading: `迭代日志（近 ${maxTailSections} 轮）`,
      content: iterLog,
      estimatedTokens: estimateTokens(iterLog),
      priority: 60,
      required: false,
    });
  }

  return fragments;
}

function resolveRoleLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
  fileCache: FileCache,
): ContextFragment[] {
  const { workDir, role, iteration } = input;
  const { maxFileChars } = config;
  const fragments: ContextFragment[] = [];

  if (config.enabledSections.role) {
    // Own previous report (summary preferred, fallback to full report)
    const summaryPath = join(workDir, 'reports', `${role}-summary.md`);
    const reportPath = join(workDir, 'reports', `${role}-report.md`);
    const report = fileCache.read(summaryPath, maxFileChars)
      || fileCache.read(reportPath, maxFileChars);
    if (report) {
      fragments.push({
        layerId: 'role',
        heading: '你上一次的汇报',
        content: report,
        estimatedTokens: estimateTokens(report),
        priority: 85,
        required: false,
      });
    }
  }

  if (config.enabledSections.plan) {
    // Current iteration plan
    const planPath = join(workDir, 'iterations', String(iteration).padStart(3, '0'), 'plan.md');
    const plan = fileCache.read(planPath, maxFileChars);
    if (plan) {
      fragments.push({
        layerId: 'plan',
        heading: '本轮计划',
        content: plan,
        estimatedTokens: estimateTokens(plan),
        priority: 90,
        required: true,
      });
    }
  }

  return fragments;
}

function resolvePeerLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
  fileCache: FileCache,
): ContextFragment[] {
  const { workDir, role, allRoles, isLeader } = input;
  const { maxFileChars } = config;
  const fragments: ContextFragment[] = [];

  // Leader sees all other role summaries/reports
  if (isLeader && config.enabledSections.peers) {
    for (const r of allRoles) {
      if (r.name === 'leader' || r.name === role) continue;
      // Prefer summary over full report for peers
      const summary = fileCache.read(join(workDir, 'reports', `${r.name}-summary.md`), maxFileChars)
        || fileCache.read(join(workDir, 'reports', `${r.name}-report.md`), maxFileChars);
      if (summary) {
        fragments.push({
          layerId: 'peers',
          heading: `${r.label} 汇报`,
          content: summary,
          estimatedTokens: estimateTokens(summary),
          priority: 50,
          required: false,
        });
      }
    }

    // Critic & verifier reports
    for (const special of ['critic', 'verifier'] as const) {
      const report = fileCache.read(join(workDir, 'reports', `${special}-report.md`), maxFileChars);
      if (report) {
        fragments.push({
          layerId: 'peers',
          heading: special === 'critic' ? 'Critic 汇报' : 'Verifier 核查结果',
          content: report,
          estimatedTokens: estimateTokens(report),
          priority: special === 'verifier' ? 55 : 52,
          required: false,
        });
      }
    }
  }

  // All roles see feedback
  if (config.enabledSections.feedback) {
    const feedback = fileCache.read(join(workDir, 'feedback.md'), maxFileChars);
    if (feedback) {
      fragments.push({
        layerId: 'feedback',
        heading: '反馈（Critic + 用户）',
        content: feedback,
        estimatedTokens: estimateTokens(feedback),
        priority: 75,
        required: false,
      });
    }
  }

  return fragments;
}

function resolveArtifactsLayer(
  input: ContextEnrichmentInput,
  config: ContextEnrichmentConfig,
): ContextFragment[] {
  if (!config.enabledSections.artifacts) return [];

  const files = listArtifactFiles(join(input.workDir, 'artifacts'));
  if (files.length === 0) return [];

  const content = files.map(f => `- artifacts/${f}`).join('\n');
  return [{
    layerId: 'artifacts',
    heading: '可用文件（用 Read 工具按需查看）',
    content,
    estimatedTokens: estimateTokens(content),
    priority: 30,
    required: false,
  }];
}

// ─────────────────── Previous Iteration Summary ───────────────────

function buildPreviousIterSummary(statePath: string, currentIteration: number): string {
  try {
    if (!existsSync(statePath)) return '';
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const prevIter = state.iterations?.find(
      (i: { number: number }) => i.number === currentIteration - 1,
    );
    if (!prevIter?.tasks?.length) return '';

    const lines: string[] = [];
    for (const t of prevIter.tasks) {
      const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
      const dur = t.durationMs ? `${Math.round(t.durationMs / 1000)}s` : '?';
      const desc = (t.description || '').substring(0, 100);
      lines.push(
        `- ${icon} **${t.id}**（${t.role}，${dur}）: ${desc}` +
        (t.error ? ` [错误: ${t.error.substring(0, 80)}]` : ''),
      );
    }

    const completed = prevIter.tasks.filter((t: { status: string }) => t.status === 'completed').length;
    const failed = prevIter.tasks.filter((t: { status: string }) => t.status === 'failed').length;
    lines.unshift(
      `迭代 ${currentIteration - 1}：${completed} 完成，${failed} 失败，共 ${prevIter.tasks.length} 任务\n`,
    );
    return lines.join('\n');
  } catch {
    return '';
  }
}

// ─────────────────── Smart Trimming (DeerFlow-style incremental budget) ───────────────────

/**
 * Trim fragments to fit within token budget.
 *
 * Uses DeerFlow's incremental allocation strategy:
 *   1. Required fragments are always included (budget reserved first)
 *   2. Remaining budget allocated to non-required fragments by priority desc
 *   3. If a fragment doesn't fit fully, it's truncated to remaining budget
 *   4. Fragments that can't fit at all are dropped
 */
function trimToFit(
  fragments: ContextFragment[],
  maxTokens: number,
): { kept: ContextFragment[]; trimmedLayers: ContextLayerId[] } {
  const trimmedLayers = new Set<ContextLayerId>();

  // Step 1: Separate required vs optional
  const required = fragments.filter(f => f.required);
  const optional = fragments.filter(f => !f.required);

  // Step 2: Reserve budget for required fragments
  const requiredTokens = required.reduce((sum, f) => sum + f.estimatedTokens, 0);
  let remainingBudget = maxTokens - requiredTokens;

  // If required alone exceeds budget, keep all required but mark optional as trimmed
  if (remainingBudget < 0) {
    const droppedLayers = [...new Set(optional.map(f => f.layerId))];
    return { kept: required, trimmedLayers: droppedLayers };
  }

  // Step 3: Allocate remaining budget to optional fragments by priority (high first)
  const sortedOptional = [...optional].sort((a, b) => b.priority - a.priority);
  const kept = [...required];

  for (const frag of sortedOptional) {
    if (remainingBudget <= 0) {
      trimmedLayers.add(frag.layerId);
      continue;
    }

    if (frag.estimatedTokens <= remainingBudget) {
      // Fragment fits entirely
      kept.push(frag);
      remainingBudget -= frag.estimatedTokens;
    } else {
      // Partial fit — truncate content to remaining budget
      const availableChars = Math.floor(remainingBudget * 3); // rough token→char conversion
      if (availableChars < 50) {
        // Too small to be useful, skip
        trimmedLayers.add(frag.layerId);
        continue;
      }
      const truncatedContent =
        frag.content.substring(0, availableChars) + '\n\n...(trimmed to fit token budget)';
      kept.push({
        ...frag,
        content: truncatedContent,
        estimatedTokens: estimateTokens(truncatedContent),
      });
      remainingBudget = 0;
      trimmedLayers.add(frag.layerId);
    }
  }

  return { kept, trimmedLayers: [...trimmedLayers] };
}

// ─────────────────── Prompt Assembly ───────────────────

/** Canonical layer ordering for prompt assembly. */
const LAYER_ORDER: ContextLayerId[] = [
  'memory',
  'brief',
  'status',
  'index',
  'trend',
  'plan',
  'role',
  'peers',
  'feedback',
  'artifacts',
];

/** Assemble fragments into a single prompt string, ordered by layer. */
function assemblePrompt(fragments: ContextFragment[]): string {
  const sorted = [...fragments].sort((a, b) => {
    const orderA = LAYER_ORDER.indexOf(a.layerId);
    const orderB = LAYER_ORDER.indexOf(b.layerId);
    if (orderA !== orderB) return orderA - orderB;
    return b.priority - a.priority; // within layer, higher priority first
  });

  return sorted.map(f => `## ${f.heading}\n${f.content}`).join('\n\n---\n\n');
}

// ─────────────────── Middleware Class ───────────────────

/** Marker name for the injected system message. */
const FORGE_CONTEXT_MARKER = '__forge_context';

/**
 * ContextEnrichmentMiddleware — class-based middleware for the DeepForge pipeline.
 *
 * Implements the Middleware interface from types/middleware.ts.
 * Injects layered project context into the message list before LLM execution.
 *
 * Usage:
 *   1. Set ctx.state[CONTEXT_STATE_KEYS.INPUT] with a ContextEnrichmentInput
 *   2. Register this middleware in the pipeline (priority 50)
 *   3. After execution, read ctx.state[CONTEXT_STATE_KEYS.RESULT] for metrics
 */
export class ContextEnrichmentMiddleware implements Middleware {
  readonly name = 'context-enrichment';
  readonly priority = 50;
  readonly enabled = true;
  readonly timeout = 5_000;
  readonly continueOnError = true; // context enrichment failure shouldn't abort pipeline

  private fileCache: FileCache;
  private defaultConfig: ContextEnrichmentConfig;

  constructor(config?: Partial<ContextEnrichmentConfig>) {
    this.defaultConfig = { ...DEFAULT_CONTEXT_ENRICHMENT_CONFIG, ...config };
    if (config?.enabledSections) {
      this.defaultConfig.enabledSections = {
        ...DEFAULT_CONTEXT_ENRICHMENT_CONFIG.enabledSections,
        ...config.enabledSections,
      };
    }
    this.fileCache = new FileCache(this.defaultConfig.cacheTtlMs);
  }

  /** Only run when context input is provided in state. */
  shouldRun(ctx: MiddlewareContext): boolean {
    return ctx.state[CONTEXT_STATE_KEYS.INPUT] != null;
  }

  async execute(ctx: MiddlewareContext, next: MiddlewareNext): Promise<MiddlewareContext> {
    const input = ctx.state[CONTEXT_STATE_KEYS.INPUT] as ContextEnrichmentInput;

    // Merge config with per-call overrides
    const config: ContextEnrichmentConfig = {
      ...this.defaultConfig,
      ...input.configOverrides,
    };
    if (input.configOverrides?.enabledSections) {
      config.enabledSections = {
        ...this.defaultConfig.enabledSections,
        ...input.configOverrides.enabledSections,
      };
    }

    // Resolve all layers
    const allFragments: ContextFragment[] = [
      ...resolveMemoryLayer(input, config),
      ...resolveBriefLayer(input, config, this.fileCache),
      ...resolveTrendLayer(input, config, this.fileCache),
      ...resolveRoleLayer(input, config, this.fileCache),
      ...resolvePeerLayer(input, config, this.fileCache),
      ...resolveArtifactsLayer(input, config),
    ];

    // Trim to budget using DeerFlow-style incremental allocation
    const { kept, trimmedLayers } = trimToFit(allFragments, config.maxTokens);

    // Compute per-layer token breakdown
    const tokenBreakdown = Object.fromEntries(
      LAYER_ORDER.map(id => [id, 0]),
    ) as Record<ContextLayerId, number>;
    for (const f of kept) {
      tokenBreakdown[f.layerId] += f.estimatedTokens;
    }
    const totalTokens = kept.reduce((sum, f) => sum + f.estimatedTokens, 0);

    // Assemble prompt
    const prompt = assemblePrompt(kept);

    // Inject as system message at the front, replacing any previous injection
    if (prompt) {
      ctx.messages = [
        {
          role: 'system' as const,
          content: prompt,
          name: FORGE_CONTEXT_MARKER,
        },
        ...ctx.messages.filter(m => m.name !== FORGE_CONTEXT_MARKER),
      ];
    }

    // Store result for downstream middleware
    const result: ContextEnrichmentResult = {
      prompt,
      tokenBreakdown,
      totalTokens,
      wasTrimmed: trimmedLayers.length > 0,
      trimmedLayers,
      fragmentCount: kept.length,
    };
    ctx.state[CONTEXT_STATE_KEYS.RESULT] = result;

    if (result.wasTrimmed) {
      ctx.state[CONTEXT_STATE_KEYS.WARNING] =
        `Context trimmed: ${trimmedLayers.join(', ')} layers affected. ` +
        `Total: ${totalTokens} tokens (budget: ${config.maxTokens})`;
    }

    return next();
  }

  /** Clear the file read cache (useful between iterations or in tests). */
  clearCache(): void {
    this.fileCache.clear();
  }
}

/**
 * Factory function for functional middleware registration.
 * Use this if you prefer the MiddlewareDefinition style over class instantiation.
 */
export function createContextEnrichmentMiddleware(
  config?: Partial<ContextEnrichmentConfig>,
): { instance: ContextEnrichmentMiddleware } {
  return { instance: new ContextEnrichmentMiddleware(config) };
}

/** Re-export estimateTokens for use by SummarizationMiddleware and tests. */
export { estimateTokens as contextEstimateTokens };
