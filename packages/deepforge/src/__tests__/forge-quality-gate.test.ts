/**
 * QualityGateMiddleware — Unit Tests
 *
 * Covers: built-in check functions (completeness/format/relevance),
 * weighted scoring, threshold verdict, retry count, custom checks,
 * shouldRun phase filtering, blockOnFail behavior, factory.
 *
 * @module __tests__/forge-quality-gate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  QualityGateMiddleware,
  createQualityGateMiddleware,
  DEFAULT_QUALITY_RULES,
  QUALITY_GATE_STATE_KEY,
  QUALITY_GATE_RETRY_KEY,
} from '../forge-quality-gate';

import {
  QualitySeverity,
  QualityCategory,
  DEFAULT_THRESHOLD_CONFIG,
  evaluateVerdict,
  createEmptyVerdict,
  createEmptyReport,
  type QualityCheckFn,
  type QualityReport,
  type DimensionScore,
  type QualityGateConfig,
} from '../types/quality';

import type {
  MiddlewareContext,
  MiddlewareNext,
} from '../types/middleware';

// ━━━━━━━━━━━━━━ Helpers ━━━━━━━━━━━━━━

/** Creates a minimal MiddlewareContext for testing. */
function makeCtx(overrides?: {
  messages?: Array<{ role: string; content: string }>;
  phase?: string;
  state?: Record<string, unknown>;
  iteration?: number;
}): MiddlewareContext {
  return {
    messages: (overrides?.messages as any) ?? [],
    config: {
      projectId: 'test-project',
      model: 'test-model',
      effort: 'medium',
      maxConcurrent: 3,
      phase: (overrides?.phase as any) ?? 'critiquing',
    },
    iteration: overrides?.iteration != null
      ? { number: overrides.iteration, taskCount: 1, completedCount: 0, failedCount: 0 }
      : undefined,
    state: overrides?.state ?? {},
    metadata: {
      runId: 'run-test',
      chain: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
  };
}

/** Creates a next() that returns the given context (simulating downstream). */
function makeNext(ctx: MiddlewareContext): MiddlewareNext {
  return async () => ctx;
}

// ━━━━━━━━━━━━━━ Tests ━━━━━━━━━━━━━━

describe('QualityGateMiddleware', () => {
  // ── Constructor & Defaults ──

  describe('constructor defaults', () => {
    it('uses DEFAULT_QUALITY_RULES when no rules provided', () => {
      const mw = new QualityGateMiddleware();
      expect(mw.name).toBe('quality-gate');
      expect(mw.priority).toBe(110);
      expect(mw.enabled).toBe(true);
      expect(mw.continueOnError).toBe(false);
    });

    it('accepts custom config overrides', () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: false,
        maxRetries: 5,
      });
      // blockOnFail and maxRetries are private, test via behavior later
      expect(mw.enabled).toBe(true);
    });
  });

  // ── shouldRun — Phase Filtering ──

  describe('shouldRun', () => {
    it('returns true for critiquing phase', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'critiquing' });
      expect(mw.shouldRun(ctx)).toBe(true);
    });

    it('returns true for verifying phase', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'verifying' });
      expect(mw.shouldRun(ctx)).toBe(true);
    });

    it('returns true for completing phase', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'completing' });
      expect(mw.shouldRun(ctx)).toBe(true);
    });

    it('returns false for executing phase', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'executing' });
      expect(mw.shouldRun(ctx)).toBe(false);
    });

    it('returns false for planning phase', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'planning' });
      expect(mw.shouldRun(ctx)).toBe(false);
    });

    it('returns true when forceRun state flag is set', () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({ phase: 'executing', state: { 'quality-gate:forceRun': true } });
      expect(mw.shouldRun(ctx)).toBe(true);
    });
  });

  // ── Built-in Check: Completeness ──

  describe('completeness check', () => {
    const mw = new QualityGateMiddleware({
      rules: [{ id: 'completeness', label: 'Completeness', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.5 },
    });

    it('passes for substantive output (>= 200 chars)', async () => {
      const output = 'A'.repeat(250);
      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'Do something' },
          { role: 'assistant', content: output },
        ],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.verdict.pass).toBe(true);
      expect(report.dimensions[0].score).toBe(1.0);
    });

    it('scores 0.7 for short output (50-199 chars)', async () => {
      const output = 'B'.repeat(100);
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: output }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0.7);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.MINOR);
    });

    it('scores 0.3 for very short output (1-49 chars)', async () => {
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'Hi' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0.3);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.MAJOR);
    });

    it('scores 0 for empty output', async () => {
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: '   ' }],
      });
      // empty trimmed output → extractOutput returns '   ' which trims to '', but
      // the middleware checks output.length === 0 after extractOutput — let's verify
      const result = await mw.execute(ctx, makeNext(ctx));
      // extractOutput returns '   ' (not trimmed), so output.length > 0 → check runs
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.CRITICAL);
    });
  });

  // ── Built-in Check: Format (repetition detection) ──

  describe('format check', () => {
    const mw = new QualityGateMiddleware({
      rules: [{ id: 'format', label: 'Format', category: QualityCategory.FORMAT, threshold: 0.5, weight: 0.5, blocking: false }],
      thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.1 },
    });

    it('passes for non-repetitive output', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}: unique content here`);
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: lines.join('\n') }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(1.0);
      expect(report.dimensions[0].issues).toHaveLength(0);
    });

    it('scores low for highly repetitive output (< 30% unique)', async () => {
      const lines = Array(20).fill('same line repeated over and over');
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: lines.join('\n') }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0.2);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.MAJOR);
    });

    it('scores 0.6 for moderately repetitive output (30-50% unique)', async () => {
      // 3 unique lines out of 8 non-empty = 37.5% unique
      const lines = [
        'line A', 'line B', 'line C',
        'line A', 'line B',
        'line A', 'line B',
        'line A',
      ];
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: lines.join('\n') }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0.6);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.MINOR);
    });
  });

  // ── Built-in Check: Relevance ──

  describe('relevance check', () => {
    const mw = new QualityGateMiddleware({
      rules: [{ id: 'relevance', label: 'Relevance', category: QualityCategory.RELEVANCE, threshold: 0.6, weight: 0.8, blocking: false }],
      thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.1 },
    });

    it('passes when output contains task keywords', async () => {
      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'implement authentication system with token validation' },
          { role: 'assistant', content: 'Here is the authentication implementation with token validation logic that handles all edge cases' },
        ],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBeGreaterThanOrEqual(0.5);
    });

    it('scores low when output is unrelated to task', async () => {
      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'implement authentication system with token validation' },
          { role: 'assistant', content: 'The weather today is sunny and warm across the region with high temperatures.' },
        ],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBeLessThanOrEqual(0.5);
    });

    it('returns score 1.0 when no task description available', async () => {
      const ctx = makeCtx({
        messages: [
          { role: 'assistant', content: 'Some output without a user message' },
        ],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      // No user message → taskDescription = '' → no significant words → score 1.0
      expect(report.dimensions[0].score).toBe(1.0);
    });
  });

  // ── Weighted Scoring & Aggregate Verdict ──

  describe('weighted scoring', () => {
    it('computes weighted average across dimensions', () => {
      const dims: DimensionScore[] = [
        { category: QualityCategory.COMPLETENESS, score: 1.0, weight: 1.0, issues: [] },
        { category: QualityCategory.FORMAT, score: 0.5, weight: 0.5, issues: [] },
        { category: QualityCategory.RELEVANCE, score: 0.8, weight: 0.8, issues: [] },
      ];
      // weighted = (1.0*1.0 + 0.5*0.5 + 0.8*0.8) / (1.0+0.5+0.8)
      //          = (1.0 + 0.25 + 0.64) / 2.3 = 1.89 / 2.3 ≈ 0.8217
      const verdict = evaluateVerdict(dims, DEFAULT_THRESHOLD_CONFIG);
      expect(verdict.score).toBeCloseTo(1.89 / 2.3, 4);
      expect(verdict.pass).toBe(true);
    });

    it('fails when aggregate score below minAggregateScore', () => {
      // Use non-blocking thresholds so the per-category blocking check
      // does not fire before the aggregate score check.
      const nonBlockingThresholds = DEFAULT_THRESHOLD_CONFIG.thresholds.map(t => ({
        ...t,
        blocking: false,
      }));
      const dims: DimensionScore[] = [
        { category: QualityCategory.COMPLETENESS, score: 0.1, weight: 1.0, issues: [] },
        { category: QualityCategory.FORMAT, score: 0.1, weight: 1.0, issues: [] },
      ];
      const verdict = evaluateVerdict(dims, {
        ...DEFAULT_THRESHOLD_CONFIG,
        thresholds: nonBlockingThresholds,
        minAggregateScore: 0.6,
      });
      expect(verdict.pass).toBe(false);
      expect(verdict.score).toBeCloseTo(0.1, 4);
      expect(verdict.summary).toContain('aggregate score');
    });
  });

  // ── Threshold Verdict: Pass / Fail ──

  describe('threshold verdict', () => {
    it('auto-fails when critical issues exceed maxCriticalIssues', () => {
      const dims: DimensionScore[] = [
        {
          category: QualityCategory.COMPLETENESS, score: 0.9, weight: 1.0,
          issues: [
            { severity: QualitySeverity.CRITICAL, category: QualityCategory.COMPLETENESS, description: 'critical 1', suggestion: 'fix', ruleId: 'c' },
          ],
        },
      ];
      const config = { ...DEFAULT_THRESHOLD_CONFIG, maxCriticalIssues: 0 };
      const verdict = evaluateVerdict(dims, config);
      expect(verdict.pass).toBe(false);
      expect(verdict.summary).toContain('critical');
    });

    it('auto-fails when major issues exceed maxMajorIssues', () => {
      const issues = Array.from({ length: 4 }, (_, i) => ({
        severity: QualitySeverity.MAJOR,
        category: QualityCategory.FORMAT,
        description: `major ${i}`,
        suggestion: 'fix',
        ruleId: 'f',
      }));
      const dims: DimensionScore[] = [
        { category: QualityCategory.FORMAT, score: 0.8, weight: 1.0, issues },
      ];
      const config = { ...DEFAULT_THRESHOLD_CONFIG, maxMajorIssues: 3 };
      const verdict = evaluateVerdict(dims, config);
      expect(verdict.pass).toBe(false);
      expect(verdict.summary).toContain('major');
    });

    it('fails when blocking category score below threshold', () => {
      const dims: DimensionScore[] = [
        { category: QualityCategory.COMPLETENESS, score: 0.3, weight: 1.0, issues: [] },
      ];
      // COMPLETENESS is blocking with minScore 0.7 in DEFAULT_THRESHOLD_CONFIG
      const verdict = evaluateVerdict(dims, DEFAULT_THRESHOLD_CONFIG);
      expect(verdict.pass).toBe(false);
      expect(verdict.summary).toContain('COMPLETENESS');
    });

    it('passes when all conditions met', () => {
      const dims: DimensionScore[] = [
        { category: QualityCategory.COMPLETENESS, score: 0.9, weight: 1.0, issues: [] },
        { category: QualityCategory.FORMAT, score: 0.8, weight: 0.5, issues: [] },
      ];
      const verdict = evaluateVerdict(dims, DEFAULT_THRESHOLD_CONFIG);
      expect(verdict.pass).toBe(true);
    });
  });

  // ── Retry Count ──

  describe('retry count', () => {
    it('increments retry count on blockOnFail failure', async () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: true,
        maxRetries: 3,
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'Hi' }],
        state: {},
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(result.state[QUALITY_GATE_RETRY_KEY]).toBe(1);
      expect(result.metadata.aborted).toBe(false);
    });

    it('aborts when retry count exceeds maxRetries', async () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: true,
        maxRetries: 2,
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'Hi' }],
        state: { [QUALITY_GATE_RETRY_KEY]: 2 },
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(result.metadata.aborted).toBe(true);
      expect(result.metadata.abortReason).toContain('failed after 2 retries');
    });

    it('does not increment retry when blockOnFail is false', async () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: false,
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'Hi' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(result.state[QUALITY_GATE_RETRY_KEY]).toBeUndefined();
      expect(result.metadata.aborted).toBe(false);
    });
  });

  // ── Custom Check Functions ──

  describe('custom check functions', () => {
    it('uses custom check over built-in when registered', async () => {
      const customFn: QualityCheckFn = vi.fn(async () => ({
        category: QualityCategory.COMPLETENESS,
        score: 0.42,
        weight: 1.0,
        issues: [],
      }));

      const mw = new QualityGateMiddleware({
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.3, weight: 1.0, blocking: false }],
        customChecks: { completeness: customFn },
        thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.1 },
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'output text here' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(customFn).toHaveBeenCalledOnce();
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0.42);
    });

    it('records error when custom check throws', async () => {
      const throwingFn: QualityCheckFn = async () => {
        throw new Error('custom check exploded');
      };

      const mw = new QualityGateMiddleware({
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.1, weight: 1.0, blocking: false }],
        customChecks: { completeness: throwingFn },
        thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.0 },
        blockOnFail: false,
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'some output' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      expect(report.dimensions[0].score).toBe(0);
      expect(report.dimensions[0].issues[0].description).toContain('custom check exploded');
    });

    it('falls back to built-in when no custom check for rule id', async () => {
      // Rule id 'custom-unknown' has no built-in and no custom → assume pass
      const mw = new QualityGateMiddleware({
        rules: [{ id: 'custom-unknown', label: 'Unknown', category: QualityCategory.SAFETY, threshold: 0.5, weight: 1.0, blocking: false }],
        thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.1 },
        blockOnFail: false,
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'output' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;
      // No check function → score 1.0, INFO issue
      expect(report.dimensions[0].score).toBe(1.0);
      expect(report.dimensions[0].issues[0].severity).toBe(QualitySeverity.INFO);
    });
  });

  // ── blockOnFail Behavior ──

  describe('blockOnFail behavior', () => {
    it('sets aborted=true when blockOnFail and maxRetries exhausted', async () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: true,
        maxRetries: 0,
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'X' }],
        state: { [QUALITY_GATE_RETRY_KEY]: 0 },
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(result.metadata.aborted).toBe(true);
      expect(result.metadata.abortReason).toBeDefined();
    });

    it('does not set aborted when blockOnFail=false even on failure', async () => {
      const mw = new QualityGateMiddleware({
        blockOnFail: false,
        rules: [{ id: 'completeness', label: 'C', category: QualityCategory.COMPLETENESS, threshold: 0.7, weight: 1.0, blocking: true }],
      });
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'X' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      expect(result.metadata.aborted).toBe(false);
    });
  });

  // ── No Output → Skip ──

  describe('empty output handling', () => {
    it('skips quality check when no assistant messages', async () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({
        messages: [{ role: 'user', content: 'hello' }],
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      // No report stored
      expect(result.state[QUALITY_GATE_STATE_KEY]).toBeUndefined();
    });
  });

  // ── Report Structure ──

  describe('report structure', () => {
    it('populates all report fields correctly', async () => {
      const mw = new QualityGateMiddleware();
      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'implement a sorting algorithm' },
          { role: 'assistant', content: 'Here is a comprehensive sorting algorithm implementation that covers quicksort, mergesort, and heapsort with full documentation and test coverage for each variant.' },
        ],
        iteration: 3,
      });
      const result = await mw.execute(ctx, makeNext(ctx));
      const report = result.state[QUALITY_GATE_STATE_KEY] as QualityReport;

      expect(report).toBeDefined();
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.dimensions).toBeInstanceOf(Array);
      expect(report.dimensions.length).toBeGreaterThan(0);
      expect(report.verdict).toHaveProperty('pass');
      expect(report.verdict).toHaveProperty('score');
      expect(report.verdict).toHaveProperty('issues');
      expect(report.verdict).toHaveProperty('summary');
      expect(report.metadata.rulesEvaluated).toBe(DEFAULT_QUALITY_RULES.length);
      expect(typeof report.metadata.scorePercent).toBe('number');
      expect(report.metadata.blockOnFail).toBe(true);
    });
  });

  // ── Onion Model: next() Called First ──

  describe('onion model', () => {
    it('calls next() before evaluating quality', async () => {
      const mw = new QualityGateMiddleware();
      const order: string[] = [];

      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'task' },
          { role: 'assistant', content: 'A solid comprehensive output with enough content' },
        ],
      });

      const next: MiddlewareNext = async () => {
        order.push('next');
        return ctx;
      };

      await mw.execute(ctx, next);
      order.push('after-execute');

      expect(order[0]).toBe('next');
    });
  });

  // ── Factory Function ──

  describe('createQualityGateMiddleware', () => {
    it('creates instance with default config', () => {
      const mw = createQualityGateMiddleware();
      expect(mw).toBeInstanceOf(QualityGateMiddleware);
      expect(mw.name).toBe('quality-gate');
    });

    it('creates instance with custom config', () => {
      const mw = createQualityGateMiddleware({ maxRetries: 10, blockOnFail: false });
      expect(mw).toBeInstanceOf(QualityGateMiddleware);
    });
  });

  // ── evaluateVerdict Pure Function ──

  describe('evaluateVerdict (pure)', () => {
    it('returns score 1.0 and pass for empty dimensions', () => {
      const verdict = evaluateVerdict([], DEFAULT_THRESHOLD_CONFIG);
      expect(verdict.pass).toBe(true);
      expect(verdict.score).toBe(1.0);
    });

    it('handles single dimension correctly', () => {
      const dims: DimensionScore[] = [
        { category: QualityCategory.FORMAT, score: 0.75, weight: 1.0, issues: [] },
      ];
      const verdict = evaluateVerdict(dims, { ...DEFAULT_THRESHOLD_CONFIG, minAggregateScore: 0.6 });
      expect(verdict.pass).toBe(true);
      expect(verdict.score).toBeCloseTo(0.75, 4);
    });
  });

  // ── createEmptyVerdict / createEmptyReport ──

  describe('helper factories', () => {
    it('createEmptyVerdict returns passing verdict', () => {
      const v = createEmptyVerdict();
      expect(v.pass).toBe(true);
      expect(v.score).toBe(1.0);
      expect(v.issues).toHaveLength(0);
    });

    it('createEmptyReport returns valid report', () => {
      const r = createEmptyReport();
      expect(r.verdict.pass).toBe(true);
      expect(r.dimensions).toHaveLength(0);
      expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.durationMs).toBe(0);
    });
  });

  // ── DEFAULT_QUALITY_RULES ──

  describe('DEFAULT_QUALITY_RULES', () => {
    it('contains 3 built-in rules', () => {
      expect(DEFAULT_QUALITY_RULES).toHaveLength(3);
      const ids = DEFAULT_QUALITY_RULES.map(r => r.id);
      expect(ids).toContain('completeness');
      expect(ids).toContain('format');
      expect(ids).toContain('relevance');
    });

    it('completeness rule is blocking', () => {
      const rule = DEFAULT_QUALITY_RULES.find(r => r.id === 'completeness');
      expect(rule!.blocking).toBe(true);
    });

    it('format rule is non-blocking', () => {
      const rule = DEFAULT_QUALITY_RULES.find(r => r.id === 'format');
      expect(rule!.blocking).toBe(false);
    });
  });
});
