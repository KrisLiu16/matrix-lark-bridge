/**
 * Unit tests for forge-quality-bridge.ts
 *
 * Covers all 6 exported functions:
 *   parseQualityReport, isQualityPassed, formatQualityFeedback,
 *   evaluateQualityOutput, bridgeCriticResult, bridgeVerifierResult
 *
 * @module forge-quality-bridge.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseQualityReport,
  isQualityPassed,
  formatQualityFeedback,
  evaluateQualityOutput,
  bridgeCriticResult,
  bridgeVerifierResult,
} from '../forge-quality-bridge';

import {
  type QualityReport,
  type QualityThresholdConfig,
  QualitySeverity,
  QualityCategory,
  DEFAULT_THRESHOLD_CONFIG,
  createEmptyReport,
} from '../types/quality';

// ━━━━━━━━━━━━━━ Helpers ━━━━━━━━━━━━━━

/** Wraps content in a ```quality-report fence. */
function wrapQualityFence(json: string): string {
  return `Some preamble text\n\`\`\`quality-report\n${json}\n\`\`\`\nSome trailing text`;
}

/** Wraps content in a ```json fence. */
function wrapJsonFence(json: string): string {
  return `Some preamble text\n\`\`\`json\n${json}\n\`\`\`\nSome trailing text`;
}

/** Builds a minimal valid structured report JSON. */
function makeStructuredJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: {
      pass: true,
      score: 0.85,
      issues: [],
      summary: 'All good',
    },
    dimensions: [
      { category: 'COMPLETENESS', score: 0.9, weight: 1.0, issues: [] },
    ],
    timestamp: '2026-03-23T00:00:00Z',
    durationMs: 100,
    metadata: { model: 'test' },
    ...overrides,
  });
}

/** Builds a flat-format structured report JSON (pass at top level). */
function makeFlatJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pass: true,
    score: 0.8,
    issues: [],
    summary: 'Flat format OK',
    dimensions: [],
    ...overrides,
  });
}

// ━━━━━━━━━━━━━━ parseQualityReport ━━━━━━━━━━━━━━

