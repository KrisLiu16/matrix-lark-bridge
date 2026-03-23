/**
 * DeepForge 2.0 — Quality Judgment Bridge Adapter
 *
 * Bridges the gap between forge-engine.ts's existing regex-based
 * critic/verifier judgment (L394-468) and the new structured
 * QualityGate system. Provides:
 *
 * 1. parseQualityReport()  — extracts structured QualityReport from raw text
 * 2. isQualityPassed()     — threshold-based pass/fail determination
 * 3. formatQualityFeedback() — renders report as human-readable text
 * 4. Regex fallback when structured JSON parsing fails
 *
 * @module forge-quality-bridge
 */

import {
  type QualityReport,
  type QualityVerdict,
  type QualityIssue,
  type DimensionScore,
  type QualityThresholdConfig,
  QualitySeverity,
  QualityCategory,
  DEFAULT_THRESHOLD_CONFIG,
  evaluateVerdict,
  createEmptyReport,
} from './types/quality';

// ━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━

/**
 * Marker used to delimit the structured JSON block within critic/verifier output.
 * Critic/Verifier prompts instruct the LLM to wrap JSON between these markers.
 */
const JSON_BLOCK_START = '```quality-report';
const JSON_BLOCK_END = '```';

/**
 * Alternative: fenced JSON code block.
 */
const JSON_FENCED_START = '```json';

// ━━━━━━━━━━━━━━ Legacy Regex Patterns (from forge-engine.ts L394-468) ━━━━━━━━━━━━━━

/**
 * Patterns used by the original engine to determine critic clearance.
 * Preserved as fallback when structured parsing fails.
 */
const CRITIC_FAIL_PATTERNS: RegExp[] = [
  /关键问题[^]*?\n\s*\d+\.\s/m,
  /CRITICAL|严重问题/i,
  /必须解决[：:]\s*\n\s*\d+\./m,
];

/**
 * Patterns used by the original engine to determine verifier failure.
 * Preserved as fallback when structured parsing fails.
 */
const VERIFIER_FAIL_PATTERN =
  /❌|FALSE|BLOCKED|阻断|blocked by|验证失败|校验失败|check failed|test failed|未修复/i;

// ━━━━━━━━━━━━━━ JSON Extraction ━━━━━━━━━━━━━━

/**
 * Attempts to extract a JSON block from raw text output.
 * Looks for ```quality-report ... ``` or ```json ... ``` fences.
 *
 * @returns The parsed object, or null if extraction/parsing fails.
 */
function extractJsonBlock(raw: string): Record<string, unknown> | null {
  // Try quality-report fence first
  let startIdx = raw.indexOf(JSON_BLOCK_START);
  if (startIdx !== -1) {
    const contentStart = startIdx + JSON_BLOCK_START.length;
    const endIdx = raw.indexOf(JSON_BLOCK_END, contentStart);
    if (endIdx !== -1) {
      const jsonStr = raw.slice(contentStart, endIdx).trim();
      return safeJsonParse(jsonStr);
    }
  }

  // Try standard json fence
  startIdx = raw.indexOf(JSON_FENCED_START);
  if (startIdx !== -1) {
    const contentStart = startIdx + JSON_FENCED_START.length;
    const endIdx = raw.indexOf(JSON_BLOCK_END, contentStart);
    if (endIdx !== -1) {
      const jsonStr = raw.slice(contentStart, endIdx).trim();
      return safeJsonParse(jsonStr);
    }
  }

  // Try parsing the entire output as JSON (for pure-JSON responses)
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return safeJsonParse(trimmed);
  }

  return null;
}

/**
 * Safe JSON.parse wrapper that returns null on failure.
 */
function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(str);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ━━━━━━━━━━━━━━ Structured Parsing Helpers ━━━━━━━━━━━━━━

/**
 * Validates and normalizes a severity string to QualitySeverity enum.
 */
function parseSeverity(value: unknown): QualitySeverity {
  if (typeof value !== 'string') return QualitySeverity.INFO;
  const upper = value.toUpperCase();
  if (upper in QualitySeverity) return upper as QualitySeverity;
  return QualitySeverity.INFO;
}

/**
 * Validates and normalizes a category string to QualityCategory enum.
 */
function parseCategory(value: unknown): QualityCategory {
  if (typeof value !== 'string') return QualityCategory.COMPLETENESS;
  const upper = value.toUpperCase();
  if (upper in QualityCategory) return upper as QualityCategory;
  return QualityCategory.COMPLETENESS;
}

/**
 * Parses a raw JSON object into a QualityIssue array.
 * Tolerates missing/malformed fields by providing defaults.
 */
