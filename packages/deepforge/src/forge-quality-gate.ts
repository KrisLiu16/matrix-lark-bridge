/**
 * DeepForge 2.0 — QualityGateMiddleware
 *
 * Middleware that evaluates output quality at the end of each iteration.
 * Replaces the fragile regex-based critic/verifier judgment in forge-engine.ts
 * with structured, rule-based quality assessment.
 *
 * Features:
 * - Configurable quality rules with per-category check functions
 * - Weighted scoring across quality dimensions (0–100 integer scale)
 * - Blocking/non-blocking threshold enforcement
 * - Automatic abort on critical quality failures
 * - Built-in default rules for common quality dimensions
 * - State-bag communication via 'quality-gate:report' key
 *
 * @module forge-quality-gate
 */

import type {
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
} from './types/middleware';

import {
  type QualityRule,
  type QualityCheckFn,
  type QualityCheckContext,
  type QualityGateConfig,
  type QualityReport,
  type QualityVerdict,
  type DimensionScore,
  type QualityIssue,
  type QualityThresholdConfig,
  QualitySeverity,
  QualityCategory,
  DEFAULT_THRESHOLD_CONFIG,
  evaluateVerdict,
} from './types/quality';

import { MIDDLEWARE_NAMES } from './types/middleware';

// ━━━━━━━━━━━━━━ State Keys ━━━━━━━━━━━━━━

/** Key used to store the quality report in context.state */
export const QUALITY_GATE_STATE_KEY = 'quality-gate:report';

/** Key used to store the retry count in context.state */
export const QUALITY_GATE_RETRY_KEY = 'quality-gate:retryCount';

// ━━━━━━━━━━━━━━ Default Check Functions ━━━━━━━━━━━━━━

/**
 * Built-in check: Completeness — evaluates whether the output contains
 * substantive content (not empty or trivially short).
 */
const checkCompleteness: QualityCheckFn = async (
  output: string,
  context: QualityCheckContext,
): Promise<DimensionScore> => {
  const issues: QualityIssue[] = [];
  let score = 1.0;

  const trimmed = output.trim();

  if (trimmed.length === 0) {
    score = 0;
    issues.push({
      severity: QualitySeverity.CRITICAL,
      category: QualityCategory.COMPLETENESS,
      description: 'Output is empty.',
      suggestion: 'Ensure the agent produces meaningful output.',
      ruleId: 'completeness',
    });
  } else if (trimmed.length < 50) {
    score = 0.3;
    issues.push({
      severity: QualitySeverity.MAJOR,
      category: QualityCategory.COMPLETENESS,
      description: `Output is very short (${trimmed.length} chars).`,
      suggestion: 'Verify that the output addresses the task fully.',
      ruleId: 'completeness',
    });
  } else if (trimmed.length < 200) {
    score = 0.7;
    issues.push({
      severity: QualitySeverity.MINOR,
      category: QualityCategory.COMPLETENESS,
      description: `Output may be incomplete (${trimmed.length} chars).`,
      suggestion: 'Review whether all aspects of the task are addressed.',
      ruleId: 'completeness',
    });
  }

  return {
    category: QualityCategory.COMPLETENESS,
    score,
    weight: 1.0,
    issues,
  };
};

/**
 * Built-in check: Format — evaluates basic structural quality
 * (e.g., not garbled, has reasonable structure).
 */
