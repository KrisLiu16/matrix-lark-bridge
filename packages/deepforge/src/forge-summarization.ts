/**
 * DeepForge 2.0 — SummarizationMiddleware
 *
 * Onion-model after-hook middleware that automatically summarizes
 * large role outputs at the end of each pipeline execution.
 *
 * Design:
 * - Runs AFTER downstream middleware (calls next() first, processes result)
 * - Extracts key conclusions, decisions, and data points from output
 * - Discards redundant descriptions, step-by-step narration, and filler
 * - Writes summary to ctx.state['summarization:result']
 * - Optionally persists summary to reports/<role>-summary.md on disk
 *
 * Inspired by DeerFlow's _filter_messages_for_memory() message filtering
 * pipeline — applies similar compression to role output text.
 *
 * @module forge-summarization
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  ForgePhase,
} from './types/middleware';

// ━━━━━━━━━━━━━━ Configuration ━━━━━━━━━━━━━━

/** Summarization output style. */
export type SummaryStyle = 'structured' | 'prose' | 'bullets';

/** Configuration for the summarization middleware. */
export interface SummarizationConfig {
  /** Output character threshold — only summarize if output exceeds this. @default 8000 */
  outputThreshold: number;
  /** Maximum length of the summary in characters. @default 1500 */
  maxSummaryLength: number;
  /** Summary style. @default 'structured' */
  summaryStyle: SummaryStyle;
  /** Whether to persist summary to disk as reports/<role>-summary.md. @default true */
  persistToDisk: boolean;
  /** Phases during which this middleware should run. */
  activePhases: ForgePhase[];
  /** Maximum number of key points to extract per section. @default 5 */
  maxKeyPointsPerSection: number;
  /** Whether to include a metrics/statistics line in the summary. @default true */
  includeMetrics: boolean;
}

/** Default configuration. */
export const DEFAULT_SUMMARIZATION_CONFIG: SummarizationConfig = {
  outputThreshold: 8000,
  maxSummaryLength: 1500,
  summaryStyle: 'structured',
  persistToDisk: true,
  activePhases: ['executing', 'iterating'],
  maxKeyPointsPerSection: 5,
  includeMetrics: true,
};

// ━━━━━━━━━━━━━━ State Keys ━━━━━━━━━━━━━━

/** State keys used by this middleware in ctx.state. */
export const SUMMARIZATION_STATE_KEYS = {
  /** SummarizationInput — set by caller before pipeline run */
  INPUT: 'summarization:input',
  /** SummarizationResult — set after summarization completes */
  RESULT: 'summarization:result',
} as const;

/** Input that callers set in ctx.state before the pipeline runs. */
export interface SummarizationInput {
  /** Working directory for persisting summary files */
  workDir: string;
  /** Current role name (used for file naming) */
  role: string;
  /** Config overrides */
  configOverrides?: Partial<SummarizationConfig>;
}

/** Result stored in ctx.state after summarization. */
export interface SummarizationResult {
  /** The generated summary text */
  summary: string;
  /** Original output length in characters */
  originalLength: number;
  /** Summary length in characters */
  summaryLength: number;
  /** Compression ratio (summary / original) */
  compressionRatio: number;
  /** Whether summarization was actually performed (false if output was below threshold) */
  wasPerformed: boolean;
  /** Path where summary was persisted (if persistToDisk=true) */
  persistedPath?: string;
  /** Number of sections extracted */
  sectionsExtracted: number;
}

// ━━━━━━━━━━━━━━ Text Analysis Utilities ━━━━━━━━━━━━━━

/** Section extracted from structured output. */
interface OutputSection {
  heading: string;
  content: string;
  level: number;
}

/**
 * Parse markdown-style output into sections.
 * Splits on ## or ### headings.
 */
function parseIntoSections(text: string): OutputSection[] {
  const lines = text.split('\n');
  const sections: OutputSection[] = [];
  let currentHeading = '';
  let currentLevel = 0;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentHeading || currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
          level: currentLevel,
        });
      }
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Flush last section
  if (currentHeading || currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
      level: currentLevel,
    });
  }

  return sections;
}

/**
 * Extract key points from a block of text.
 *
 * Strategy:
 * - Prioritize lines starting with bullet markers (-, *, •)
 * - Prioritize lines containing decision markers (✅, ❌, →, ⚠️)
 * - Prioritize lines with data/numbers (percentages, counts, file sizes)
 * - Deprioritize filler lines (step narration, "let me", "now I will")
 */