function parseIssues(raw: unknown): QualityIssue[] {
  if (!Array.isArray(raw)) return [];

  const issues: QualityIssue[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;

    issues.push({
      severity: parseSeverity(obj['severity']),
      category: parseCategory(obj['category']),
      description: typeof obj['description'] === 'string' ? obj['description'] : 'No description',
      suggestion: typeof obj['suggestion'] === 'string' ? obj['suggestion'] : '',
      location: typeof obj['location'] === 'string' ? obj['location'] : undefined,
      ruleId: typeof obj['ruleId'] === 'string' ? obj['ruleId'] : undefined,
    });
  }
  return issues;
}

/**
 * Parses a raw JSON object into DimensionScore[].
 */
function parseDimensions(raw: unknown): DimensionScore[] {
  if (!Array.isArray(raw)) return [];

  const dims: DimensionScore[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;

    dims.push({
      category: parseCategory(obj['category']),
      score: typeof obj['score'] === 'number' ? Math.max(0, Math.min(1, obj['score'])) : 0,
      weight: typeof obj['weight'] === 'number' && obj['weight'] > 0 ? obj['weight'] : 1.0,
      issues: parseIssues(obj['issues']),
    });
  }
  return dims;
}

/**
 * Attempts to parse a structured QualityReport from a raw JSON object.
 * Returns null if the object lacks the required structure.
 */
function parseStructuredReport(obj: Record<string, unknown>): QualityReport | null {
  // Must have either 'verdict' or 'pass'/'score' at top level
  const hasVerdict = typeof obj['verdict'] === 'object' && obj['verdict'] !== null;
  const hasTopLevelPass = typeof obj['pass'] === 'boolean';

  if (!hasVerdict && !hasTopLevelPass) return null;

  let verdict: QualityVerdict;
  let dimensions: DimensionScore[];

  if (hasVerdict) {
    const v = obj['verdict'] as Record<string, unknown>;
    verdict = {
      pass: typeof v['pass'] === 'boolean' ? v['pass'] : false,
      score: typeof v['score'] === 'number' ? v['score'] : 0,
      issues: parseIssues(v['issues']),
      summary: typeof v['summary'] === 'string' ? v['summary'] : '',
    };
    dimensions = parseDimensions(obj['dimensions']);
  } else {
    // Flat format: { pass, score, issues, dimensions }
    const issues = parseIssues(obj['issues']);
    dimensions = parseDimensions(obj['dimensions']);
    verdict = {
      pass: obj['pass'] as boolean,
      score: typeof obj['score'] === 'number' ? obj['score'] : 0,
      issues,
      summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    };
  }

  return {
    verdict,
    dimensions,
    timestamp: typeof obj['timestamp'] === 'string' ? obj['timestamp'] : new Date().toISOString(),
    durationMs: typeof obj['durationMs'] === 'number' ? obj['durationMs'] : 0,
    metadata: typeof obj['metadata'] === 'object' && obj['metadata'] !== null
      ? obj['metadata'] as Record<string, unknown>
      : { source: 'parsed' },
  };
}

// ━━━━━━━━━━━━━━ Legacy Regex Fallback ━━━━━━━━━━━━━━

/** Source role type for fallback parsing. */
type QualitySource = 'critic' | 'verifier';

/**
 * Builds a QualityReport from regex-based analysis of raw text.
 * This is the fallback path when structured JSON parsing fails.
 *
 * Reproduces the logic from forge-engine.ts:
 * - Critic (L394-400): checks for 关键问题, CRITICAL, 必须解决
 * - Verifier (L457-468): checks for ❌, FALSE, BLOCKED, etc.
 */
