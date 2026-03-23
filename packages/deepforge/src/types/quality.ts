/**
 * Quality Judgment System — Structured verdict types for DeepForge 2.0
 *
 * Replaces the fragile regex-based critic/verifier judgment in forge-engine.ts
 * (matching "CRITICAL", "❌", "FALSE" etc.) with structured JSON verdicts
 * that the engine can evaluate deterministically.
 *
 * Key improvements over v1:
 * - QualityIssue replaces flat string arrays for richer issue tracking
 * - QualitySeverity enum enables severity-based filtering and gating
 * - QualityThreshold provides configurable per-dimension pass criteria
 * - QualityVerdict.issues array gives structured, actionable feedback
 */

// ━━━━━━━━━━━━━━ Enums ━━━━━━━━━━━━━━

/**
 * Severity levels for quality issues, ordered from most to least severe.
 * Used to classify issues and determine whether they block iteration progress.
 */
export enum QualitySeverity {
  /** Blocks iteration; must be resolved before proceeding. */
  CRITICAL = 'CRITICAL',
  /** Significant problem that should be fixed, but may not block on its own. */
  MAJOR = 'MAJOR',
  /** Minor problem or improvement opportunity. */
  MINOR = 'MINOR',
  /** Informational note, no action required. */
  INFO = 'INFO',
}

/**
 * Category of a quality issue. Maps to the dimension being assessed.
 * Extends the v1 QualityDimension with additional practical categories.
 */
export enum QualityCategory {
  /** Missing deliverables or incomplete output. */
  COMPLETENESS = 'COMPLETENESS',
  /** Factual errors, incorrect data, or wrong claims. */
  ACCURACY = 'ACCURACY',
  /** Output does not address the original request. */
  RELEVANCE = 'RELEVANCE',
  /** Output violates required structure or formatting. */
  FORMAT = 'FORMAT',
  /** Security, ethical, or compliance concerns. */
  SAFETY = 'SAFETY',
  /** Code quality issues (style, patterns, best practices). */
  CODE_QUALITY = 'CODE_QUALITY',
  /** Performance or efficiency concerns. */
  PERFORMANCE = 'PERFORMANCE',
  /** Compatibility with existing system or interfaces. */
  COMPATIBILITY = 'COMPATIBILITY',
}

// ━━━━━━━━━━━━━━ Core Issue Type ━━━━━━━━━━━━━━

/**
 * A single quality issue found during assessment.
 * Provides structured, actionable feedback instead of free-text strings.
 */
export interface QualityIssue {
  /** Severity of this issue. */
  severity: QualitySeverity;
  /** Which quality category this issue belongs to. */
  category: QualityCategory;
  /** Human-readable description of the problem. */
  description: string;
  /** Actionable suggestion for how to fix or improve. */
  suggestion: string;
  /** Optional file path or location reference where the issue was found. */
  location?: string;
  /** Optional rule ID that triggered this issue (links to QualityRule.id). */
  ruleId?: string;
}

// ━━━━━━━━━━━━━━ Verdict ━━━━━━━━━━━━━━

/**
 * Structured quality verdict — the final pass/fail judgment produced
 * by a quality check (critic, verifier, or quality gate middleware).
 *
 * Replaces the regex-based boolean + free-text pattern in forge-engine.ts
 * (lines 387-468) with deterministic structured evaluation.
 */
export interface QualityVerdict {
  /** Whether the output passes the quality gate. */
  pass: boolean;
  /** Aggregate score in [0, 1], computed from dimension scores. */
  score: number;
  /** Structured issues found during assessment (replaces v1 string arrays). */
  issues: QualityIssue[];
  /** Human-readable summary of the verdict. */
  summary: string;
}

// ━━━━━━━━━━━━━━ Dimension Scoring ━━━━━━━━━━━━━━

/**
 * Score for a single quality category within a report.
 * Enables per-dimension breakdown of the overall verdict.
 */
export interface DimensionScore {
  /** Which category was evaluated. */
  category: QualityCategory;
  /** Score in [0, 1] for this category. */
  score: number;
  /** Weight applied when computing aggregate score. Must be > 0. */
  weight: number;
  /** Issues found in this dimension. */
  issues: QualityIssue[];
}

// ━━━━━━━━━━━━━━ Thresholds ━━━━━━━━━━━━━━