const checkFormat: QualityCheckFn = async (
  output: string,
  _context: QualityCheckContext,
): Promise<DimensionScore> => {
  const issues: QualityIssue[] = [];
  let score = 1.0;

  // Check for excessive repetition (a sign of LLM looping)
  const lines = output.split('\n');
  if (lines.length > 5) {
    const uniqueLines = new Set(lines.map(l => l.trim()).filter(l => l.length > 0));
    const uniqueRatio = uniqueLines.size / Math.max(lines.filter(l => l.trim().length > 0).length, 1);
    if (uniqueRatio < 0.3) {
      score = 0.2;
      issues.push({
        severity: QualitySeverity.MAJOR,
        category: QualityCategory.FORMAT,
        description: `Excessive line repetition detected (${Math.round(uniqueRatio * 100)}% unique lines).`,
        suggestion: 'Output appears to contain repetitive content, possibly from an LLM loop.',
        ruleId: 'format',
      });
    } else if (uniqueRatio < 0.5) {
      score = 0.6;
      issues.push({
        severity: QualitySeverity.MINOR,
        category: QualityCategory.FORMAT,
        description: `High line repetition (${Math.round(uniqueRatio * 100)}% unique lines).`,
        suggestion: 'Review output for unnecessary repetition.',
        ruleId: 'format',
      });
    }
  }

  return {
    category: QualityCategory.FORMAT,
    score,
    weight: 0.5,
    issues,
  };
};

/**
 * Built-in check: Relevance — simple heuristic checking if the output
 * references terms from the task description.
 */
const checkRelevance: QualityCheckFn = async (
  output: string,
  context: QualityCheckContext,
): Promise<DimensionScore> => {
  const issues: QualityIssue[] = [];
  let score = 1.0;

  if (!context.taskDescription) {
    // Cannot assess relevance without a task description
    return { category: QualityCategory.RELEVANCE, score: 1.0, weight: 0.8, issues: [] };
  }

  // Extract significant words from task description (>= 4 chars)
  const taskWords = new Set(
    context.taskDescription
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 4),
  );

  if (taskWords.size === 0) {
    return { category: QualityCategory.RELEVANCE, score: 1.0, weight: 0.8, issues: [] };
  }

  const outputLower = output.toLowerCase();
  let matchCount = 0;
  for (const word of taskWords) {
    if (outputLower.includes(word)) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / taskWords.size;
  if (matchRatio < 0.1) {
    score = 0.2;
    issues.push({
      severity: QualitySeverity.MAJOR,
      category: QualityCategory.RELEVANCE,
      description: 'Output appears unrelated to the task description.',
      suggestion: 'Verify the output addresses the original request.',
      ruleId: 'relevance',
    });
  } else if (matchRatio < 0.3) {
    score = 0.5;
    issues.push({
      severity: QualitySeverity.MINOR,
      category: QualityCategory.RELEVANCE,
      description: 'Output has low keyword overlap with the task.',
      suggestion: 'Ensure key aspects of the task are covered.',
      ruleId: 'relevance',
    });
  }

  return {
    category: QualityCategory.RELEVANCE,
    score,
    weight: 0.8,
    issues,
  };
};

/** Map of built-in check functions keyed by rule ID */
const BUILTIN_CHECKS: Record<string, QualityCheckFn> = {
  completeness: checkCompleteness,
  format: checkFormat,
  relevance: checkRelevance,
};

// ━━━━━━━━━━━━━━ Default Rules ━━━━━━━━━━━━━━

/** Default quality rules applied when no custom rules are provided */
export const DEFAULT_QUALITY_RULES: QualityRule[] = [
  {
    id: 'completeness',
    label: 'Output Completeness',
    category: QualityCategory.COMPLETENESS,
    threshold: 0.7,
    weight: 1.0,
    blocking: true,
  },
  {
    id: 'format',
    label: 'Output Format',
    category: QualityCategory.FORMAT,
    threshold: 0.5,
    weight: 0.5,
    blocking: false,
  },
  {
    id: 'relevance',
    label: 'Task Relevance',
    category: QualityCategory.RELEVANCE,
    threshold: 0.6,
    weight: 0.8,
    blocking: false,
  },
];

// ━━━━━━━━━━━━━━ Helper: Extract Output ━━━━━━━━━━━━━━

/**
 * Extracts the latest assistant output from context messages.
 * Returns the concatenated content of trailing assistant messages.
 */