describe('parseQualityReport', () => {
  describe('structured JSON path — quality-report fence', () => {
    it('parses a valid quality-report fenced block', () => {
      const raw = wrapQualityFence(makeStructuredJson());
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(true);
      expect(report.verdict.score).toBe(0.85);
      expect(report.verdict.summary).toBe('All good');
      expect(report.dimensions).toHaveLength(1);
      expect(report.dimensions[0].category).toBe('COMPLETENESS');
      expect(report.metadata['source']).toBe('structured');
      expect(report.metadata['role']).toBe('critic');
    });

    it('parses issues with full fields', () => {
      const json = makeStructuredJson({
        verdict: {
          pass: false,
          score: 0.3,
          issues: [
            {
              severity: 'CRITICAL',
              category: 'ACCURACY',
              description: 'Wrong answer',
              suggestion: 'Fix it',
              location: 'file.ts:10',
              ruleId: 'acc-001',
            },
          ],
          summary: 'Failed check',
        },
      });
      const report = parseQualityReport(wrapQualityFence(json), 'verifier');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues).toHaveLength(1);
      expect(report.verdict.issues[0].severity).toBe(QualitySeverity.CRITICAL);
      expect(report.verdict.issues[0].location).toBe('file.ts:10');
      expect(report.verdict.issues[0].ruleId).toBe('acc-001');
      expect(report.metadata['role']).toBe('verifier');
    });

    it('normalizes unknown severity to INFO', () => {
      const json = makeStructuredJson({
        verdict: {
          pass: true,
          score: 0.9,
          issues: [
            { severity: 'UNKNOWN_SEV', category: 'FORMAT', description: 'test', suggestion: '' },
          ],
          summary: '',
        },
      });
      const report = parseQualityReport(wrapQualityFence(json));

      expect(report.verdict.issues[0].severity).toBe(QualitySeverity.INFO);
    });

    it('normalizes unknown category to COMPLETENESS', () => {
      const json = makeStructuredJson({
        verdict: {
          pass: true,
          score: 0.9,
          issues: [
            { severity: 'MINOR', category: 'NONEXISTENT', description: 'test', suggestion: '' },
          ],
          summary: '',
        },
      });
      const report = parseQualityReport(wrapQualityFence(json));

      expect(report.verdict.issues[0].category).toBe(QualityCategory.COMPLETENESS);
    });

    it('clamps dimension score to [0, 1]', () => {
      const json = makeStructuredJson({
        dimensions: [
          { category: 'ACCURACY', score: 1.5, weight: 1.0, issues: [] },
          { category: 'FORMAT', score: -0.3, weight: 1.0, issues: [] },
        ],
      });
      const report = parseQualityReport(wrapQualityFence(json));

      expect(report.dimensions[0].score).toBe(1);
      expect(report.dimensions[1].score).toBe(0);
    });

    it('defaults weight to 1.0 when missing or invalid', () => {
      const json = makeStructuredJson({
        dimensions: [
          { category: 'ACCURACY', score: 0.8, issues: [] },
          { category: 'FORMAT', score: 0.7, weight: -1, issues: [] },
        ],
      });
      const report = parseQualityReport(wrapQualityFence(json));

      expect(report.dimensions[0].weight).toBe(1.0);
      expect(report.dimensions[1].weight).toBe(1.0);
    });
  });

  describe('structured JSON path — json fence', () => {
    it('parses a valid json-fenced block', () => {
      const raw = wrapJsonFence(makeStructuredJson());
      const report = parseQualityReport(raw, 'verifier');

      expect(report.verdict.pass).toBe(true);
      expect(report.metadata['source']).toBe('structured');
      expect(report.metadata['role']).toBe('verifier');
    });
  });

  describe('structured JSON path — bare JSON', () => {
    it('parses a pure JSON response (no fence)', () => {
      const raw = makeStructuredJson();
      const report = parseQualityReport(raw);

      expect(report.verdict.pass).toBe(true);
      expect(report.metadata['source']).toBe('structured');
    });

    it('does not parse bare JSON that is not an object', () => {
      const report = parseQualityReport('[1,2,3]', 'critic');
      // Should fall back to regex
      expect(report.metadata['source']).toBe('regex-fallback');
    });
  });

  describe('structured JSON path — flat format', () => {
    it('parses flat format with pass at top level', () => {
      const raw = wrapQualityFence(makeFlatJson());
      const report = parseQualityReport(raw);

      expect(report.verdict.pass).toBe(true);
      expect(report.verdict.score).toBe(0.8);
      expect(report.verdict.summary).toBe('Flat format OK');
    });

    it('flat format without verdict object still works', () => {
      const raw = wrapQualityFence(makeFlatJson({ pass: false, score: 0.2 }));
      const report = parseQualityReport(raw);

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.score).toBe(0.2);
    });
  });

  describe('structured JSON path — malformed', () => {
    it('falls back when JSON has no verdict or pass field', () => {
      const json = JSON.stringify({ foo: 'bar', score: 0.5 });
      const report = parseQualityReport(wrapQualityFence(json));

      expect(report.metadata['source']).toBe('regex-fallback');
    });

    it('falls back when JSON is syntactically invalid', () => {
      const raw = '```quality-report\n{invalid json}\n```';
      const report = parseQualityReport(raw, 'critic');

      expect(report.metadata['source']).toBe('regex-fallback');
    });

    it('falls back when fence is unclosed', () => {
      const raw = '```quality-report\n' + makeStructuredJson();
      // No closing ```, so extractJsonBlock returns null
      const report = parseQualityReport(raw);

      expect(report.metadata['source']).toBe('regex-fallback');
    });
  });

  describe('regex fallback — critic', () => {
    it('detects 关键问题 section pattern', () => {
      const raw = '评审结果：\n关键问题\n\n1. 缺少错误处理';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.score).toBe(0.2);
      expect(report.metadata['source']).toBe('regex-fallback');
      expect(report.verdict.issues.some(i => i.ruleId === 'fallback-critic-critical-section')).toBe(true);
    });

    it('detects CRITICAL marker', () => {
      const raw = 'Found CRITICAL issue in the implementation.';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues.some(i => i.ruleId === 'fallback-critic-critical-marker')).toBe(true);
    });

    it('detects 严重问题 marker (case insensitive)', () => {
      const raw = '存在严重问题需要修复。';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(false);
    });

    it('detects 必须解决 blocking feedback pattern', () => {
      const raw = '以下为必须解决：\n1. 修复类型错误';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues.some(i => i.ruleId === 'fallback-critic-blocking')).toBe(true);
    });

    it('passes when no critic fail patterns match', () => {
      const raw = '代码质量良好，没有发现明显问题。建议继续保持。';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(true);
      expect(report.verdict.score).toBe(0.9);
      expect(report.verdict.summary).toContain('Critic cleared');
    });

    it('accumulates multiple matched patterns', () => {
      const raw = '关键问题\n\n1. 缺少错误处理\n\nCRITICAL bug found\n\n必须解决：\n1. 修复安全漏洞';
      const report = parseQualityReport(raw, 'critic');

      expect(report.verdict.pass).toBe(false);
      // Should have all three issue types
      expect(report.verdict.issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('regex fallback — verifier', () => {
    it('detects ❌ marker', () => {
      const raw = '验证结果：❌ 测试未通过';
      const report = parseQualityReport(raw, 'verifier');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues.some(i => i.ruleId === 'fallback-verifier-fail')).toBe(true);
    });

    it('detects FALSE marker', () => {
      const report = parseQualityReport('Result: FALSE', 'verifier');
      expect(report.verdict.pass).toBe(false);
    });

    it('detects BLOCKED marker', () => {
      const report = parseQualityReport('blocked by dependency issue', 'verifier');
      expect(report.verdict.pass).toBe(false);
    });

    it('detects 验证失败 marker', () => {
      const report = parseQualityReport('验证失败：类型不匹配', 'verifier');
      expect(report.verdict.pass).toBe(false);
    });

    it('detects 未修复 marker', () => {
      const report = parseQualityReport('Bug 未修复', 'verifier');
      expect(report.verdict.pass).toBe(false);
    });

    it('detects test failed marker', () => {
      const report = parseQualityReport('3 test failed in suite', 'verifier');
      expect(report.verdict.pass).toBe(false);
    });

    it('passes when no verifier fail patterns match', () => {
      const raw = '所有测试通过，代码验证完成。';
      const report = parseQualityReport(raw, 'verifier');

      expect(report.verdict.pass).toBe(true);
      expect(report.verdict.score).toBe(0.9);
      expect(report.verdict.summary).toContain('Verifier passed');
    });

    it('sets dimension category to ACCURACY for verifier', () => {
      const report = parseQualityReport('all checks passed', 'verifier');
      expect(report.dimensions[0].category).toBe(QualityCategory.ACCURACY);
    });

    it('sets dimension category to COMPLETENESS for critic', () => {
      const report = parseQualityReport('looks good', 'critic');
      expect(report.dimensions[0].category).toBe(QualityCategory.COMPLETENESS);
    });
  });

  describe('empty output = failure', () => {
    it('treats empty string as failure for critic', () => {
      const report = parseQualityReport('', 'critic');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.score).toBe(0);
      expect(report.verdict.issues).toHaveLength(1);
      expect(report.verdict.issues[0].severity).toBe(QualitySeverity.CRITICAL);
      expect(report.verdict.issues[0].ruleId).toBe('fallback-empty');
      expect(report.verdict.summary).toContain('Critic');
      expect(report.verdict.summary).toContain('empty');
    });

    it('treats empty string as failure for verifier', () => {
      const report = parseQualityReport('', 'verifier');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues[0].description).toContain('Verifier');
    });

    it('treats whitespace-only string as failure', () => {
      const report = parseQualityReport('   \n\t  \n  ', 'critic');

      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.issues[0].ruleId).toBe('fallback-empty');
    });
  });

  describe('defaults', () => {
    it('defaults source to critic when not specified', () => {
      const report = parseQualityReport('CRITICAL issue found');
      expect(report.metadata['role']).toBe('critic');
    });
  });
});

