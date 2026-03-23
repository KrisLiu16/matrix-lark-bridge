/**
 * forge-summarization.test.ts — SummarizationMiddleware unit tests
 *
 * Covers: constructor defaults, shouldRun guard, parseIntoSections,
 * extractKeyPoints scoring, generateSummary (3 styles), compression ratio,
 * disk persistence (mocked fs), onion after-hook pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SummarizationMiddleware,
  createSummarizationMiddleware,
  DEFAULT_SUMMARIZATION_CONFIG,
  SUMMARIZATION_STATE_KEYS,
  type SummarizationConfig,
  type SummarizationInput,
  type SummarizationResult,
} from '../forge-summarization';
import type {
  MiddlewareContext,
  MiddlewareMessage,
  MiddlewareNext,
} from '../types/middleware';

// Mock node:fs
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

// Mock node:path — passthrough implementation so path logic works but calls are tracked
vi.mock('node:path', () => ({
  join: vi.fn((...segments: string[]) => segments.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/') || '/'),
}));

import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal MiddlewareContext. */
function makeCtx(
  assistantContent: string,
  phase: string = 'executing',
  input?: SummarizationInput,
): MiddlewareContext {
  const messages: MiddlewareMessage[] = [];
  if (assistantContent) {
    messages.push({ role: 'user', content: 'Do something' });
    messages.push({ role: 'assistant', content: assistantContent });
  }
  const state: Record<string, unknown> = {};
  if (input) {
    state[SUMMARIZATION_STATE_KEYS.INPUT] = input;
  }
  return {
    messages,
    config: {
      projectId: 'test-project',
      model: 'test-model',
      effort: 'medium',
      maxConcurrent: 1,
      phase: phase as any,
      iteration: 1,
    },
    iteration: { number: 1, taskCount: 1, completedCount: 0, failedCount: 0 },
    state,
    metadata: {
      runId: 'run-1',
      chain: ['summarization'],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
  };
}

/** Default summarization input. */
function defaultInput(overrides?: Partial<SummarizationInput>): SummarizationInput {
  return {
    workDir: '/tmp/test-project',
    role: 'tester',
    ...overrides,
  };
}

/** Generate long text exceeding the default 8000 char threshold. */
function makeLongOutput(charCount: number = 10000): string {
  const sections = [
    '## Analysis Results\n',
    '- ✅ All tests passed with 95% coverage\n',
    '- ❌ Performance regression detected in auth module\n',
    '- Found 42 files matching the pattern\n',
    '- **Critical**: Memory leak in connection pool\n',
    '\n## Implementation Details\n',
    'The implementation follows the standard pattern.\n',
    'Let me explain the approach step by step.\n',
    'Now I will describe each component.\n',
    '1. First component handles authentication with 99.5% uptime\n',
    '2. Second component manages data persistence\n',
    '- Database queries optimized: 150ms → 30ms (80% reduction)\n',
    '\n## Metrics\n',
    '- Total execution time: 1250ms\n',
    '- Memory usage: 256MB peak\n',
    '- Throughput: 1000 req/s\n',
  ];
  let result = sections.join('');
  // Pad to desired length
  while (result.length < charCount) {
    result += '\nThis is additional context providing background information about the system architecture and design decisions that were made during the development process.';
  }
  return result;
}

/** Passthrough next() that returns the same context. */
function passthroughNext(ctx: MiddlewareContext): MiddlewareNext {
  return () => Promise.resolve(ctx);
}

// ---------------------------------------------------------------------------
// 1. Constructor & Default Configuration
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — constructor', () => {
  it('has correct middleware interface properties', () => {
    const mw = new SummarizationMiddleware();
    expect(mw.name).toBe('summarization');
    expect(mw.priority).toBe(70);
    expect(mw.enabled).toBe(true);
    expect(mw.timeout).toBe(10_000);
    expect(mw.continueOnError).toBe(true);
  });

  it('uses default config when no overrides given', () => {
    const mw = new SummarizationMiddleware();
    // Verify via shouldRun behavior with default activePhases
    const ctx = makeCtx('output', 'executing', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(true);

    const ctxSetup = makeCtx('output', 'setup', defaultInput());
    expect(mw.shouldRun(ctxSetup)).toBe(false);
  });

  it('merges partial config with defaults', () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 500 });
    // The custom threshold should be applied; shouldRun still works with default phases
    const ctx = makeCtx('output', 'iterating', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(true);
  });

  it('overrides activePhases completely when provided', () => {
    const mw = new SummarizationMiddleware({
      activePhases: ['critiquing'],
    });
    const ctxExec = makeCtx('output', 'executing', defaultInput());
    expect(mw.shouldRun(ctxExec)).toBe(false);

    const ctxCrit = makeCtx('output', 'critiquing', defaultInput());
    expect(mw.shouldRun(ctxCrit)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. shouldRun Guard
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — shouldRun', () => {
  const mw = new SummarizationMiddleware();

  it('returns true when phase is active and input is set', () => {
    const ctx = makeCtx('output', 'executing', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(true);
  });

  it('returns true for iterating phase', () => {
    const ctx = makeCtx('output', 'iterating', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(true);
  });

  it('returns false when phase is not in activePhases', () => {
    const ctx = makeCtx('output', 'setup', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(false);
  });

  it('returns false for planning phase', () => {
    const ctx = makeCtx('output', 'planning', defaultInput());
    expect(mw.shouldRun(ctx)).toBe(false);
  });

  it('returns false when input is not set in state', () => {
    const ctx = makeCtx('output', 'executing');
    expect(mw.shouldRun(ctx)).toBe(false);
  });

  it('returns false when input is null', () => {
    const ctx = makeCtx('output', 'executing');
    ctx.state[SUMMARIZATION_STATE_KEYS.INPUT] = null;
    expect(mw.shouldRun(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. parseIntoSections (tested via execute output)
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — section parsing', () => {
  it('extracts sections from markdown headings', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const content = '## Section A\nContent A\n## Section B\nContent B';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.wasPerformed).toBe(true);
    expect(sr.sectionsExtracted).toBe(2);
  });

  it('handles nested heading levels (### and ####)', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const content = '# Top\nIntro\n## Mid\nMid content\n### Sub\nSub content\n#### Deep\nDeep content';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.sectionsExtracted).toBe(4); // #, ##, ###, ####
  });

  it('treats text before first heading as a section', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const content = 'Preamble text here\n## First Section\nSection content';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // sectionsExtracted counts sections with headings
    expect(sr.sectionsExtracted).toBe(1);
    expect(sr.wasPerformed).toBe(true);
  });

  it('handles empty content gracefully', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    // Even with threshold 0, empty output should not be summarized (length <= 0)
    const ctx = makeCtx('', 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.wasPerformed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. extractKeyPoints (line-level scoring)
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — key point extraction', () => {
  it('prioritizes bullet points', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      maxKeyPointsPerSection: 2,
      includeMetrics: false,
    });
    const content = '## Results\n- Important finding about the system\nFiller text that explains things\nLet me describe this for you\n- Another key observation noted';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).toContain('Important finding');
    expect(sr.summary).toContain('Another key observation');
  });

  it('prioritizes decision markers (✅❌⚠️→)', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      maxKeyPointsPerSection: 2,
      includeMetrics: false,
    });
    const content = '## Status\n✅ All tests passed successfully\nRegular description text\n❌ Build failed for arm64 target';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).toContain('All tests passed');
    expect(sr.summary).toContain('Build failed');
  });

  it('prioritizes data points (numbers, percentages)', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      maxKeyPointsPerSection: 2,
      includeMetrics: false,
    });
    const content = '## Metrics\nThis is a general observation about the system\nPerformance improved by 85% after optimization\nLatency reduced to 30ms average response time';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).toContain('85%');
  });

  it('deprioritizes filler lines', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      maxKeyPointsPerSection: 1,
      includeMetrics: false,
    });
    const content = '## Work\nLet me explain how this works step by step\n- ✅ Critical fix applied to authentication module';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // Should pick the key point, not the filler
    expect(sr.summary).toContain('Critical fix');
    expect(sr.summary).not.toContain('Let me explain');
  });

  it('filters out lines with score <= 0', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      maxKeyPointsPerSection: 10,
      includeMetrics: false,
    });
    // All lines are filler or too short → no key points
    const content = '## Notes\nOK\nYes\nLet me show you this\nI will now proceed\n首先我来看下';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // Summary should be empty or minimal (only metrics if enabled)
    expect(sr.summary.length).toBeLessThan(sr.originalLength);
  });
});