/**
 * Threshold configuration for a single quality category.
 * Determines the minimum acceptable score and blocking behavior.
 */
export interface QualityThreshold {
  /** Which category this threshold applies to. */
  category: QualityCategory;
  /** Minimum score in [0, 1] required to pass. */
  minScore: number;
  /** Weight of this category in aggregate score computation. */
  weight: number;
  /** If true, failing this threshold blocks iteration progress (hard gate). */
  blocking: boolean;
}

/**
 * Complete threshold configuration for all quality checks.
 * Aggregates per-category thresholds with global settings.
 */
export interface QualityThresholdConfig {
  /** Per-category threshold definitions. */
  thresholds: QualityThreshold[];
  /** Minimum aggregate score across all categories to pass. Default: 0.6 */
  minAggregateScore: number;
  /** Maximum number of CRITICAL issues allowed before auto-fail. Default: 0 */
  maxCriticalIssues: number;
  /** Maximum number of MAJOR issues allowed before auto-fail. Default: 3 */
  maxMajorIssues: number;
}

// ━━━━━━━━━━━━━━ Quality Rules ━━━━━━━━━━━━━━

/**
 * A single quality check rule.
 * Rules are evaluated by the quality gate middleware against iteration output.
 */
export interface QualityRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Which category this rule belongs to. */
  category: QualityCategory;
  /** Minimum score threshold to pass this rule (0–1). */
  threshold: number;
  /** Weight of this rule in aggregate score computation. */
  weight: number;
  /** Whether failing this rule blocks iteration progress (hard gate). */
  blocking: boolean;
}

// ━━━━━━━━━━━━━━ Quality Check Function ━━━━━━━━━━━━━━

/**
 * Context passed to quality check functions.
 * Provides the information needed to evaluate output quality.
 */
export interface QualityCheckContext {
  /** The original task description / user request. */
  taskDescription: string;
  /** Role that produced the output. */
  role: string;
  /** Current iteration number (0-based). */
  iteration: number;
  /** Previous iteration's quality report, if any (for delta comparison). */
  previousReport?: QualityReport;
  /** Project-level metadata (id, title, etc.). */
  projectMeta?: Record<string, unknown>;
}

/**
 * Signature for a custom quality check function.
 * Receives the output text and context, returns a per-dimension score.
 */
export type QualityCheckFn = (
  output: string,
  context: QualityCheckContext,
) => Promise<DimensionScore>;

// ━━━━━━━━━━━━━━ Quality Report ━━━━━━━━━━━━━━

/**
 * Full quality assessment report for one iteration.
 * Aggregates the overall verdict with per-dimension breakdowns.
 */
export interface QualityReport {
  /** Overall verdict (pass/fail + aggregate score + issues). */
  verdict: QualityVerdict;
  /** Per-category score breakdown. */
  dimensions: DimensionScore[];
  /** ISO 8601 timestamp of when the report was generated. */
  timestamp: string;
  /** Duration in milliseconds the quality check took. */
  durationMs: number;
  /** Arbitrary metadata (model used, token count, etc.). */
  metadata: Record<string, unknown>;
}

// ━━━━━━━━━━━━━━ Quality Gate Config ━━━━━━━━━━━━━━

/**
 * Configuration for the quality gate middleware.
 * Controls which rules are evaluated and how failures are handled.
 */
export interface QualityGateConfig {
  /** Rules to evaluate. */
  rules: QualityRule[];
  /** Threshold configuration for pass/fail determination. */
  thresholdConfig: QualityThresholdConfig;
  /** If true, a failing gate blocks the iteration from advancing. */
  blockOnFail: boolean;
  /** Maximum number of retry iterations when gate fails. Default: 2 */
  maxRetries: number;
  /** Custom check functions keyed by rule id (optional override). */
  customChecks?: Record<string, QualityCheckFn>;
}

// ━━━━━━━━━━━━━━ Structured Critic / Verifier Results ━━━━━━━━━━━━━━

/**
 * Structured result from the Critic role.
 * Replaces the free-text `criticFeedback` + regex `criticCleared` pattern
 * in forge-engine.ts (lines 387-400).
 */
export interface CriticResult {
  /** Whether all critical issues are resolved. */
  cleared: boolean;
  /** Full quality report from the critic. */
  report: QualityReport;
  /** Free-form feedback text (preserved for human readability). */
  feedback: string;
}