// ━━━━━━━━━━━━━━ isQualityPassed ━━━━━━━━━━━━━━

describe('isQualityPassed', () => {
  it('returns true for a passing verdict with no dimensions', () => {
    const report = createEmptyReport();
    expect(isQualityPassed(report)).toBe(true);
  });

  it('returns false for a failing verdict with no dimensions', () => {
    const report = createEmptyReport();
    report.verdict.pass = false;
    expect(isQualityPassed(report)).toBe(false);
  });

  it('re-evaluates dimensions against default thresholds when present', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.9, issues: [], summary: '' },
      dimensions: [
        { category: QualityCategory.COMPLETENESS, score: 0.5, weight: 1.0, issues: [] },
      ],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    // COMPLETENESS blocking threshold is 0.7, score 0.5 < 0.7 → should fail
    expect(isQualityPassed(report)).toBe(false);
  });

  it('passes when all dimensions meet thresholds', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.9, issues: [], summary: '' },
      dimensions: [
        { category: QualityCategory.COMPLETENESS, score: 0.9, weight: 1.0, issues: [] },
        { category: QualityCategory.ACCURACY, score: 0.85, weight: 1.0, issues: [] },
      ],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    expect(isQualityPassed(report)).toBe(true);
  });

  it('respects custom threshold config', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.5, issues: [], summary: '' },
      dimensions: [
        { category: QualityCategory.COMPLETENESS, score: 0.5, weight: 1.0, issues: [] },
      ],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };

    const lenientConfig: QualityThresholdConfig = {
      thresholds: [
        { category: QualityCategory.COMPLETENESS, minScore: 0.3, weight: 1.0, blocking: true },
      ],
      minAggregateScore: 0.3,
      maxCriticalIssues: 5,
      maxMajorIssues: 10,
    };

    expect(isQualityPassed(report, lenientConfig)).toBe(true);
  });

  it('fails when critical issue count exceeds max', () => {
    const criticalIssue = {
      severity: QualitySeverity.CRITICAL,
      category: QualityCategory.ACCURACY,
      description: 'critical',
      suggestion: '',
    };
    const report: QualityReport = {
      verdict: { pass: true, score: 0.9, issues: [criticalIssue], summary: '' },
      dimensions: [
        {
          category: QualityCategory.ACCURACY,
          score: 0.9,
          weight: 1.0,
          issues: [criticalIssue],
        },
      ],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    // DEFAULT_THRESHOLD_CONFIG.maxCriticalIssues = 0, we have 1
    expect(isQualityPassed(report)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━ formatQualityFeedback ━━━━━━━━━━━━━━

describe('formatQualityFeedback', () => {
  it('formats a passing report', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.85, issues: [], summary: 'All good' },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: { source: 'structured' },
    };
    const text = formatQualityFeedback(report);

    expect(text).toContain('Quality Gate: PASSED ✅');
    expect(text).toContain('(score: 85/100)');
    expect(text).toContain('Summary: All good');
    expect(text).not.toContain('Issues');
    expect(text).not.toContain('regex');
  });

  it('formats a failing report', () => {
    const report: QualityReport = {
      verdict: { pass: false, score: 0.3, issues: [], summary: 'Bad' },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: { source: 'structured' },
    };
    const text = formatQualityFeedback(report);

    expect(text).toContain('Quality Gate: FAILED ❌');
    expect(text).toContain('(score: 30/100)');
  });

  it('includes dimension breakdown', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.85, issues: [], summary: '' },
      dimensions: [
        { category: QualityCategory.COMPLETENESS, score: 0.9, weight: 1.0, issues: [] },
        { category: QualityCategory.FORMAT, score: 0.5, weight: 0.5, issues: [] },
        { category: QualityCategory.SAFETY, score: 0.3, weight: 1.0, issues: [] },
      ],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    const text = formatQualityFeedback(report);

    expect(text).toContain('Dimensions:');
    expect(text).toContain('COMPLETENESS: 0.90');
    expect(text).toContain('FORMAT: 0.50');
    expect(text).toContain('SAFETY: 0.30');
    // Icons: >=0.7 → ✅, >=0.4 → ⚠️, <0.4 → ❌
    expect(text).toContain('✅ COMPLETENESS');
    expect(text).toContain('⚠️ FORMAT');
    expect(text).toContain('❌ SAFETY');
  });

  it('lists issues with severity, category, description, suggestion', () => {
    const report: QualityReport = {
      verdict: {
        pass: false,
        score: 0.3,
        issues: [
          {
            severity: QualitySeverity.CRITICAL,
            category: QualityCategory.ACCURACY,
            description: 'Wrong answer',
            suggestion: 'Fix the logic',
            location: 'engine.ts:42',
          },
          {
            severity: QualitySeverity.MINOR,
            category: QualityCategory.FORMAT,
            description: 'Bad indent',
            suggestion: '',
          },
        ],
        summary: '',
      },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    const text = formatQualityFeedback(report);

    expect(text).toContain('Issues (2):');
    expect(text).toContain('[CRITICAL/ACCURACY] @ engine.ts:42 Wrong answer');
    expect(text).toContain('→ Fix the logic');
    expect(text).toContain('[MINOR/FORMAT] Bad indent');
  });

  it('does not show suggestion line when suggestion is empty', () => {
    const report: QualityReport = {
      verdict: {
        pass: true,
        score: 0.8,
        issues: [
          {
            severity: QualitySeverity.INFO,
            category: QualityCategory.RELEVANCE,
            description: 'Note',
            suggestion: '',
          },
        ],
        summary: '',
      },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    const text = formatQualityFeedback(report);
    const lines = text.split('\n');
    // Should not have a "→" line for empty suggestion
    const noteLineIdx = lines.findIndex(l => l.includes('[INFO/RELEVANCE] Note'));
    expect(noteLineIdx).toBeGreaterThan(-1);
    // The next line should NOT start with →
    if (noteLineIdx < lines.length - 1) {
      expect(lines[noteLineIdx + 1]).not.toContain('→');
    }
  });

  it('adds regex fallback note when source is regex-fallback', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.9, issues: [], summary: '' },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: { source: 'regex-fallback' },
    };
    const text = formatQualityFeedback(report);

    expect(text).toContain('regex pattern matching');
  });

  it('omits summary line when summary is empty', () => {
    const report: QualityReport = {
      verdict: { pass: true, score: 0.9, issues: [], summary: '' },
      dimensions: [],
      timestamp: new Date().toISOString(),
      durationMs: 0,
      metadata: {},
    };
    const text = formatQualityFeedback(report);

    expect(text).not.toContain('Summary:');
  });
});