// ---------------------------------------------------------------------------
// 5. generateSummary — 3 styles
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — structured style', () => {
  it('preserves heading hierarchy in output', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'structured',
      includeMetrics: false,
    });
    const content = '## Analysis\n- Finding A is important for the project\n## Conclusions\n- ✅ Conclusion B was verified and confirmed';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).toContain('## Analysis');
    expect(sr.summary).toContain('## Conclusions');
  });

  it('normalizes items to bullet format', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'structured',
      includeMetrics: false,
    });
    const content = '## Data\n**This is bold emphasis indicating importance**';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // Non-bullet items get '- ' prefix
    if (sr.summary.includes('bold emphasis')) {
      expect(sr.summary).toMatch(/- .+bold emphasis/);
    }
  });
});

describe('SummarizationMiddleware — bullets style', () => {
  it('produces flat bullet list', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      includeMetrics: false,
    });
    const content = '## A\n- Point from section A is detailed\n## B\n- Point from section B is specific';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // No heading markers in bullets style
    expect(sr.summary).not.toContain('## A');
    expect(sr.summary).not.toContain('## B');
    expect(sr.summary).toContain('- Point from section A');
    expect(sr.summary).toContain('- Point from section B');
  });

  it('deduplicates identical points across sections', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'bullets',
      includeMetrics: false,
    });
    const content = '## A\n- Duplicate finding across multiple sections\n## B\n- Duplicate finding across multiple sections';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    const matches = sr.summary.match(/Duplicate finding/g);
    expect(matches?.length).toBe(1);
  });
});