function extractOutput(ctx: MiddlewareContext): string {
  const parts: string[] = [];
  // Walk messages backwards collecting assistant content
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const msg = ctx.messages[i];
    if (msg.role === 'assistant') {
      parts.unshift(msg.content);
    } else {
      break; // Stop at first non-assistant message
    }
  }
  return parts.join('\n');
}

/**
 * Builds a QualityCheckContext from the middleware context.
 */
function buildCheckContext(
  ctx: MiddlewareContext,
  previousReport?: QualityReport,
): QualityCheckContext {
  // Extract task description from the first user message
  const userMsg = ctx.messages.find(m => m.role === 'user');
  return {
    taskDescription: userMsg?.content ?? '',
    role: (ctx.state['currentRole'] as string) ?? 'unknown',
    iteration: ctx.iteration?.number ?? 0,
    previousReport,
    projectMeta: {
      projectId: ctx.config.projectId,
      phase: ctx.config.phase,
    },
  };
}

// ━━━━━━━━━━━━━━ QualityGateMiddleware ━━━━━━━━━━━━━━

/**
 * Quality Gate Middleware — evaluates output quality using configurable
 * rules and structured scoring.
 *
 * Placement: After the core LLM call completes (priority 110, post-processing).
 * The middleware calls next() first to let downstream middleware run,
 * then evaluates the output quality on the way back up the onion.
 *
 * On failure with blockOnFail=true, sets context.metadata.aborted = true
 * and context.metadata.abortReason with details.
 *
 * Results are stored in context.state['quality-gate:report'] as a QualityReport.
 */
export class QualityGateMiddleware implements Middleware {
  readonly name = MIDDLEWARE_NAMES.QUALITY_GATE;
  readonly priority = 110;
  readonly enabled: boolean;
  readonly timeout = 60_000; // Quality checks may involve LLM calls
  readonly continueOnError = false; // Quality gate failures must block the pipeline

  private readonly rules: QualityRule[];
  private readonly thresholdConfig: QualityThresholdConfig;
  private readonly blockOnFail: boolean;
  private readonly maxRetries: number;
  private readonly customChecks: Record<string, QualityCheckFn>;

  constructor(config?: Partial<QualityGateConfig>) {
    this.rules = config?.rules ?? DEFAULT_QUALITY_RULES;
    this.thresholdConfig = config?.thresholdConfig ?? DEFAULT_THRESHOLD_CONFIG;
    this.blockOnFail = config?.blockOnFail ?? true;
    this.maxRetries = config?.maxRetries ?? 2;
    this.customChecks = config?.customChecks ?? {};
    this.enabled = true;
  }

  /**
   * Only run during critiquing/verifying phases, or when explicitly
   * requested via state flag.
   */
  shouldRun(ctx: MiddlewareContext): boolean {
    const phase = ctx.config.phase;
    const forceRun = ctx.state['quality-gate:forceRun'] === true;
    return (
      forceRun ||
      phase === 'critiquing' ||
      phase === 'verifying' ||
      phase === 'completing'
    );
  }