function extractKeyPoints(text: string, maxPoints: number): string[] {
  if (!text.trim()) return [];

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Score each line by informativeness
  const scored = lines.map(line => {
    let score = 0;

    // Bullet points are usually key info
    if (/^[-*•]\s/.test(line)) score += 2;
    // Numbered lists
    if (/^\d+[.)]\s/.test(line)) score += 2;

    // Decision/status markers
    if (/[✅❌⚠️→←↑↓]/.test(line)) score += 3;
    // Bold text (likely emphasis on key info)
    if (/\*\*[^*]+\*\*/.test(line)) score += 1;

    // Data points: numbers, percentages, file sizes, durations
    if (/\d+%|\d+\.\d+|\d+ bytes|\d+ms|\d+s\b|\d+ 个|\d+ 条/.test(line)) score += 2;
    // File paths (concrete references)
    if (/\.(ts|js|md|json)\b/.test(line)) score += 1;

    // Filler detection — deprioritize
    if (/^(let me|now |首先|接下来|然后|下面)/i.test(line)) score -= 3;
    if (/^(I will|I'll|I'm going|我来|我先)/i.test(line)) score -= 3;

    // Very short lines are usually not key points
    if (line.length < 15) score -= 1;
    // Very long lines may contain important context
    if (line.length > 100) score += 1;

    return { line, score };
  });

  // Sort by score desc, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(s => s.score > 0)
    .slice(0, maxPoints)
    .map(s => s.line);
}

/**
 * Compute basic metrics from the output text.
 */