// ━━━━━━━━━━━━━━ evaluateQualityOutput ━━━━━━━━━━━━━━

describe('evaluateQualityOutput', () => {
  it('returns report, passed, and feedback for a structured passing output', () => {
    const raw = wrapQualityFence(makeStructuredJson());
    const result = evaluateQualityOutput(raw, 'critic');

    expect(result.report).toBeDefined();
    expect(result.report.verdict.pass).toBe(true);
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.feedback).toBe('string');
    expect(result.feedback).toContain('PASSED');
  });

  it('returns failing result for empty output', () => {
    const result = evaluateQualityOutput('', 'verifier');

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('FAILED');
  });

  it('uses regex fallback for plain text with fail markers', () => {
    const result = evaluateQualityOutput('CRITICAL bug found', 'critic');

    expect(result.passed).toBe(false);
    expect(result.report.metadata['source']).toBe('regex-fallback');
  });

  it('respects custom thresholds', () => {
    // Structured report with COMPLETENESS dimension score 0.5
    const json = makeStructuredJson({
      dimensions: [
        { category: 'COMPLETENESS', score: 0.5, weight: 1.0, issues: [] },
      ],
    });

    // With default thresholds: COMPLETENESS min 0.7, blocking → fails
    const resultStrict = evaluateQualityOutput(wrapQualityFence(json), 'critic');
    expect(resultStrict.passed).toBe(false);

    // With lenient thresholds → passes
    const lenient: QualityThresholdConfig = {
      thresholds: [
        { category: QualityCategory.COMPLETENESS, minScore: 0.3, weight: 1.0, blocking: true },
      ],
      minAggregateScore: 0.3,
      maxCriticalIssues: 5,
      maxMajorIssues: 10,
    };
    const resultLenient = evaluateQualityOutput(wrapQualityFence(json), 'critic', lenient);
    expect(resultLenient.passed).toBe(true);
  });

  it('defaults source to critic', () => {
    const result = evaluateQualityOutput('all good');
    expect(result.report.metadata['role']).toBe('critic');
  });
});