function buildFallbackReport(rawOutput: string, source: QualitySource): QualityReport {
  const trimmed = rawOutput.trim();
  const startTime = Date.now();

  // Empty output = crash/timeout = fail
  if (trimmed.length === 0) {
    return {
      verdict: {
        pass: false,
        score: 0,
        issues: [{
          severity: QualitySeverity.CRITICAL,
          category: QualityCategory.COMPLETENESS,
          description: `${source === 'critic' ? 'Critic' : 'Verifier'} produced empty output (crash/timeout).`,
          suggestion: 'Check agent logs for errors. Consider increasing timeout.',
          ruleId: 'fallback-empty',
        }],
        summary: `${source === 'critic' ? 'Critic' : 'Verifier'} output is empty — treated as failure.`,
      },
      dimensions: [{
        category: QualityCategory.COMPLETENESS,
        score: 0,
        weight: 1.0,
        issues: [],
      }],
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      metadata: { source: 'regex-fallback', role: source },
    };
  }

  let hasIssues: boolean;
  const issues: QualityIssue[] = [];

  if (source === 'critic') {
    // Reproduce forge-engine.ts L394-400 logic
    const hasCriticalSection = CRITIC_FAIL_PATTERNS[0].test(rawOutput);
    const hasCriticalMarker = CRITIC_FAIL_PATTERNS[1].test(rawOutput);
    const hasBlockingFeedback = CRITIC_FAIL_PATTERNS[2].test(rawOutput);
    hasIssues = hasCriticalSection || hasCriticalMarker || hasBlockingFeedback;

    if (hasCriticalSection) {
      issues.push({
        severity: QualitySeverity.CRITICAL,
        category: QualityCategory.COMPLETENESS,
        description: 'Critic found "关键问题" section with numbered items.',
        suggestion: 'Review and address all critical issues listed.',
        ruleId: 'fallback-critic-critical-section',
      });
    }
    if (hasCriticalMarker) {
      issues.push({
        severity: QualitySeverity.CRITICAL,
        category: QualityCategory.ACCURACY,
        description: 'Critic output contains CRITICAL/严重问题 marker.',
        suggestion: 'Review critical severity issues.',
        ruleId: 'fallback-critic-critical-marker',
      });
    }
    if (hasBlockingFeedback) {
      issues.push({
        severity: QualitySeverity.MAJOR,
        category: QualityCategory.COMPLETENESS,
        description: 'Critic output contains blocking feedback (必须解决).',
        suggestion: 'Address all mandatory fixes before proceeding.',
        ruleId: 'fallback-critic-blocking',
      });
    }
  } else {
    // Reproduce forge-engine.ts L466 logic
    hasIssues = VERIFIER_FAIL_PATTERN.test(rawOutput);

    if (hasIssues) {
      issues.push({
        severity: QualitySeverity.CRITICAL,
        category: QualityCategory.ACCURACY,
        description: 'Verifier output contains failure markers (❌/FALSE/BLOCKED/验证失败/etc).',
        suggestion: 'Review verifier report for specific failures and address them.',
        ruleId: 'fallback-verifier-fail',
      });
    }
  }

  const score = hasIssues ? 0.2 : 0.9;

  return {
    verdict: {
      pass: !hasIssues,
      score,
      issues,
      summary: hasIssues
        ? `${source === 'critic' ? 'Critic' : 'Verifier'} detected issues (regex fallback).`
        : `${source === 'critic' ? 'Critic cleared' : 'Verifier passed'} (regex fallback).`,
    },
    dimensions: [{
      category: source === 'critic' ? QualityCategory.COMPLETENESS : QualityCategory.ACCURACY,
      score,
      weight: 1.0,
      issues,
    }],
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    metadata: { source: 'regex-fallback', role: source },
  };
}

// ━━━━━━━━━━━━━━ Public API ━━━━━━━━━━━━━━

/**
 * Parses a QualityReport from raw critic/verifier text output.
 *
 * Strategy:
 * 1. Try to extract and parse a structured JSON block (```quality-report or ```json)
 * 2. If structured parsing fails, fall back to regex-based analysis
 *    (reproducing forge-engine.ts L394-468 logic)
 *
 * @param rawOutput - The raw text output from critic or verifier
 * @param source    - Whether the output came from 'critic' or 'verifier'
 * @returns A structured QualityReport
 */
export function parseQualityReport(
  rawOutput: string,
  source: QualitySource = 'critic',
): QualityReport {
  // Attempt structured JSON extraction
  const jsonObj = extractJsonBlock(rawOutput);
  if (jsonObj !== null) {
    const structured = parseStructuredReport(jsonObj);
    if (structured !== null) {
      // Tag the source for traceability
      structured.metadata['source'] = 'structured';
      structured.metadata['role'] = source;
      return structured;
    }
  }

  // Fallback to regex-based analysis
  return buildFallbackReport(rawOutput, source);
}

/**
 * Determines whether a QualityReport indicates a passing result.
 *
 * Uses the QualityGate's threshold configuration for consistent evaluation:
 * - Checks verdict.pass (from the report itself)
 * - Re-evaluates dimensions against threshold config for double-check
 * - If dimensions are empty, trusts verdict.pass directly
 *
 * @param report    - The quality report to evaluate
 * @param thresholds - Optional threshold config override (defaults to DEFAULT_THRESHOLD_CONFIG)
 * @returns true if quality is acceptable
 */
export function isQualityPassed(
  report: QualityReport,
  thresholds: QualityThresholdConfig = DEFAULT_THRESHOLD_CONFIG,
): boolean {
  // If we have dimension data, re-evaluate against thresholds for consistency
  if (report.dimensions.length > 0) {
    const reEvaluated = evaluateVerdict(report.dimensions, thresholds);
    return reEvaluated.pass;
  }

  // No dimensions (e.g., regex fallback) — trust the verdict directly
  return report.verdict.pass;
}