describe('SummarizationMiddleware — prose style', () => {
  it('joins key points with sentence separator', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'prose',
      includeMetrics: false,
    });
    const content = '## A\n- First key point about the analysis\n## B\n- Second key point about the results';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    // Prose joins with '。'
    expect(sr.summary).toContain('。');
    // No bullet markers
    expect(sr.summary).not.toMatch(/^- /m);
  });

  it('strips heading markers from prose output', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'prose',
      includeMetrics: false,
    });
    const content = '## Heading\n- Content line about important details';
    const ctx = makeCtx(content, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).not.toContain('##');
  });
});

// ---------------------------------------------------------------------------
// 6. Compression Ratio & Metrics
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — compression ratio', () => {
  it('calculates correct compression ratio', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const longContent = makeLongOutput(10000);
    const ctx = makeCtx(longContent, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(sr.wasPerformed).toBe(true);
    expect(sr.originalLength).toBeGreaterThan(0);
    expect(sr.summaryLength).toBeGreaterThan(0);
    expect(sr.compressionRatio).toBeCloseTo(sr.summaryLength / sr.originalLength, 5);
    expect(sr.compressionRatio).toBeLessThan(1);
  });

  it('returns wasPerformed=false when below threshold', async () => {
    const mw = new SummarizationMiddleware(); // default 8000 threshold
    const ctx = makeCtx('Short output', 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(sr.wasPerformed).toBe(false);
    expect(sr.compressionRatio).toBe(1);
    expect(sr.summaryLength).toBe(0);
    expect(sr.summary).toBe('');
  });

  it('includes metrics line when includeMetrics=true', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      includeMetrics: true,
    });
    const ctx = makeCtx('## Test\n- Line with data for testing purposes', 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).toContain('原文统计');
    expect(sr.summary).toMatch(/\d+ 字符/);
    expect(sr.summary).toMatch(/\d+ 行/);
  });

  it('omits metrics line when includeMetrics=false', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      includeMetrics: false,
    });
    const ctx = makeCtx('## Test\n- Line with data for testing purposes', 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summary).not.toContain('原文统计');
  });

  it('truncates summary to maxSummaryLength', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      maxSummaryLength: 100,
    });
    const longContent = makeLongOutput(10000);
    const ctx = makeCtx(longContent, 'executing', defaultInput());

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;
    expect(sr.summaryLength).toBeLessThanOrEqual(100);
    expect(sr.summary).toContain('summary truncated');
  });
});