/**
 * Structured result from the Verifier role.
 * Replaces the free-text `verifierResult` + regex `verifierPassed` pattern
 * in forge-engine.ts (lines 457-468).
 */
export interface VerifierResult {
  /** Whether verification passed. */
  passed: boolean;
  /** Full quality report from the verifier. */
  report: QualityReport;
  /** Free-form result summary (preserved for human readability). */
  summary: string;
}

// ━━━━━━━━━━━━━━ Default Factories ━━━━━━━━━━━━━━

/** Default threshold config suitable for most projects. */
export const DEFAULT_THRESHOLD_CONFIG: QualityThresholdConfig = {
  thresholds: [
    { category: QualityCategory.COMPLETENESS, minScore: 0.7, weight: 1.0, blocking: true },
    { category: QualityCategory.ACCURACY, minScore: 0.8, weight: 1.0, blocking: true },
    { category: QualityCategory.RELEVANCE, minScore: 0.6, weight: 0.8, blocking: false },
    { category: QualityCategory.FORMAT, minScore: 0.5, weight: 0.5, blocking: false },
    { category: QualityCategory.SAFETY, minScore: 0.9, weight: 1.0, blocking: true },
    { category: QualityCategory.CODE_QUALITY, minScore: 0.6, weight: 0.7, blocking: false },
    { category: QualityCategory.PERFORMANCE, minScore: 0.5, weight: 0.5, blocking: false },
    { category: QualityCategory.COMPATIBILITY, minScore: 0.7, weight: 0.8, blocking: true },
  ],
  minAggregateScore: 0.6,
  maxCriticalIssues: 0,
  maxMajorIssues: 3,
};

/**
 * Creates an empty passing QualityVerdict.
 * Useful as initial state or when quality checks are skipped.
 */
export function createEmptyVerdict(): QualityVerdict {
  return {
    pass: true,
    score: 1.0,
    issues: [],
    summary: 'No quality issues found.',
  };
}

/**
 * Creates an empty QualityReport with a passing verdict.
 * Useful as initial state when no quality check has been performed.
 */
export function createEmptyReport(): QualityReport {
  return {
    verdict: createEmptyVerdict(),
    dimensions: [],
    timestamp: new Date().toISOString(),
    durationMs: 0,
    metadata: {},
  };
}

/**
 * Computes whether a verdict should pass based on threshold config and issues.
 * This is a pure function that can be used by both critic and verifier.
 */
export function evaluateVerdict(
  dimensions: DimensionScore[],
  config: QualityThresholdConfig,
): QualityVerdict {
  const allIssues = dimensions.flatMap(d => d.issues);
  const criticalCount = allIssues.filter(i => i.severity === QualitySeverity.CRITICAL).length;
  const majorCount = allIssues.filter(i => i.severity === QualitySeverity.MAJOR).length;

  // Auto-fail on too many critical/major issues
  if (criticalCount > config.maxCriticalIssues || majorCount > config.maxMajorIssues) {
    const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
    const weightedScore = totalWeight > 0
      ? dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight
      : 0;

    return {
      pass: false,
      score: weightedScore,
      issues: allIssues,
      summary: `Failed: ${criticalCount} critical, ${majorCount} major issues (limits: ${config.maxCriticalIssues}/${config.maxMajorIssues}).`,
    };
  }

  // Check per-category blocking thresholds
  for (const threshold of config.thresholds) {
    if (!threshold.blocking) continue;
    const dim = dimensions.find(d => d.category === threshold.category);
    if (dim && dim.score < threshold.minScore) {
      const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
      const weightedScore = totalWeight > 0
        ? dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight
        : 0;

      return {
        pass: false,
        score: weightedScore,
        issues: allIssues,
        summary: `Failed: ${threshold.category} score ${dim.score.toFixed(2)} below blocking threshold ${threshold.minScore}.`,
      };
    }
  }

  // Compute weighted aggregate score
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const weightedScore = totalWeight > 0
    ? dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight
    : 1.0;

  const pass = weightedScore >= config.minAggregateScore;

  return {
    pass,
    score: weightedScore,
    issues: allIssues,
    summary: pass
      ? `Passed with score ${weightedScore.toFixed(2)} (${allIssues.length} issues).`
      : `Failed: aggregate score ${weightedScore.toFixed(2)} below threshold ${config.minAggregateScore}.`,
  };
}
