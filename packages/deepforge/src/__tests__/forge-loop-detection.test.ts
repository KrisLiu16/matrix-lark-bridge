/**
 * forge-loop-detection.test.ts — LoopDetectionMiddleware unit tests
 *
 * Covers: CircularBuffer, djb2 hash, Jaccard similarity, identical/similar
 * output detection, 3-tier escalation, consecutive repeat counting, config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LoopDetectionMiddleware,
  type LoopDetectionConfig,
  type LoopDetectionResult,
} from '../forge-loop-detection';
import type {
  MiddlewareContext,
  MiddlewareMessage,
  MiddlewareNext,
} from '../types/middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal MiddlewareContext with the given assistant output. */
function makeCtx(assistantContent: string): MiddlewareContext {
  const messages: MiddlewareMessage[] = [
    { role: 'user', content: 'Do something' },
    { role: 'assistant', content: assistantContent },
  ];
  return {
    messages,
    config: {
      projectId: 'test',
      model: 'test-model',
      effort: 'medium',
      maxConcurrent: 1,
      phase: 'executing',
      iteration: 1,
    },
    iteration: { number: 1, taskCount: 1, completedCount: 0, failedCount: 0 },
    state: {},
    metadata: {
      runId: 'run-1',
      chain: ['loop-detection'],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
  };
}

/** A passthrough next() that returns the ctx unchanged. */
function passthroughNext(ctx: MiddlewareContext): MiddlewareNext {
  return () => Promise.resolve(ctx);
}

/**
 * Feed N identical outputs through the middleware sequentially.
 * Returns the detection result from the last invocation.
 */
async function feedOutputs(
  mw: LoopDetectionMiddleware,
  outputs: string[],
): Promise<LoopDetectionContext[]> {
  const results: LoopDetectionContext[] = [];
  for (const output of outputs) {
    const ctx = makeCtx(output);
    const result = await mw.execute(ctx, passthroughNext(ctx));
    results.push(result);
  }
  return results;
}

type LoopDetectionContext = MiddlewareContext & {
  state: Record<string, unknown>;
};

function getResult(ctx: MiddlewareContext): LoopDetectionResult {
  return ctx.state['loop-detection:result'] as LoopDetectionResult;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('LoopDetectionMiddleware', () => {
  let mw: LoopDetectionMiddleware;

  beforeEach(() => {
    mw = new LoopDetectionMiddleware();
  });

  // -------------------------------------------------------------------------
  // 1. Constructor & config
  // -------------------------------------------------------------------------
  describe('constructor & config', () => {
    it('uses default config when none provided', () => {
      const config = mw.getConfig();
      expect(config.windowSize).toBe(10);
      expect(config.similarityThreshold).toBe(0.85);
      expect(config.maxConsecutiveRepeats).toBe(3);
      expect(config.abortOnLoop).toBe(false);
      expect(config.abortThreshold).toBe(5);
    });

    it('merges partial config with defaults', () => {
      const custom = new LoopDetectionMiddleware({
        windowSize: 5,
        similarityThreshold: 0.9,
      });
      const config = custom.getConfig();
      expect(config.windowSize).toBe(5);
      expect(config.similarityThreshold).toBe(0.9);
      expect(config.maxConsecutiveRepeats).toBe(3); // default kept
    });

    it('clamps abortThreshold to be >= maxConsecutiveRepeats', () => {
      const custom = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 5,
        abortThreshold: 2, // too low
      });
      expect(custom.getConfig().abortThreshold).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Middleware interface properties
  // -------------------------------------------------------------------------
  describe('middleware interface', () => {
    it('has expected name, priority, and flags', () => {
      expect(mw.name).toBe('loop-detection');
      expect(mw.priority).toBe(115);
      expect(mw.enabled).toBe(true);
      expect(mw.continueOnError).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. shouldRun predicate
  // -------------------------------------------------------------------------
  describe('shouldRun', () => {
    it('returns false when messages are empty', () => {
      const ctx = makeCtx('hello');
      ctx.messages = [];
      expect(mw.shouldRun(ctx)).toBe(false);
    });

    it('returns false when iteration is undefined', () => {
      const ctx = makeCtx('hello');
      ctx.iteration = undefined;
      expect(mw.shouldRun(ctx)).toBe(false);
    });

    it('returns true when messages exist and iteration is set', () => {
      const ctx = makeCtx('hello');
      expect(mw.shouldRun(ctx)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Identical output detection (djb2 hash fast path)
  // -------------------------------------------------------------------------
  describe('identical output detection', () => {
    it('does not trigger on first output', async () => {
      const results = await feedOutputs(mw, ['output A']);
      const det = getResult(results[0]);
      expect(det.loopDetected).toBe(false);
      expect(det.consecutiveRepeats).toBe(1);
      expect(det.escalation).toBe('none');
    });

    it('counts consecutive identical outputs', async () => {
      const results = await feedOutputs(mw, ['same', 'same', 'same']);
      expect(getResult(results[0]).consecutiveRepeats).toBe(1);
      expect(getResult(results[1]).consecutiveRepeats).toBe(2);
      expect(getResult(results[2]).consecutiveRepeats).toBe(3);
      expect(getResult(results[2]).loopDetected).toBe(true);
      expect(getResult(results[2]).lastSimilarity).toBe(1.0);
    });

    it('resets count when output changes', async () => {
      const results = await feedOutputs(mw, ['same', 'same', 'different', 'same']);
      expect(getResult(results[2]).consecutiveRepeats).toBe(1);
      expect(getResult(results[2]).loopDetected).toBe(false);
      // After the break, chain restarts from 1
      expect(getResult(results[3]).consecutiveRepeats).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Similar output detection (Jaccard similarity)
  // -------------------------------------------------------------------------
  describe('similar output detection (Jaccard)', () => {
    it('detects similar (but not identical) outputs above threshold', async () => {
      // These strings share most 3-gram shingles but differ slightly
      const base = 'The quick brown fox jumps over the lazy dog and runs away';
      const similar1 = 'The quick brown fox jumps over the lazy dog and walks away';
      const similar2 = 'The quick brown fox jumps over the lazy dog and strolls away';

      const custom = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 2,
        similarityThreshold: 0.7,
      });

      const results = await feedOutputs(custom, [base, similar1, similar2]);
      // The similar strings should have high Jaccard scores
      const det2 = getResult(results[1]);
      expect(det2.lastSimilarity).toBeGreaterThan(0.7);
      expect(det2.consecutiveRepeats).toBe(2);
      expect(det2.loopDetected).toBe(true);
    });

    it('does not flag dissimilar outputs', async () => {
      const results = await feedOutputs(mw, [
        'Implementing user authentication with JWT tokens and bcrypt hashing',
        'Building a React dashboard with Chart.js for data visualization',
        'Setting up PostgreSQL database migrations with Knex.js',
      ]);
      for (const r of results) {
        expect(getResult(r).loopDetected).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Three-tier escalation (none → warning → abort)
  // -------------------------------------------------------------------------
  describe('escalation levels', () => {
    it('escalation=none when below maxConsecutiveRepeats', async () => {
      const results = await feedOutputs(mw, ['x', 'x']);
      expect(getResult(results[1]).escalation).toBe('none');
    });

    it('escalation=warning when loop detected and abortOnLoop=false', async () => {
      const results = await feedOutputs(mw, ['x', 'x', 'x']);
      const det = getResult(results[2]);
      expect(det.escalation).toBe('warning');
      expect(det.loopDetected).toBe(true);
    });

    it('escalation=warning at maxConsecutiveRepeats even with abortOnLoop=true', async () => {
      const custom = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 3,
        abortOnLoop: true,
        abortThreshold: 5,
      });
      const results = await feedOutputs(custom, ['r', 'r', 'r']);
      expect(getResult(results[2]).escalation).toBe('warning');
    });

    it('escalation=abort when consecutiveRepeats >= abortThreshold', async () => {
      const custom = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 2,
        abortOnLoop: true,
        abortThreshold: 3,
      });
      const results = await feedOutputs(custom, ['r', 'r', 'r']);
      const det = getResult(results[2]);
      expect(det.escalation).toBe('abort');
      expect(det.consecutiveRepeats).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Warning injection
  // -------------------------------------------------------------------------
  describe('warning injection', () => {
    it('injects system warning message on loop detection', async () => {
      const results = await feedOutputs(mw, ['loop', 'loop', 'loop']);
      const lastCtx = results[2];
      const sysMsg = lastCtx.messages.find(
        (m) => m.role === 'system' && m.content.includes('[LoopDetection] WARNING'),
      );
      expect(sysMsg).toBeDefined();
      expect(sysMsg!.content).toContain('3 consecutive similar outputs');
      expect(sysMsg!.content).toContain('Similarity score');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Abort injection
  // -------------------------------------------------------------------------
  describe('abort injection', () => {
    it('sets metadata.aborted and injects abort message', async () => {
      const custom = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 2,
        abortOnLoop: true,
        abortThreshold: 2,
      });
      const results = await feedOutputs(custom, ['a', 'a']);
      const lastCtx = results[1];
      expect(lastCtx.metadata.aborted).toBe(true);
      expect(lastCtx.metadata.abortReason).toContain('Loop detected');
      const abortMsg = lastCtx.messages.find(
        (m) => m.role === 'system' && m.content.includes('[LoopDetection] ABORT'),
      );
      expect(abortMsg).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 9. State bag population
  // -------------------------------------------------------------------------
  describe('state bag', () => {
    it('writes detection result and consecutive count to state', async () => {
      const results = await feedOutputs(mw, ['test']);
      const ctx = results[0];
      expect(ctx.state['loop-detection:result']).toBeDefined();
      expect(ctx.state['loop-detection:consecutiveRepeats']).toBe(1);
    });

    it('sets loop-detection:detected flag on loop', async () => {
      const results = await feedOutputs(mw, ['d', 'd', 'd']);
      expect(results[2].state['loop-detection:detected']).toBe(true);
      // First output should NOT have the flag
      expect(results[0].state['loop-detection:detected']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 10. Empty output handling
  // -------------------------------------------------------------------------
  describe('empty output', () => {
    it('treats empty assistant output as no loop', async () => {
      const results = await feedOutputs(mw, ['', '', '']);
      for (const r of results) {
        const det = getResult(r);
        expect(det.loopDetected).toBe(false);
        expect(det.consecutiveRepeats).toBe(0);
      }
    });

    it('treats whitespace-only output as empty', async () => {
      const results = await feedOutputs(mw, ['   \n\t  ']);
      expect(getResult(results[0]).consecutiveRepeats).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 11. Reset and window management
  // -------------------------------------------------------------------------
  describe('reset & window', () => {
    it('reset() clears the sliding window', async () => {
      await feedOutputs(mw, ['x', 'x']);
      expect(mw.currentWindowSize).toBe(2);
      mw.reset();
      expect(mw.currentWindowSize).toBe(0);
      // After reset, chain starts fresh
      const results = await feedOutputs(mw, ['x']);
      expect(getResult(results[0]).consecutiveRepeats).toBe(1);
    });

    it('window does not exceed windowSize capacity', async () => {
      const small = new LoopDetectionMiddleware({ windowSize: 3 });
      await feedOutputs(small, ['a', 'b', 'c', 'd', 'e']);
      expect(small.currentWindowSize).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Output extraction (multi-message context)
  // -------------------------------------------------------------------------
  describe('output extraction', () => {
    it('concatenates assistant messages after last user message', async () => {
      const ctx: MiddlewareContext = {
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'part1' },
          { role: 'assistant', content: 'part2' },
        ],
        config: {
          projectId: 'test',
          model: 'test',
          effort: 'medium',
          maxConcurrent: 1,
          phase: 'executing',
          iteration: 1,
        },
        iteration: { number: 1, taskCount: 1, completedCount: 0, failedCount: 0 },
        state: {},
        metadata: {
          runId: 'run-1',
          chain: ['loop-detection'],
          currentIndex: 0,
          startedAt: new Date().toISOString(),
          timing: {},
          aborted: false,
        },
      };

      // First call with the multi-part output
      const result1 = await mw.execute(ctx, passthroughNext(ctx));

      // Second call with same multi-part — should see similarity=1.0
      const ctx2: MiddlewareContext = {
        ...ctx,
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'part1' },
          { role: 'assistant', content: 'part2' },
        ],
        state: {},
        metadata: { ...ctx.metadata, aborted: false },
      };
      const result2 = await mw.execute(ctx2, passthroughNext(ctx2));
      expect(getResult(result2).lastSimilarity).toBe(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // 13. Custom config overrides
  // -------------------------------------------------------------------------
  describe('config overrides', () => {
    it('respects custom similarityThreshold=1.0 (exact match only)', async () => {
      const strict = new LoopDetectionMiddleware({
        similarityThreshold: 1.0,
        maxConsecutiveRepeats: 2,
      });
      // Similar but not identical strings
      const base = 'The quick brown fox jumps over the lazy dog';
      const variant = 'The quick brown fox leaps over the lazy dog';
      const results = await feedOutputs(strict, [base, variant]);
      // With threshold=1.0, these should NOT match
      expect(getResult(results[1]).loopDetected).toBe(false);
    });

    it('respects custom maxConsecutiveRepeats', async () => {
      const lenient = new LoopDetectionMiddleware({
        maxConsecutiveRepeats: 5,
      });
      const results = await feedOutputs(lenient, ['x', 'x', 'x', 'x']);
      // 4 repeats < 5 threshold, so no loop
      expect(getResult(results[3]).loopDetected).toBe(false);
      expect(getResult(results[3]).consecutiveRepeats).toBe(4);
    });
  });
});