/**
 * Formats a QualityReport into human-readable feedback text.
 *
 * Output format:
 * ```
 * Quality Gate: PASSED ✅ (score: 85/100)
 *
 * Dimensions:
 *   COMPLETENESS: 0.90 (weight: 1.0)
 *   FORMAT: 0.80 (weight: 0.5)
 *
 * Issues (2):
 *   [MINOR/FORMAT] Output may be incomplete — Review whether all aspects...
 *   [INFO/RELEVANCE] Low keyword overlap — Ensure key aspects...
 * ```
 *
 * @param report - The quality report to format
 * @returns Human-readable multi-line string
 */
export function formatQualityFeedback(report: QualityReport): string {
  const lines: string[] = [];
  const { verdict, dimensions } = report;
  const scorePercent = Math.round(verdict.score * 100);
  const statusIcon = verdict.pass ? '✅' : '❌';

  lines.push(`Quality Gate: ${verdict.pass ? 'PASSED' : 'FAILED'} ${statusIcon} (score: ${scorePercent}/100)`);

  if (verdict.summary) {
    lines.push(`Summary: ${verdict.summary}`);
  }

  // Dimension breakdown
  if (dimensions.length > 0) {
    lines.push('');
    lines.push('Dimensions:');
    for (const dim of dimensions) {
      const dimIcon = dim.score >= 0.7 ? '✅' : dim.score >= 0.4 ? '⚠️' : '❌';
      lines.push(`  ${dimIcon} ${dim.category}: ${dim.score.toFixed(2)} (weight: ${dim.weight.toFixed(1)})`);
    }
  }

  // Issue listing
  if (verdict.issues.length > 0) {
    lines.push('');
    lines.push(`Issues (${verdict.issues.length}):`);
    for (const issue of verdict.issues) {
      const locationStr = issue.location ? ` @ ${issue.location}` : '';
      lines.push(`  [${issue.severity}/${issue.category}]${locationStr} ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`    → ${issue.suggestion}`);
      }
    }
  }

  // Source metadata
  const source = report.metadata['source'];
  if (source === 'regex-fallback') {
    lines.push('');
    lines.push('Note: Structured JSON parsing failed; result based on regex pattern matching.');
  }

  return lines.join('\n');
}

// ━━━━━━━━━━━━━━ Bridge Helpers for Engine Integration ━━━━━━━━━━━━━━

/**
 * Convenience: parse + evaluate in one call.
 * Returns { report, passed } for direct use in runCritic/runVerifier.
 *
 * @param rawOutput  - Raw text from critic/verifier
 * @param source     - 'critic' or 'verifier'
 * @param thresholds - Optional threshold config
 */
export function evaluateQualityOutput(
  rawOutput: string,
  source: QualitySource = 'critic',
  thresholds: QualityThresholdConfig = DEFAULT_THRESHOLD_CONFIG,
): { report: QualityReport; passed: boolean; feedback: string } {
  const report = parseQualityReport(rawOutput, source);
  const passed = isQualityPassed(report, thresholds);
  const feedback = formatQualityFeedback(report);
  return { report, passed, feedback };
}

/**
 * Creates a CriticResult-compatible object from raw critic output.
 * Can be used as a drop-in replacement in forge-engine.ts runCritic().
 *
 * Replaces:
 *   iter.criticCleared = !(hasCriticalSection || hasCriticalMarker || hasBlockingFeedback)
 * With:
 *   const result = bridgeCriticResult(criticOutput);
 *   iter.criticCleared = result.cleared;
 */
export function bridgeCriticResult(
  rawOutput: string,
  thresholds?: QualityThresholdConfig,
): { cleared: boolean; report: QualityReport; feedback: string } {
  const { report, passed, feedback } = evaluateQualityOutput(rawOutput, 'critic', thresholds);
  return { cleared: passed, report, feedback };
}

/**
 * Creates a VerifierResult-compatible object from raw verifier output.
 * Can be used as a drop-in replacement in forge-engine.ts runVerifier().
 *
 * Replaces:
 *   hasVerifierIssues = /❌|FALSE|BLOCKED|.../.test(verifierOutput);
 *   iter.verifierPassed = !hasVerifierIssues;
 * With:
 *   const result = bridgeVerifierResult(verifierOutput);
 *   iter.verifierPassed = result.passed;
 */
export function bridgeVerifierResult(
  rawOutput: string,
  thresholds?: QualityThresholdConfig,
): { passed: boolean; report: QualityReport; summary: string } {
  const { report, passed, feedback } = evaluateQualityOutput(rawOutput, 'verifier', thresholds);
  return { passed, report, summary: feedback };
}
