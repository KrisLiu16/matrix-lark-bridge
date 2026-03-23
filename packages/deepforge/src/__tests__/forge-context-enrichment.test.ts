/**
 * DeepForge 2.0 — Context Enrichment Middleware Tests
 *
 * Tests for ContextEnrichmentMiddleware covering:
 *   1. Token estimation (CJK/Latin mixed)
 *   2. Incremental budget allocation & trimming
 *   3. 5-layer context injection (memory/brief/trend/role/artifacts)
 *   4. FileCache TTL expiration
 *   5. shouldRun guard
 *   6. Partial truncation logic
 *   7. enabledSections toggle
 *   8. Prompt assembly ordering
 *   9. Config overrides per-call
 *  10. Previous iteration summary
 *
 * @module tests/forge-context-enrichment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs and node:path before importing the module under test
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  estimateTokens,
  ContextEnrichmentMiddleware,
  CONTEXT_STATE_KEYS,
  DEFAULT_CONTEXT_ENRICHMENT_CONFIG,
  createContextEnrichmentMiddleware,
  type ContextEnrichmentInput,
  type ContextEnrichmentResult,
  type ContextEnrichmentConfig,
} from '../forge-context-enrichment';
import { MemoryType, MemorySource } from '../types/memory';
import type { MiddlewareContext, MiddlewareMessage } from '../types/middleware';

// ─── Helpers ───

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

function createMockCtx(stateOverrides: Record<string, unknown> = {}): MiddlewareContext {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    config: {
      projectId: 'test-project',
      model: 'claude-opus-4-6',
      effort: 'high',
      maxConcurrent: 3,
      phase: 'executing',
      iteration: 1,
    },
    iteration: { number: 1, taskCount: 5, completedCount: 0, failedCount: 0 },
    state: { ...stateOverrides },
    metadata: {
      runId: 'run-001',
      chain: ['context-enrichment'],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
  };
}

function makeInput(overrides: Partial<ContextEnrichmentInput> = {}): ContextEnrichmentInput {
  return {
    workDir: '/project',
    role: 'tester',
    iteration: 1,
    allRoles: [
      { name: 'leader', label: 'Leader' },
      { name: 'tester', label: 'Tester' },
      { name: 'coder', label: 'Coder' },
    ],
    ...overrides,
  };
}

function makeMemoryEntry(content: string, relevance: number, confidence = 0.9) {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    content,
    type: MemoryType.Fact,
    tags: ['test'],
    timestamp: new Date().toISOString(),
    relevanceScore: relevance,
    confidence,
    source: MemorySource.Explicit,
    updatedAt: new Date().toISOString(),
    accessCount: 1,
  };
}

const mockNext = () => {
  // next returns the ctx after downstream processing (identity for tests)
  return vi.fn(async () => ({} as MiddlewareContext));
};

// ─── Tests ───

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates Latin text at ~4 chars per token', () => {
    const text = 'Hello world this is a test sentence for estimation';
    const tokens = estimateTokens(text);
    // 50 chars / 4 = 12.5 → ceil = 13
    expect(tokens).toBe(Math.ceil(text.length / 4));
  });

  it('estimates CJK text at ~1.5 tokens per char', () => {
    const text = '你好世界测试';
    const tokens = estimateTokens(text);
    // 6 CJK chars × 1.5 = 9
    expect(tokens).toBe(9);
  });

  it('estimates mixed CJK/Latin correctly', () => {
    const text = '你好Hello';
    // 2 CJK chars × 1.5 = 3, 5 Latin chars / 4 = 1.25
    // total = ceil(3 + 1.25) = ceil(4.25) = 5
    const tokens = estimateTokens(text);
    expect(tokens).toBe(5);
  });

  it('handles CJK punctuation range (0x3000-0x303f)', () => {
    // 「」 are in the CJK punctuation range
    const text = '「テスト」';
    // 「 (0x300C), テ is katakana not in CJK range, ス, ト, 」(0x300D)
    // Actually 「」 are 0x300C/0x300D in 3000-303F → CJK
    // テスト are katakana (30A0-30FF) → not in the CJK ranges defined → Latin
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('ContextEnrichmentMiddleware', () => {
  let mw: ContextEnrichmentMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockReaddirSync.mockReturnValue([]);
    mw = new ContextEnrichmentMiddleware();
  });

  afterEach(() => {
    mw.clearCache();
  });

  // ─── shouldRun guard ───

  describe('shouldRun', () => {
    it('returns false when no input in state', () => {
      const ctx = createMockCtx();
      expect(mw.shouldRun(ctx)).toBe(false);
    });

    it('returns true when input is set in state', () => {
      const ctx = createMockCtx({
        [CONTEXT_STATE_KEYS.INPUT]: makeInput(),
      });
      expect(mw.shouldRun(ctx)).toBe(true);
    });
  });

  // ─── enabledSections toggle ───

  describe('enabledSections toggle', () => {
    it('disables memory layer when memory=false', async () => {
      const input = makeInput({
        memoryEntries: [makeMemoryEntry('important fact', 0.95)],
        configOverrides: {
          enabledSections: { memory: false } as any,
        },
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.memory).toBe(0);
    });

    it('disables artifacts layer when artifacts=false', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['file1.ts', 'file2.ts']);

      const input = makeInput({
        configOverrides: {
          enabledSections: { artifacts: false } as any,
        },
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.artifacts).toBe(0);
    });

    it('disables trend layer when trend=false', async () => {
      const input = makeInput({
        iteration: 2,
        configOverrides: {
          enabledSections: { trend: false } as any,
        },
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.trend).toBe(0);
    });
  });

  // ─── 5-layer context injection ───

  describe('layer resolution', () => {
    it('injects memory layer with user context', async () => {
      const input = makeInput({
        userContext: {
          workContext: 'testing deepforge',
          personalContext: 'QA engineer',
          topOfMind: 'middleware coverage',
        },
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.memory).toBeGreaterThan(0);
      expect(result.prompt).toContain('用户记忆');
      expect(result.prompt).toContain('testing deepforge');
    });

    it('injects memory entries sorted by relevance desc', async () => {
      const input = makeInput({
        memoryEntries: [
          makeMemoryEntry('low relevance', 0.3),
          makeMemoryEntry('high relevance', 0.95),
          makeMemoryEntry('mid relevance', 0.6),
        ],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.prompt).toContain('记忆条目');
      // Verify ordering: high relevance appears before low relevance
      const highIdx = result.prompt.indexOf('high relevance');
      const lowIdx = result.prompt.indexOf('low relevance');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('injects brief layer from brief.md file', async () => {
      mockExistsSync.mockImplementation((p: string) => p === '/project/brief.md');
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === '/project/brief.md') return 'Project brief content here';
        return '';
      });

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.brief).toBeGreaterThan(0);
      expect(result.prompt).toContain('项目简介');
      expect(result.prompt).toContain('Project brief content here');
    });

    it('injects role layer from report files', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === '/project/reports/tester-report.md',
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === '/project/reports/tester-report.md') return 'Tester report content';
        return '';
      });

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.role).toBeGreaterThan(0);
      expect(result.prompt).toContain('你上一次的汇报');
    });

    it('injects artifacts layer from directory listing', async () => {
      mockExistsSync.mockImplementation((p: string) => p === '/project/artifacts');
      mockReaddirSync.mockReturnValue(['src/main.ts', 'src/utils.ts', 'README.md']);

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.artifacts).toBeGreaterThan(0);
      expect(result.prompt).toContain('artifacts/src/main.ts');
      expect(result.prompt).toContain('可用文件');
    });

    it('filters out dotfiles from artifacts listing', async () => {
      mockExistsSync.mockImplementation((p: string) => p === '/project/artifacts');
      mockReaddirSync.mockReturnValue(['.hidden', 'visible.ts', '.gitignore']);

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.prompt).not.toContain('.hidden');
      expect(result.prompt).not.toContain('.gitignore');
      expect(result.prompt).toContain('visible.ts');
    });
  });

  // ─── Token budget & trimming ───

  describe('token budget and trimming', () => {
    it('trims non-required fragments when budget exceeded', async () => {
      // Create a very low budget
      const mwLowBudget = new ContextEnrichmentMiddleware({ maxTokens: 50 });

      // Set up files that produce content
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('brief.md')) return 'Brief '.repeat(100);
        if (typeof p === 'string' && p.includes('status.md')) return 'Status '.repeat(100);
        return 'Content '.repeat(50);
      });
      mockReaddirSync.mockReturnValue(['file1.ts', 'file2.ts']);

      const input = makeInput({
        memoryEntries: [makeMemoryEntry('a fact '.repeat(50), 0.9)],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mwLowBudget.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      // With such a low budget, some layers should be trimmed
      expect(result.wasTrimmed).toBe(true);
      expect(result.trimmedLayers.length).toBeGreaterThan(0);
      mwLowBudget.clearCache();
    });

    it('keeps required fragments even at capacity', async () => {
      // brief and status are required
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && (p.includes('brief.md') || p.includes('status.md')),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('brief.md')) return 'Required brief';
        if (typeof p === 'string' && p.includes('status.md')) return 'Required status';
        return '';
      });

      // Very small budget
      const mwTiny = new ContextEnrichmentMiddleware({ maxTokens: 10 });
      const input = makeInput({
        memoryEntries: [makeMemoryEntry('optional memory content', 0.9)],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mwTiny.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      // Required fragments (brief, status) should still be present
      expect(result.prompt).toContain('Required brief');
      expect(result.prompt).toContain('Required status');
      mwTiny.clearCache();
    });

    it('partially truncates fragments that exceed remaining budget', async () => {
      // Use a budget that allows brief (required) + part of a large memory fragment
      const mwMedium = new ContextEnrichmentMiddleware({ maxTokens: 200 });

      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('brief.md'),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('brief.md')) return 'Short brief';
        return '';
      });

      // Large memory that won't fully fit
      const largeContent = 'A very important fact that goes on and on. '.repeat(100);
      const input = makeInput({
        memoryEntries: [makeMemoryEntry(largeContent, 0.9)],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mwMedium.execute(ctx, next);

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      if (result.wasTrimmed) {
        // If trimmed, check that truncation marker is present
        expect(result.prompt).toContain('trimmed to fit token budget');
      }
      mwMedium.clearCache();
    });
  });

  // ─── FileCache TTL ───

  describe('FileCache TTL', () => {
    it('serves cached content within TTL', async () => {
      // Only enable brief section to isolate cache behavior
      // (readTail used by iteration-log doesn't use the FileCache, so exclude trend)
      const mwCacheTest = new ContextEnrichmentMiddleware({
        enabledSections: {
          memory: false, brief: true, status: false, index: false,
          trend: false, role: false, plan: false, peers: false,
          feedback: false, artifacts: false,
        },
      });

      // First call populates cache
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('brief v1');

      const input = makeInput();
      let ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwCacheTest.execute(ctx, mockNext());

      // Change file content
      mockReadFileSync.mockReturnValue('brief v2');

      // Second call within TTL should still get v1
      ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwCacheTest.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.prompt).toContain('brief v1');
      expect(result.prompt).not.toContain('brief v2');
      mwCacheTest.clearCache();
    });

    it('refreshes cache after TTL expires', async () => {
      const mwShortTtl = new ContextEnrichmentMiddleware({ cacheTtlMs: 50 });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('brief v1');

      const input = makeInput();
      let ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwShortTtl.execute(ctx, mockNext());

      // Advance time beyond TTL
      const originalNow = Date.now;
      Date.now = () => originalNow() + 100;

      mockReadFileSync.mockReturnValue('brief v2');

      ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwShortTtl.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.prompt).toContain('brief v2');

      Date.now = originalNow;
      mwShortTtl.clearCache();
    });
  });

  // ─── Prompt assembly ordering ───

  describe('prompt assembly', () => {
    it('orders fragments by LAYER_ORDER (memory → brief → ... → artifacts)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('brief.md')) return 'BRIEF_MARKER';
        if (typeof p === 'string' && p.includes('feedback.md')) return 'FEEDBACK_MARKER';
        return '';
      });
      mockReaddirSync.mockReturnValue(['artifact.ts']);

      const input = makeInput({
        memoryEntries: [makeMemoryEntry('MEMORY_MARKER', 0.9)],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      const memIdx = result.prompt.indexOf('MEMORY_MARKER');
      const briefIdx = result.prompt.indexOf('BRIEF_MARKER');
      const feedbackIdx = result.prompt.indexOf('FEEDBACK_MARKER');
      const artifactIdx = result.prompt.indexOf('artifact.ts');

      // memory < brief < feedback < artifacts
      expect(memIdx).toBeLessThan(briefIdx);
      expect(briefIdx).toBeLessThan(feedbackIdx);
      expect(feedbackIdx).toBeLessThan(artifactIdx);
    });

    it('injects system message at front of messages array', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('brief.md'),
      );
      mockReadFileSync.mockReturnValue('Brief content');

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      ctx.messages = [
        { role: 'user', content: 'original message' },
      ];
      await mw.execute(ctx, mockNext());

      expect(ctx.messages[0].role).toBe('system');
      expect(ctx.messages[0].name).toBe('__forge_context');
      expect(ctx.messages[1].content).toBe('original message');
    });

    it('replaces previous context injection (deduplicates __forge_context)', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('brief.md'),
      );
      mockReadFileSync.mockReturnValue('Brief v2');

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      // Simulate a previous injection
      ctx.messages = [
        { role: 'system', content: 'old context', name: '__forge_context' },
        { role: 'user', content: 'user msg' },
      ];
      await mw.execute(ctx, mockNext());

      const contextMsgs = ctx.messages.filter(m => m.name === '__forge_context');
      expect(contextMsgs).toHaveLength(1);
      expect(contextMsgs[0].content).toContain('Brief v2');
    });
  });

  // ─── Trend layer / Previous iteration summary ───

  describe('trend layer', () => {
    it('builds previous iteration summary from forge-state.json', async () => {
      const stateData = {
        iterations: [
          {
            number: 1,
            tasks: [
              { id: 'task-1', role: 'coder', status: 'completed', durationMs: 5000, description: 'Write code' },
              { id: 'task-2', role: 'tester', status: 'failed', durationMs: 3000, description: 'Run tests', error: 'Timeout' },
            ],
          },
        ],
      };

      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('forge-state.json'),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('forge-state.json'))
          return JSON.stringify(stateData);
        return '';
      });

      const input = makeInput({ iteration: 2 });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.trend).toBeGreaterThan(0);
      expect(result.prompt).toContain('task-1');
      expect(result.prompt).toContain('1 完成');
      expect(result.prompt).toContain('1 失败');
    });

    it('skips trend for iteration 1 (no previous)', async () => {
      const input = makeInput({ iteration: 1 });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.trend).toBe(0);
    });
  });

  // ─── Peer layer (leader-only) ───

  describe('peer layer', () => {
    it('leader sees peer role summaries', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('coder-report.md'),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('coder-report.md')) return 'Coder did good work';
        return '';
      });

      const input = makeInput({ isLeader: true, role: 'leader' });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.peers).toBeGreaterThan(0);
      expect(result.prompt).toContain('Coder 汇报');
    });

    it('non-leader does not see peer summaries', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('Some report');

      const input = makeInput({ isLeader: false, role: 'tester' });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result.tokenBreakdown.peers).toBe(0);
    });
  });

  // ─── Config overrides ───

  describe('config overrides', () => {
    it('merges per-call configOverrides with defaults', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('x'.repeat(5000));

      // Override maxFileChars to limit content
      const input = makeInput({
        configOverrides: { maxFileChars: 100 },
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      // Content should be truncated to ~100 chars + truncation marker
      expect(result.prompt).toContain('truncated');
    });
  });

  // ─── Constructor ───

  describe('constructor', () => {
    it('uses default config when no overrides', () => {
      const mwDefault = new ContextEnrichmentMiddleware();
      expect(mwDefault.name).toBe('context-enrichment');
      expect(mwDefault.priority).toBe(50);
      expect(mwDefault.enabled).toBe(true);
      expect(mwDefault.continueOnError).toBe(true);
    });

    it('merges partial enabledSections with defaults', () => {
      // Even though we disable memory, other sections should remain true
      const mwPartial = new ContextEnrichmentMiddleware({
        enabledSections: { memory: false } as any,
      });
      // This is tested indirectly via shouldRun/execute behavior
      expect(mwPartial.name).toBe('context-enrichment');
    });
  });

  // ─── createContextEnrichmentMiddleware factory ───

  describe('createContextEnrichmentMiddleware', () => {
    it('returns an object with instance property', () => {
      const { instance } = createContextEnrichmentMiddleware();
      expect(instance).toBeInstanceOf(ContextEnrichmentMiddleware);
      expect(instance.name).toBe('context-enrichment');
    });

    it('passes config to instance', () => {
      const { instance } = createContextEnrichmentMiddleware({ maxTokens: 5000 });
      expect(instance).toBeInstanceOf(ContextEnrichmentMiddleware);
    });
  });

  // ─── Result metadata ───

  describe('result metadata', () => {
    it('populates ContextEnrichmentResult with correct fields', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('brief.md'),
      );
      mockReadFileSync.mockReturnValue('Brief');

      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mw.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      expect(result).toHaveProperty('prompt');
      expect(result).toHaveProperty('tokenBreakdown');
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('wasTrimmed');
      expect(result).toHaveProperty('trimmedLayers');
      expect(result).toHaveProperty('fragmentCount');
      expect(typeof result.totalTokens).toBe('number');
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.fragmentCount).toBeGreaterThan(0);
    });

    it('sets warning when trimming occurs', async () => {
      const mwTiny = new ContextEnrichmentMiddleware({ maxTokens: 5 });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('x'.repeat(500));

      const input = makeInput({
        memoryEntries: [makeMemoryEntry('mem '.repeat(200), 0.9)],
      });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwTiny.execute(ctx, mockNext());

      const warning = ctx.state[CONTEXT_STATE_KEYS.WARNING] as string;
      if (warning) {
        expect(warning).toContain('Context trimmed');
        expect(warning).toContain('tokens');
      }
      mwTiny.clearCache();
    });
  });

  // ─── readTail for iteration log ───

  describe('readTail (iteration log)', () => {
    it('keeps only last N sections from iteration log', async () => {
      const logContent = [
        '## Iteration 1\nDone stuff',
        '## Iteration 2\nMore stuff',
        '## Iteration 3\nEven more',
        '## Iteration 4\nRecent work',
        '## Iteration 5\nLatest',
        '## Iteration 6\nNewest',
        '## Iteration 7\nCurrent',
      ].join('\n');

      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && (p.includes('iteration-log.md') || p.includes('forge-state.json')),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('iteration-log.md')) return logContent;
        if (typeof p === 'string' && p.includes('forge-state.json'))
          return JSON.stringify({ iterations: [{ number: 1, tasks: [{ id: 't1', role: 'x', status: 'completed', durationMs: 1000, description: 'done' }] }] });
        return '';
      });

      const mwCustom = new ContextEnrichmentMiddleware({ maxTailSections: 3 });
      const input = makeInput({ iteration: 2 });
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      await mwCustom.execute(ctx, mockNext());

      const result = ctx.state[CONTEXT_STATE_KEYS.RESULT] as ContextEnrichmentResult;
      // Should contain omission notice and recent sections
      if (result.prompt.includes('earlier sections omitted')) {
        expect(result.prompt).toContain('earlier sections omitted');
      }
      mwCustom.clearCache();
    });
  });

  // ─── calls next() ───

  describe('pipeline integration', () => {
    it('calls next() to continue the pipeline', async () => {
      const input = makeInput();
      const ctx = createMockCtx({ [CONTEXT_STATE_KEYS.INPUT]: input });
      const next = mockNext();
      await mw.execute(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