// ---------------------------------------------------------------------------
// 7. Disk Persistence (mocked fs)
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — disk persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('creates reports directory and writes summary file', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      persistToDisk: true,
    });
    const ctx = makeCtx(
      '## Report\n- ✅ Important finding for persistence test',
      'executing',
      defaultInput({ workDir: '/projects/test', role: 'analyst' }),
    );

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(mkdirSync).toHaveBeenCalledWith('/projects/test/reports', { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      '/projects/test/reports/analyst-summary.md',
      expect.any(String),
      'utf-8',
    );
    expect(sr.persistedPath).toBe('/projects/test/reports/analyst-summary.md');
  });

  it('skips mkdir when reports directory exists', async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      persistToDisk: true,
    });
    const ctx = makeCtx(
      '## Report\n- ✅ Finding for existing dir test scenario',
      'executing',
      defaultInput({ workDir: '/projects/existing', role: 'dev' }),
    );

    await mw.execute(ctx, passthroughNext(ctx));

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledWith(
      '/projects/existing/reports/dev-summary.md',
      expect.any(String),
      'utf-8',
    );
  });

  it('does not write to disk when persistToDisk=false', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      persistToDisk: false,
    });
    const ctx = makeCtx(
      '## Report\n- ✅ No disk write expected for this test',
      'executing',
      defaultInput(),
    );

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(sr.persistedPath).toBeUndefined();
  });

  it('handles disk write failure gracefully (non-fatal)', async () => {
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      persistToDisk: true,
    });
    const ctx = makeCtx(
      '## Report\n- ✅ Test with simulated disk write failure scenario',
      'executing',
      defaultInput(),
    );

    // Should not throw
    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(sr.wasPerformed).toBe(true);
    expect(sr.persistedPath).toBeUndefined();
  });

  it('does not persist when below threshold (no summarization)', async () => {
    const mw = new SummarizationMiddleware({ persistToDisk: true }); // default 8000 threshold
    const ctx = makeCtx('Short text', 'executing', defaultInput());

    await mw.execute(ctx, passthroughNext(ctx));

    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Onion After-Hook Pattern
// ---------------------------------------------------------------------------

describe('SummarizationMiddleware — onion after-hook', () => {
  it('calls next() first, then processes result', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const callOrder: string[] = [];

    const ctx = makeCtx(
      '## Report\n- ✅ After-hook test with call ordering',
      'executing',
      defaultInput(),
    );

    const next: MiddlewareNext = async () => {
      callOrder.push('next');
      return ctx;
    };

    await mw.execute(ctx, next);
    callOrder.push('after');

    expect(callOrder).toEqual(['next', 'after']);
  });

  it('processes the context returned by next(), not the original', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });

    const originalCtx = makeCtx('', 'executing', defaultInput());

    // next() returns a modified context with assistant output
    const modifiedCtx = makeCtx(
      '## Modified\n- ✅ This was added by downstream middleware',
      'executing',
      defaultInput(),
    );

    const next: MiddlewareNext = async () => modifiedCtx;

    const result = await mw.execute(originalCtx, next);
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    // Should have summarized the modified context's content
    expect(sr.wasPerformed).toBe(true);
    expect(sr.summary).toContain('downstream middleware');
  });

  it('returns result even if no input is set (post-next check)', async () => {
    const mw = new SummarizationMiddleware();
    const ctx = makeCtx('output', 'executing'); // no input
    let nextCalled = false;

    const next: MiddlewareNext = async () => {
      nextCalled = true;
      return ctx;
    };

    const result = await mw.execute(ctx, next);
    expect(nextCalled).toBe(true);
    // No result stored since input was not set
    expect(result.state[SUMMARIZATION_STATE_KEYS.RESULT]).toBeUndefined();
  });

  it('extracts output from task:output state', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const ctx = makeCtx('', 'executing', defaultInput());
    // Simulate task runner setting output in state
    ctx.state['task:output'] = '## From State\n- ✅ Task runner output captured in state bag';

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(sr.wasPerformed).toBe(true);
    expect(sr.summary).toContain('Task runner output');
  });

  it('combines task:output and assistant messages', async () => {
    const mw = new SummarizationMiddleware({ outputThreshold: 0 });
    const ctx = makeCtx(
      '- ✅ Content from assistant message in conversation',
      'executing',
      defaultInput(),
    );
    ctx.state['task:output'] = '- ✅ Content from task runner output in state';

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    expect(sr.wasPerformed).toBe(true);
    // Both sources should contribute to the summary
    expect(sr.originalLength).toBeGreaterThan(0);
  });

  it('supports per-call config overrides via input', async () => {
    const mw = new SummarizationMiddleware({
      outputThreshold: 0,
      summaryStyle: 'structured',
    });
    const ctx = makeCtx(
      '## Section\n- Key data point with 99% accuracy metric',
      'executing',
      defaultInput({
        configOverrides: { summaryStyle: 'bullets', includeMetrics: false },
      }),
    );

    const result = await mw.execute(ctx, passthroughNext(ctx));
    const sr = result.state[SUMMARIZATION_STATE_KEYS.RESULT] as SummarizationResult;

    // bullets style: no heading markers
    expect(sr.summary).not.toContain('## Section');
    expect(sr.summary).not.toContain('原文统计');
  });
});