// ━━━━━━━━━━━━━━ bridgeCriticResult ━━━━━━━━━━━━━━

describe('bridgeCriticResult', () => {
  it('returns CriticResult-compatible shape', () => {
    const result = bridgeCriticResult('No issues found.');

    expect(result).toHaveProperty('cleared');
    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('feedback');
    expect(typeof result.cleared).toBe('boolean');
    expect(typeof result.feedback).toBe('string');
  });

  it('cleared=true when no critic fail patterns match', () => {
    const result = bridgeCriticResult('代码质量良好，无问题。');

    expect(result.cleared).toBe(true);
  });

  it('cleared=false when CRITICAL marker present', () => {
    const result = bridgeCriticResult('Found CRITICAL issue');

    expect(result.cleared).toBe(false);
  });

  it('cleared=false when 关键问题 section present', () => {
    const result = bridgeCriticResult('关键问题\n\n1. 缺少输入验证');

    expect(result.cleared).toBe(false);
  });

  it('cleared=false for empty output', () => {
    const result = bridgeCriticResult('');

    expect(result.cleared).toBe(false);
    expect(result.feedback).toContain('FAILED');
  });

  it('uses structured JSON when available', () => {
    const json = makeStructuredJson({
      verdict: { pass: true, score: 0.9, issues: [], summary: 'Fine' },
    });
    const result = bridgeCriticResult(wrapQualityFence(json));

    expect(result.cleared).toBe(true);
    expect(result.report.metadata['source']).toBe('structured');
  });

  it('respects custom thresholds', () => {
    const json = makeStructuredJson({
      dimensions: [
        { category: 'COMPLETENESS', score: 0.5, weight: 1.0, issues: [] },
      ],
    });

    const strictResult = bridgeCriticResult(wrapQualityFence(json));
    expect(strictResult.cleared).toBe(false);

    const lenient: QualityThresholdConfig = {
      thresholds: [],
      minAggregateScore: 0.3,
      maxCriticalIssues: 5,
      maxMajorIssues: 10,
    };
    const lenientResult = bridgeCriticResult(wrapQualityFence(json), lenient);
    expect(lenientResult.cleared).toBe(true);
  });

  it('feedback contains quality gate status', () => {
    const result = bridgeCriticResult('good output');

    expect(result.feedback).toContain('Quality Gate:');
  });
});