  async execute(
    ctx: MiddlewareContext,
    next: MiddlewareNext,
  ): Promise<MiddlewareContext> {
    // Let downstream middleware execute first (onion model)
    const result = await next();

    // Extract the output to evaluate
    const output = extractOutput(result);
    if (output.length === 0) {
      // No output to evaluate — skip quality check
      return result;
    }

    const startTime = Date.now();

    // Build check context
    const previousReport = result.state[QUALITY_GATE_STATE_KEY] as QualityReport | undefined;
    const checkContext = buildCheckContext(result, previousReport);

    // Run all rule checks
    const dimensions = await this.runChecks(output, checkContext);

    // Compute verdict using the shared evaluateVerdict function
    const verdict = evaluateVerdict(dimensions, this.thresholdConfig);

    // Convert score to 0-100 integer scale for reporting
    const scorePercent = Math.round(verdict.score * 100);

    // Build the quality report
    const report: QualityReport = {
      verdict: {
        ...verdict,
        summary: verdict.pass
          ? `Quality gate PASSED (score: ${scorePercent}/100, ${verdict.issues.length} issues).`
          : `Quality gate FAILED (score: ${scorePercent}/100, ${verdict.issues.length} issues). ${verdict.summary}`,
      },
      dimensions,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      metadata: {
        rulesEvaluated: this.rules.length,
        scorePercent,
        blockOnFail: this.blockOnFail,
      },
    };

    // Store report in state for downstream consumers
    result.state[QUALITY_GATE_STATE_KEY] = report;

    // Handle failure
    if (!verdict.pass && this.blockOnFail) {
      const retryCount = (result.state[QUALITY_GATE_RETRY_KEY] as number) ?? 0;

      if (retryCount >= this.maxRetries) {
        // Max retries exceeded — abort
        result.metadata.aborted = true;
        result.metadata.abortReason =
          `Quality gate failed after ${retryCount} retries. ` +
          `Score: ${scorePercent}/100. ` +
          `Critical: ${verdict.issues.filter(i => i.severity === QualitySeverity.CRITICAL).length}, ` +
          `Major: ${verdict.issues.filter(i => i.severity === QualitySeverity.MAJOR).length}.`;
      } else {
        // Increment retry counter for next iteration
        result.state[QUALITY_GATE_RETRY_KEY] = retryCount + 1;
      }
    }

    return result;
  }

  /**
   * Runs all configured quality checks and collects dimension scores.
   * Uses custom check functions when available, falls back to built-in checks.
   */
  private async runChecks(
    output: string,
    context: QualityCheckContext,
  ): Promise<DimensionScore[]> {
    const dimensions: DimensionScore[] = [];
    const seenCategories = new Set<QualityCategory>();

    for (const rule of this.rules) {
      // Find the check function: custom > built-in
      const checkFn =
        this.customChecks[rule.id] ?? BUILTIN_CHECKS[rule.id];

      if (!checkFn) {
        // No check function for this rule — skip with a warning score
        dimensions.push({
          category: rule.category,
          score: 1.0, // Assume pass if no checker
          weight: rule.weight,
          issues: [
            {
              severity: QualitySeverity.INFO,
              category: rule.category,
              description: `No check function registered for rule '${rule.id}'. Assumed pass.`,
              suggestion: `Register a custom check via QualityGateConfig.customChecks['${rule.id}'].`,
              ruleId: rule.id,
            },
          ],
        });
        seenCategories.add(rule.category);
        continue;
      }

      // Avoid duplicate category evaluations
      if (seenCategories.has(rule.category)) {
        continue;
      }
      seenCategories.add(rule.category);

      try {
        const dimScore = await checkFn(output, context);
        // Override weight from rule config
        dimensions.push({
          ...dimScore,
          weight: rule.weight,
        });
      } catch (err) {
        // Check function threw — record as a failed dimension
        dimensions.push({
          category: rule.category,
          score: 0,
          weight: rule.weight,
          issues: [
            {
              severity: QualitySeverity.MAJOR,
              category: rule.category,
              description: `Check function for rule '${rule.id}' threw an error: ${err instanceof Error ? err.message : String(err)}`,
              suggestion: 'Fix the custom check function or remove the rule.',
              ruleId: rule.id,
            },
          ],
        });
      }
    }

    return dimensions;
  }
}

// ━━━━━━━━━━━━━━ Factory ━━━━━━━━━━━━━━

/**
 * Creates a QualityGateMiddleware with the given configuration.
 * Convenience factory for pipeline registration.
 */
export function createQualityGateMiddleware(
  config?: Partial<QualityGateConfig>,
): QualityGateMiddleware {
  return new QualityGateMiddleware(config);
}