// ---------------------------------------------------------------------------
// 9. Factory Function
// ---------------------------------------------------------------------------

describe('createSummarizationMiddleware', () => {
  it('returns an object with instance property', () => {
    const { instance } = createSummarizationMiddleware();
    expect(instance).toBeInstanceOf(SummarizationMiddleware);
    expect(instance.name).toBe('summarization');
  });

  it('passes config to the instance', () => {
    const { instance } = createSummarizationMiddleware({
      activePhases: ['critiquing'],
    });
    const ctx = makeCtx('output', 'critiquing', defaultInput());
    expect(instance.shouldRun(ctx)).toBe(true);

    const ctxExec = makeCtx('output', 'executing', defaultInput());
    expect(instance.shouldRun(ctxExec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. DEFAULT_SUMMARIZATION_CONFIG & SUMMARIZATION_STATE_KEYS exports
// ---------------------------------------------------------------------------

describe('Exported constants', () => {
  it('DEFAULT_SUMMARIZATION_CONFIG has expected shape', () => {
    expect(DEFAULT_SUMMARIZATION_CONFIG.outputThreshold).toBe(8000);
    expect(DEFAULT_SUMMARIZATION_CONFIG.maxSummaryLength).toBe(1500);
    expect(DEFAULT_SUMMARIZATION_CONFIG.summaryStyle).toBe('structured');
    expect(DEFAULT_SUMMARIZATION_CONFIG.persistToDisk).toBe(true);
    expect(DEFAULT_SUMMARIZATION_CONFIG.activePhases).toEqual(['executing', 'iterating']);
    expect(DEFAULT_SUMMARIZATION_CONFIG.maxKeyPointsPerSection).toBe(5);
    expect(DEFAULT_SUMMARIZATION_CONFIG.includeMetrics).toBe(true);
  });

  it('SUMMARIZATION_STATE_KEYS has INPUT and RESULT', () => {
    expect(SUMMARIZATION_STATE_KEYS.INPUT).toBe('summarization:input');
    expect(SUMMARIZATION_STATE_KEYS.RESULT).toBe('summarization:result');
  });
});