// ━━━━━━━━━━━━━━ bridgeVerifierResult ━━━━━━━━━━━━━━

describe('bridgeVerifierResult', () => {
  it('returns VerifierResult-compatible shape', () => {
    const result = bridgeVerifierResult('All tests passed.');

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('summary');
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.summary).toBe('string');
  });

  it('passed=true when no verifier fail patterns match', () => {
    const result = bridgeVerifierResult('验证通过，所有检查项都已确认。');

    expect(result.passed).toBe(true);
  });

  it('passed=false when ❌ marker present', () => {
    const result = bridgeVerifierResult('❌ 3 checks failed');

    expect(result.passed).toBe(false);
  });

  it('passed=false when BLOCKED marker present', () => {
    const result = bridgeVerifierResult('blocked by critical dependency');

    expect(result.passed).toBe(false);
  });

  it('passed=false when 校验失败 present', () => {
    const result = bridgeVerifierResult('类型校验失败');

    expect(result.passed).toBe(false);
  });

  it('passed=false for empty output', () => {
    const result = bridgeVerifierResult('');

    expect(result.passed).toBe(false);
    expect(result.summary).toContain('FAILED');
  });

  it('uses structured JSON when available', () => {
    const json = makeStructuredJson({
      verdict: { pass: false, score: 0.2, issues: [], summary: 'Failed' },
      dimensions: [],
    });
    const result = bridgeVerifierResult(wrapQualityFence(json));

    // Structured report: pass=false, no dimensions → trusts verdict.pass
    expect(result.passed).toBe(false);
    expect(result.report.metadata['source']).toBe('structured');
  });

  it('respects custom thresholds', () => {
    const json = makeStructuredJson({
      dimensions: [
        { category: 'ACCURACY', score: 0.75, weight: 1.0, issues: [] },
      ],
    });

    // Default ACCURACY threshold is 0.8 blocking → fails
    const strictResult = bridgeVerifierResult(wrapQualityFence(json));
    expect(strictResult.passed).toBe(false);

    const lenient: QualityThresholdConfig = {
      thresholds: [
        { category: QualityCategory.ACCURACY, minScore: 0.5, weight: 1.0, blocking: true },
      ],
      minAggregateScore: 0.3,
      maxCriticalIssues: 5,
      maxMajorIssues: 10,
    };
    const lenientResult = bridgeVerifierResult(wrapQualityFence(json), lenient);
    expect(lenientResult.passed).toBe(true);
  });

  it('summary contains quality gate status', () => {
    const result = bridgeVerifierResult('all passed');

    expect(result.summary).toContain('Quality Gate:');
  });
});