function computeMetrics(text: string): string {
  const charCount = text.length;
  const lineCount = text.split('\n').length;
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const codeBlockCount = (text.match(/```/g) || []).length / 2;
  return `${charCount} 字符, ${lineCount} 行, ~${wordCount} 词` +
    (codeBlockCount > 0 ? `, ${Math.floor(codeBlockCount)} 代码块` : '');
}

// ━━━━━━━━━━━━━━ Summary Generation ━━━━━━━━━━━━━━

/**
 * Generate a structured summary from the output text.
 *
 * This is a local, deterministic summarization — no LLM call needed.
 * Extracts structure from markdown headings and prioritizes high-signal lines.
 */
function generateSummary(
  output: string,
  config: SummarizationConfig,
): string {
  const sections = parseIntoSections(output);
  const parts: string[] = [];

  if (config.summaryStyle === 'structured') {
    // Group sections, extract key points from each
    for (const section of sections) {
      if (!section.heading && !section.content) continue;

      const keyPoints = extractKeyPoints(section.content, config.maxKeyPointsPerSection);
      if (keyPoints.length === 0 && !section.heading) continue;

      if (section.heading) {
        const prefix = '#'.repeat(Math.min(section.level, 3)) || '##';
        parts.push(`${prefix} ${section.heading}`);
      }
      if (keyPoints.length > 0) {
        parts.push(keyPoints.map(p => {
          // Normalize to bullet format if not already
          if (/^[-*•]\s/.test(p)) return p;
          if (/^\d+[.)]\s/.test(p)) return p;
          return `- ${p}`;
        }).join('\n'));
      }
    }
  } else if (config.summaryStyle === 'bullets') {
    // Flat bullet list of all key points
    const allPoints = sections.flatMap(s =>
      extractKeyPoints(s.content, config.maxKeyPointsPerSection)
    );
    // Deduplicate
    const seen = new Set<string>();
    for (const p of allPoints) {
      const norm = p.replace(/^[-*•]\s+/, '').trim();
      if (!seen.has(norm)) {
        seen.add(norm);
        parts.push(`- ${norm}`);
      }
    }
  } else {
    // prose: join key points as sentences
    const allPoints = sections.flatMap(s =>
      extractKeyPoints(s.content, config.maxKeyPointsPerSection)
    );
    const cleaned = allPoints.map(p => p.replace(/^[-*•]\s+/, '').replace(/^#+\s+/, '').trim());
    parts.push(cleaned.join('。'));
  }

  // Add metrics line
  if (config.includeMetrics) {
    parts.push(`\n> 原文统计: ${computeMetrics(output)}`);
  }

  // Final truncation to maxSummaryLength
  let summary = parts.join('\n\n');
  if (summary.length > config.maxSummaryLength) {
    summary = summary.substring(0, config.maxSummaryLength - 30) +
      '\n\n...(summary truncated)';
  }

  return summary;
}

// ━━━━━━━━━━━━━━ Output Extraction ━━━━━━━━━━━━━━

/**
 * Extract the "output" text from the pipeline context.
 *
 * Looks for:
 * 1. The last assistant message in ctx.messages
 * 2. A role-specific output stored in ctx.state (e.g. from a task runner)
 *
 * Returns the combined output text.
 */
function extractOutput(ctx: MiddlewareContext): string {
  const parts: string[] = [];

  // Check for explicit output in state (set by task runner middleware)
  const stateOutput = ctx.state['task:output'] as string | undefined;
  if (stateOutput) {
    parts.push(stateOutput);
  }

  // Collect assistant messages (the role's output)
  const assistantMessages = ctx.messages
    .filter(m => m.role === 'assistant')
    .map(m => m.content)
    .filter(c => c.length > 0);

  if (assistantMessages.length > 0) {
    parts.push(assistantMessages.join('\n\n'));
  }

  return parts.join('\n\n---\n\n');
}

// ━━━━━━━━━━━━━━ Disk Persistence ━━━━━━━━━━━━━━

/**
 * Write summary to reports/<role>-summary.md.
 * Creates the reports directory if needed.
 */
function persistSummary(
  workDir: string,
  role: string,
  summary: string,
): string {
  const reportsDir = join(workDir, 'reports');
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  const filePath = join(reportsDir, `${role}-summary.md`);
  writeFileSync(filePath, summary, 'utf-8');
  return filePath;
}

// ━━━━━━━━━━━━━━ Middleware Class ━━━━━━━━━━━━━━

/**
 * SummarizationMiddleware — auto-summarizes large role outputs.
 *
 * Operates as an onion after-hook: calls next() first, then inspects
 * the output. If output exceeds the threshold, generates a deterministic
 * summary using structural analysis (heading extraction + key-point scoring).
 *
 * Usage:
 *   1. Set ctx.state[SUMMARIZATION_STATE_KEYS.INPUT] with SummarizationInput
 *   2. Register in the pipeline (priority 70)
 *   3. After execution, read ctx.state[SUMMARIZATION_STATE_KEYS.RESULT]
 *   4. ContextEnrichmentMiddleware reads reports/<role>-summary.md on next iteration
 */
export class SummarizationMiddleware implements Middleware {
  readonly name = 'summarization';
  readonly priority = 70;
  readonly enabled = true;
  readonly timeout = 10_000;
  readonly continueOnError = true;

  private config: SummarizationConfig;

  constructor(config?: Partial<SummarizationConfig>) {
    this.config = { ...DEFAULT_SUMMARIZATION_CONFIG, ...config };
    if (config?.activePhases) {
      this.config.activePhases = config.activePhases;
    }
  }

  /** Run during executing and iterating phases when input is provided. */
  shouldRun(ctx: MiddlewareContext): boolean {
    const phase = ctx.config.phase;
    return (
      this.config.activePhases.includes(phase) &&
      ctx.state[SUMMARIZATION_STATE_KEYS.INPUT] != null
    );
  }

  async execute(ctx: MiddlewareContext, next: MiddlewareNext): Promise<MiddlewareContext> {
    // ── Onion before: pass through to downstream ──
    const result = await next();

    // ── Onion after: inspect and summarize output ──
    const input = result.state[SUMMARIZATION_STATE_KEYS.INPUT] as SummarizationInput | undefined;
    if (!input) return result;

    // Merge config with per-call overrides
    const config: SummarizationConfig = {
      ...this.config,
      ...input.configOverrides,
    };

    // Extract output text from the pipeline context
    const output = extractOutput(result);
    if (!output || output.length <= config.outputThreshold) {
      // Below threshold — record that no summarization was needed
      result.state[SUMMARIZATION_STATE_KEYS.RESULT] = {
        summary: '',
        originalLength: output?.length ?? 0,
        summaryLength: 0,
        compressionRatio: 1,
        wasPerformed: false,
        sectionsExtracted: 0,
      } satisfies SummarizationResult;
      return result;
    }

    // Generate summary
    const summary = generateSummary(output, config);
    const sections = parseIntoSections(output);

    // Persist to disk if configured
    let persistedPath: string | undefined;
    if (config.persistToDisk && input.workDir && input.role) {
      try {
        persistedPath = persistSummary(input.workDir, input.role, summary);
      } catch {
        // Non-fatal — disk write failure shouldn't block pipeline
      }
    }

    // Store result
    const summarizationResult: SummarizationResult = {
      summary,
      originalLength: output.length,
      summaryLength: summary.length,
      compressionRatio: summary.length / output.length,
      wasPerformed: true,
      persistedPath,
      sectionsExtracted: sections.filter(s => s.heading).length,
    };
    result.state[SUMMARIZATION_STATE_KEYS.RESULT] = summarizationResult;

    return result;
  }
}

/**
 * Factory function for creating the summarization middleware.
 */
export function createSummarizationMiddleware(
  config?: Partial<SummarizationConfig>,
): { instance: SummarizationMiddleware } {
  return { instance: new SummarizationMiddleware(config) };
}