// ━━━━━━━━━━━━━━ Edge cases ━━━━━━━━━━━━━━

describe('edge cases', () => {
  it('handles very long output without crashing', () => {
    const longText = 'A'.repeat(100_000);
    const report = parseQualityReport(longText, 'critic');
    expect(report).toBeDefined();
    expect(report.verdict).toBeDefined();
  });

  it('handles output with multiple JSON blocks — uses first one', () => {
    const json1 = makeStructuredJson({ verdict: { pass: true, score: 0.9, issues: [], summary: 'First' } });
    const json2 = makeStructuredJson({ verdict: { pass: false, score: 0.1, issues: [], summary: 'Second' } });
    const raw = `\`\`\`quality-report\n${json1}\n\`\`\`\nMore text\n\`\`\`quality-report\n${json2}\n\`\`\``;
    const report = parseQualityReport(raw);

    expect(report.verdict.summary).toBe('First');
  });

  it('handles non-array issues in structured JSON gracefully', () => {
    const json = makeStructuredJson({
      verdict: { pass: true, score: 0.9, issues: 'not an array', summary: '' },
    });
    const report = parseQualityReport(wrapQualityFence(json));
    expect(report.verdict.issues).toEqual([]);
  });

  it('handles non-array dimensions gracefully', () => {
    const json = makeStructuredJson({
      dimensions: 'invalid',
    });
    const report = parseQualityReport(wrapQualityFence(json));
    expect(report.dimensions).toEqual([]);
  });

  it('handles missing optional fields with defaults', () => {
    const json = JSON.stringify({
      verdict: { pass: true },
    });
    const report = parseQualityReport(wrapQualityFence(json));

    expect(report.verdict.pass).toBe(true);
    expect(report.verdict.score).toBe(0);
    expect(report.verdict.issues).toEqual([]);
    expect(report.verdict.summary).toBe('');
    expect(report.dimensions).toEqual([]);
    expect(report.durationMs).toBe(0);
  });

  it('issue with missing description gets default', () => {
    const json = makeStructuredJson({
      verdict: {
        pass: true,
        score: 0.9,
        issues: [{ severity: 'MINOR', category: 'FORMAT' }],
        summary: '',
      },
    });
    const report = parseQualityReport(wrapQualityFence(json));

    expect(report.verdict.issues[0].description).toBe('No description');
    expect(report.verdict.issues[0].suggestion).toBe('');
  });

  it('skips non-object items in issues array', () => {
    const json = makeStructuredJson({
      verdict: {
        pass: true,
        score: 0.9,
        issues: [null, 42, 'string', { severity: 'INFO', category: 'FORMAT', description: 'ok', suggestion: '' }],
        summary: '',
      },
    });
    const report = parseQualityReport(wrapQualityFence(json));

    expect(report.verdict.issues).toHaveLength(1);
    expect(report.verdict.issues[0].description).toBe('ok');
  });

  it('skips non-object items in dimensions array', () => {
    const json = makeStructuredJson({
      dimensions: [null, 'bad', { category: 'FORMAT', score: 0.5, weight: 1.0, issues: [] }],
    });
    const report = parseQualityReport(wrapQualityFence(json));

    expect(report.dimensions).toHaveLength(1);
  });
});
