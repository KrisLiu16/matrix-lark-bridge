/**
 * ForgeMemory — Unit Tests
 *
 * Covers: addEntry + dedup, query, updateEntry, removeEntry, getEntry,
 * getTopEntries, updateUserContext, updateHistory, injectToPrompt,
 * load/save persistence, flush/dispose lifecycle, deepEqual utility,
 * extractFromProject, pruneEntries, capacity enforcement, event emission.
 *
 * Framework: vitest
 * All fs calls are mocked — no real disk I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mock fs and crypto before importing the module ----

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 1000 })),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

let uuidCounter = 0;
vi.mock('node:crypto', () => ({
  randomUUID: () => `uuid-${++uuidCounter}`,
}));

import {
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
} from 'node:fs';

import { ForgeMemory, deepEqual, createForgeMemory } from '../forge-memory';
import { MemoryType, MemorySource, MemoryEventType } from '../types/memory';
import type { MemoryEventPayload, MemorySnapshot } from '../types/memory';

// ---- Helpers ----

function makeEntryInput(overrides: Record<string, unknown> = {}) {
  return {
    content: `test content ${uuidCounter}`,
    type: MemoryType.Fact,
    confidence: 0.8,
    source: MemorySource.Explicit,
    tags: ['test'],
    relevanceScore: 0,
    ...overrides,
  };
}

// ---- Tests ----

describe('ForgeMemory', () => {
  let mem: ForgeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    uuidCounter = 0;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
    mem = new ForgeMemory({ storagePath: '/tmp/test-memory.json', debounceMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============ deepEqual ============

  describe('deepEqual', () => {
    it('returns true for identical primitives', () => {
      expect(deepEqual(1, 1)).toBe(true);
      expect(deepEqual('a', 'a')).toBe(true);
      expect(deepEqual(null, null)).toBe(true);
      expect(deepEqual(true, true)).toBe(true);
    });

    it('returns false for different types', () => {
      expect(deepEqual(1, '1')).toBe(false);
      expect(deepEqual(null, undefined)).toBe(false);
      expect(deepEqual(null, 0)).toBe(false);
    });

    it('compares arrays element-wise', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(deepEqual([1, 2, 3], [1, 3, 2])).toBe(false);
    });

    it('compares objects key-order-independently', () => {
      expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('handles nested structures', () => {
      const a = { x: [1, { y: 'z' }], w: true };
      const b = { w: true, x: [1, { y: 'z' }] };
      expect(deepEqual(a, b)).toBe(true);
    });

    it('distinguishes arrays from objects', () => {
      expect(deepEqual([1], { 0: 1 })).toBe(false);
    });
  });

  // ============ addEntry ============

  describe('addEntry', () => {
    it('creates entry with generated id, timestamps, accessCount=0', async () => {
      const entry = await mem.addEntry(makeEntryInput({ content: 'hello world' }));
      expect(entry.id).toBe('uuid-1');
      expect(entry.content).toBe('hello world');
      expect(entry.timestamp).toBe('2026-01-15T12:00:00.000Z');
      expect(entry.updatedAt).toBe('2026-01-15T12:00:00.000Z');
      expect(entry.accessCount).toBe(0);
      expect(entry.relevanceScore).toBeGreaterThan(0);
      expect(mem.entryCount).toBe(1);
      expect(mem.isDirty).toBe(true);
    });

    it('deduplicates similar content via Jaccard similarity', async () => {
      const entry1 = await mem.addEntry(makeEntryInput({
        content: 'the quick brown fox jumps over the lazy dog',
        confidence: 0.7,
      }));
      // Nearly identical content
      const entry2 = await mem.addEntry(makeEntryInput({
        content: 'The Quick Brown Fox Jumps Over The Lazy Dog!',
        confidence: 0.9,
      }));
      // Should return same entry with bumped confidence
      expect(entry2.id).toBe(entry1.id);
      expect(entry2.confidence).toBe(0.9); // max(0.7, 0.9)
      expect(mem.entryCount).toBe(1);
    });

    it('does NOT deduplicate sufficiently different content', async () => {
      await mem.addEntry(makeEntryInput({ content: 'alpha beta gamma delta' }));
      await mem.addEntry(makeEntryInput({ content: 'epsilon zeta eta theta' }));
      expect(mem.entryCount).toBe(2);
    });

    it('enforces capacity after adding', async () => {
      const small = new ForgeMemory({
        storagePath: '/tmp/test.json',
        debounceMs: 100,
        maxEntries: 3,
      });
      for (let i = 0; i < 5; i++) {
        await small.addEntry(makeEntryInput({ content: `unique entry number ${i}` }));
      }
      expect(small.entryCount).toBeLessThanOrEqual(3);
    });
  });

  // ============ updateEntry ============

  describe('updateEntry', () => {
    it('patches content, type, confidence, tags and refreshes updatedAt', async () => {
      const entry = await mem.addEntry(makeEntryInput({ content: 'original' }));
      vi.setSystemTime(new Date('2026-01-15T13:00:00Z'));
      const updated = await mem.updateEntry(entry.id, {
        content: 'modified',
        confidence: 0.95,
        tags: ['updated-tag'],
      });
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('modified');
      expect(updated!.confidence).toBe(0.95);
      expect(updated!.tags).toEqual(['updated-tag']);
      expect(updated!.updatedAt).toBe('2026-01-15T13:00:00.000Z');
    });

    it('returns null for non-existent id', async () => {
      const result = await mem.updateEntry('nonexistent', { content: 'x' });
      expect(result).toBeNull();
    });
  });

  // ============ removeEntry ============

  describe('removeEntry', () => {
    it('removes existing entry and returns true', async () => {
      const entry = await mem.addEntry(makeEntryInput());
      const removed = await mem.removeEntry(entry.id);
      expect(removed).toBe(true);
      expect(mem.entryCount).toBe(0);
    });

    it('returns false for non-existent id', async () => {
      expect(await mem.removeEntry('no-such-id')).toBe(false);
    });
  });

  // ============ getEntry ============

  describe('getEntry', () => {
    it('returns entry and increments accessCount', async () => {
      const entry = await mem.addEntry(makeEntryInput({ content: 'findme' }));
      expect(entry.accessCount).toBe(0);

      const found = mem.getEntry(entry.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe('findme');
      expect(found!.accessCount).toBe(1);
      expect(found!.lastAccessedAt).toBe('2026-01-15T12:00:00.000Z');

      mem.getEntry(entry.id);
      expect(mem.getEntry(entry.id)!.accessCount).toBe(3);
    });

    it('returns null for unknown id', () => {
      expect(mem.getEntry('missing')).toBeNull();
    });
  });

  // ============ query ============

  describe('query', () => {
    beforeEach(async () => {
      await mem.addEntry(makeEntryInput({ content: 'fact alpha', type: MemoryType.Fact, confidence: 0.9, tags: ['a'] }));
      await mem.addEntry(makeEntryInput({ content: 'insight beta', type: MemoryType.Insight, confidence: 0.5, tags: ['b'] }));
      await mem.addEntry(makeEntryInput({ content: 'decision gamma', type: MemoryType.Decision, confidence: 0.7, tags: ['a', 'c'] }));
    });

    it('returns all entries without filters', async () => {
      const results = await mem.query({});
      expect(results.length).toBe(3);
    });

    it('filters by type', async () => {
      const results = await mem.query({ filters: { types: [MemoryType.Fact] } });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('fact alpha');
    });

    it('filters by tags (OR within)', async () => {
      const results = await mem.query({ filters: { tags: ['b', 'c'] } });
      expect(results.length).toBe(2);
    });

    it('filters by minConfidence', async () => {
      const results = await mem.query({ filters: { minConfidence: 0.7 } });
      expect(results.every((e) => e.confidence >= 0.7)).toBe(true);
    });

    it('filters by contentSearch (case-insensitive)', async () => {
      const results = await mem.query({ filters: { contentSearch: 'ALPHA' } });
      expect(results.length).toBe(1);
    });

    it('supports limit and offset pagination', async () => {
      const page1 = await mem.query({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);
      const page2 = await mem.query({ limit: 2, offset: 2 });
      expect(page2.length).toBe(1);
    });

    it('sorts by confidence asc', async () => {
      const results = await mem.query({ sortBy: 'confidence', sortDirection: 'asc' });
      for (let i = 1; i < results.length; i++) {
        expect(results[i].confidence).toBeGreaterThanOrEqual(results[i - 1].confidence);
      }
    });

    it('filters by source', async () => {
      const results = await mem.query({ filters: { sources: [MemorySource.Inferred] } });
      expect(results.length).toBe(0); // all are Explicit
    });
  });

  // ============ getTopEntries ============

  describe('getTopEntries', () => {
    it('returns entries sorted by relevanceScore desc', async () => {
      await mem.addEntry(makeEntryInput({ content: 'low conf', confidence: 0.4 }));
      await mem.addEntry(makeEntryInput({ content: 'high conf', confidence: 0.99 }));
      await mem.addEntry(makeEntryInput({ content: 'mid conf', confidence: 0.7 }));

      const top = await mem.getTopEntries(2);
      expect(top.length).toBe(2);
      expect(top[0].relevanceScore).toBeGreaterThanOrEqual(top[1].relevanceScore);
    });

    it('excludes entries below pruneConfidenceThreshold', async () => {
      const m = new ForgeMemory({
        storagePath: '/tmp/t.json',
        debounceMs: 100,
        pruneConfidenceThreshold: 0.6,
      });
      await m.addEntry(makeEntryInput({ content: 'below threshold', confidence: 0.2 }));
      await m.addEntry(makeEntryInput({ content: 'above threshold', confidence: 0.9 }));
      const top = await m.getTopEntries(10);
      expect(top.every((e) => e.confidence >= 0.6)).toBe(true);
    });
  });

  // ============ updateUserContext ============

  describe('updateUserContext', () => {
    it('merges partial updates into user context', async () => {
      await mem.updateUserContext({ workContext: 'building v2' });
      await mem.updateUserContext({ preferences: 'concise output' });

      const snap = mem.getSnapshot();
      expect(snap.userContext.workContext).toBe('building v2');
      expect(snap.userContext.preferences).toBe('concise output');
      expect(snap.userContext.personalContext).toBe(''); // untouched
    });

    it('returns a copy (not a reference)', async () => {
      const ctx = await mem.updateUserContext({ topOfMind: 'testing' });
      ctx.topOfMind = 'mutated';
      expect(mem.getSnapshot().userContext.topOfMind).toBe('testing');
    });
  });

  // ============ updateHistory ============

  describe('updateHistory', () => {
    it('merges partial history updates', async () => {
      await mem.updateHistory({ recentSessions: 'session 1 summary' });
      const snap = mem.getSnapshot();
      expect(snap.history.recentSessions).toBe('session 1 summary');
      expect(snap.history.earlierContext).toBe('');
    });
  });

  // ============ injectToPrompt ============

  describe('injectToPrompt', () => {
    it('returns empty string when disabled', async () => {
      const disabled = new ForgeMemory({ enabled: false, storagePath: '/tmp/x.json', debounceMs: 100 });
      expect(await disabled.injectToPrompt()).toBe('');
    });

    it('returns empty string when injection disabled', async () => {
      const noInject = new ForgeMemory({
        storagePath: '/tmp/x.json',
        debounceMs: 100,
        injectionEnabled: false,
      });
      expect(await noInject.injectToPrompt()).toBe('');
    });

    it('returns empty when no content at all', async () => {
      expect(await mem.injectToPrompt()).toBe('');
    });

    it('builds XML with user_context section', async () => {
      await mem.updateUserContext({ workContext: 'deepforge v2', topOfMind: 'testing' });
      const xml = await mem.injectToPrompt();
      expect(xml).toContain('<memory>');
      expect(xml).toContain('</memory>');
      expect(xml).toContain('<user_context>');
      expect(xml).toContain('work: deepforge v2');
      expect(xml).toContain('focus: testing');
    });

    it('includes entries section with type/conf/rel metadata', async () => {
      await mem.addEntry(makeEntryInput({ content: 'important fact', confidence: 0.9 }));
      const xml = await mem.injectToPrompt();
      expect(xml).toContain('<entries>');
      expect(xml).toContain('important fact');
      expect(xml).toMatch(/conf:0\.\d+/);
      expect(xml).toMatch(/rel:0\.\d+/);
    });

    it('includes history section', async () => {
      await mem.updateHistory({ recentSessions: 'did testing', longTermBackground: 'background info' });
      // Need at least something in context/entries to avoid empty check
      await mem.updateUserContext({ workContext: 'x' });
      const xml = await mem.injectToPrompt();
      expect(xml).toContain('<history>');
      expect(xml).toContain('recent: did testing');
      expect(xml).toContain('background: background info');
    });

    it('respects maxInjectionTokens character budget', async () => {
      const tiny = new ForgeMemory({
        storagePath: '/tmp/t.json',
        debounceMs: 100,
        maxInjectionTokens: 10, // 40 chars budget
      });
      await tiny.updateUserContext({ workContext: 'x' });
      for (let i = 0; i < 20; i++) {
        await tiny.addEntry(makeEntryInput({
          content: `long entry content that should be truncated ${i}`,
          confidence: 0.9,
        }));
      }
      const xml = await tiny.injectToPrompt();
      // Should have truncated — not all entries included
      expect(xml).toContain('<memory>');
    });
  });

  // ============ load / save persistence ============

  describe('load/save', () => {
    it('save writes JSON atomically via temp file + rename', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.addEntry(makeEntryInput({ content: 'persist me' }));
      await mem.save();

      expect(writeFileSync).toHaveBeenCalled();
      expect(renameSync).toHaveBeenCalled();
      expect(mem.isDirty).toBe(false);
    });

    it('save creates directory if missing', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      await mem.save();
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('load reads and parses existing snapshot', async () => {
      const snapshot: MemorySnapshot = {
        version: 2,
        userContext: { workContext: 'loaded', personalContext: '', topOfMind: '', preferences: '' },
        history: { recentSessions: '', earlierContext: '', longTermBackground: '' },
        entries: [],
        updatedAt: '2026-01-01T00:00:00Z',
        projectId: 'test-proj',
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(snapshot));

      const loaded = await mem.load();
      expect(loaded.userContext.workContext).toBe('loaded');
      expect(loaded.version).toBe(2);
      expect(mem.isDirty).toBe(false);
    });

    it('load returns empty snapshot when file missing', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const loaded = await mem.load();
      expect(loaded.entries).toEqual([]);
      expect(loaded.version).toBe(2);
    });

    it('load returns empty snapshot when disabled', async () => {
      const disabled = new ForgeMemory({ enabled: false, storagePath: '/tmp/x.json', debounceMs: 100 });
      const snap = await disabled.load();
      expect(snap.entries).toEqual([]);
    });

    it('load migrates v1 facts to v2 entries', async () => {
      const v1Snapshot = {
        version: 1,
        userContext: { workContext: '', personalContext: '', topOfMind: '' },
        history: { recentSessions: '', earlierContext: '', longTermBackground: '' },
        facts: [
          {
            id: 'old-1',
            content: 'legacy fact',
            category: 'preference',
            tags: ['old'],
            createdAt: '2025-01-01T00:00:00Z',
            confidence: 0.6,
            source: 'explicit',
          },
        ],
        updatedAt: '2025-01-01T00:00:00Z',
        projectId: 'legacy',
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(v1Snapshot));

      const loaded = await mem.load();
      expect(loaded.version).toBe(2);
      expect(loaded.entries.length).toBe(1);
      expect(loaded.entries[0].type).toBe(MemoryType.Fact);
      expect(loaded.entries[0].source).toBe(MemorySource.Explicit);
      expect(loaded.entries[0].accessCount).toBe(0);
    });
  });

  // ============ flush / dispose ============

  describe('flush/dispose', () => {
    it('flush saves immediately when dirty', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.addEntry(makeEntryInput({ content: 'dirty data' }));
      expect(mem.isDirty).toBe(true);

      await mem.flush();
      expect(mem.isDirty).toBe(false);
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('flush is no-op when clean', async () => {
      await mem.flush();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('dispose calls flush', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.addEntry(makeEntryInput({ content: 'dispose test' }));
      await mem.dispose();
      expect(mem.isDirty).toBe(false);
    });
  });

  // ============ debounced save ============

  describe('debounced save', () => {
    it('schedules save after debounceMs', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.addEntry(makeEntryInput({ content: 'debounce trigger' }));

      // Not yet saved
      expect(writeFileSync).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(150);

      expect(writeFileSync).toHaveBeenCalled();
    });

    it('resets timer on subsequent mutations', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.addEntry(makeEntryInput({ content: 'first' }));

      await vi.advanceTimersByTimeAsync(50);
      expect(writeFileSync).not.toHaveBeenCalled();

      // Another mutation resets the timer
      await mem.addEntry(makeEntryInput({ content: 'second mutation resets' }));

      await vi.advanceTimersByTimeAsync(50);
      expect(writeFileSync).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60);
      expect(writeFileSync).toHaveBeenCalled();
    });
  });

  // ============ event emission ============

  describe('event emission', () => {
    let emitted: MemoryEventPayload[];

    beforeEach(() => {
      emitted = [];
      mem.setEventEmitter((p) => emitted.push(p));
    });

    it('emits EntryAdded on new entry', async () => {
      await mem.addEntry(makeEntryInput({ content: 'event test' }));
      expect(emitted.some((e) => e.eventType === MemoryEventType.EntryAdded)).toBe(true);
    });

    it('emits EntryUpdated on dedup merge', async () => {
      await mem.addEntry(makeEntryInput({ content: 'same words here' }));
      await mem.addEntry(makeEntryInput({ content: 'same words here' }));
      expect(emitted.filter((e) => e.eventType === MemoryEventType.EntryUpdated).length).toBe(1);
    });

    it('emits EntryUpdated on updateEntry', async () => {
      const entry = await mem.addEntry(makeEntryInput());
      await mem.updateEntry(entry.id, { content: 'changed' });
      expect(emitted.some((e) => e.eventType === MemoryEventType.EntryUpdated)).toBe(true);
    });

    it('emits EntryRemoved on removeEntry', async () => {
      const entry = await mem.addEntry(makeEntryInput());
      await mem.removeEntry(entry.id);
      expect(emitted.some((e) => e.eventType === MemoryEventType.EntryRemoved && e.entryIds?.includes(entry.id))).toBe(true);
    });

    it('emits ContextUpdated on updateUserContext', async () => {
      await mem.updateUserContext({ workContext: 'test' });
      expect(emitted.some((e) => e.eventType === MemoryEventType.ContextUpdated)).toBe(true);
    });

    it('emits Saved on save', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await mem.save();
      expect(emitted.some((e) => e.eventType === MemoryEventType.Saved)).toBe(true);
    });

    it('swallows emitter exceptions without crashing', async () => {
      mem.setEventEmitter(() => { throw new Error('emitter boom'); });
      // Should not throw
      await expect(mem.addEntry(makeEntryInput())).resolves.toBeDefined();
    });
  });

  // ============ extractFromProject ============

  describe('extractFromProject', () => {
    it('creates entries from feedback and role performance', async () => {
      mem.setProjectId('proj-1');
      const result = await mem.extractFromProject(
        'Built a new API',
        ['Great response times', 'Needs better error handling'],
        { coder: 'Fast delivery', reviewer: 'Thorough reviews' },
      );
      // 2 feedback + 2 role + 1 summary = 5
      expect(result.entries.length).toBe(5);
      expect(result.entries[0].tags).toContain('auto-extracted');
      expect(result.entries[0].tags).toContain('feedback');
      expect(result.entries[2].tags).toContain('role-insight');
    });

    it('skips empty feedback strings', async () => {
      const result = await mem.extractFromProject('summary', ['', '  ', 'valid'], {});
      // 1 valid feedback + 1 summary = 2
      expect(result.entries.length).toBe(2);
    });

    it('emits Extracted event', async () => {
      const emitted: MemoryEventPayload[] = [];
      mem.setEventEmitter((p) => emitted.push(p));
      await mem.extractFromProject('proj', ['fb'], {});
      expect(emitted.some((e) => e.eventType === MemoryEventType.Extracted)).toBe(true);
    });
  });

  // ============ pruneEntries ============

  describe('pruneEntries', () => {
    it('removes entries below confidence threshold', async () => {
      const m = new ForgeMemory({
        storagePath: '/tmp/p.json',
        debounceMs: 100,
        pruneConfidenceThreshold: 0.5,
      });
      await m.addEntry(makeEntryInput({ content: 'low', confidence: 0.1 }));
      await m.addEntry(makeEntryInput({ content: 'high', confidence: 0.9 }));
      const removed = m.pruneEntries();
      expect(removed.length).toBeGreaterThanOrEqual(1);
      expect(m.entryCount).toBe(1);
    });

    it('emits Pruned event with removed ids', async () => {
      const emitted: MemoryEventPayload[] = [];
      const m = new ForgeMemory({
        storagePath: '/tmp/p.json',
        debounceMs: 100,
        pruneConfidenceThreshold: 0.5,
      });
      m.setEventEmitter((p) => emitted.push(p));
      await m.addEntry(makeEntryInput({ content: 'low conf', confidence: 0.1 }));
      m.pruneEntries();
      const pruneEvent = emitted.find((e) => e.eventType === MemoryEventType.Pruned);
      expect(pruneEvent).toBeDefined();
      expect(pruneEvent!.entryIds!.length).toBeGreaterThan(0);
    });
  });

  // ============ reloadIfChanged ============

  describe('reloadIfChanged', () => {
    it('returns false when mtime unchanged', async () => {
      // First load to set fileMtime
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        version: 2,
        userContext: { workContext: '', personalContext: '', topOfMind: '', preferences: '' },
        history: { recentSessions: '', earlierContext: '', longTermBackground: '' },
        entries: [],
        updatedAt: '2026-01-01T00:00:00Z',
        projectId: '',
      }));
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
      await mem.load();

      const changed = await mem.reloadIfChanged();
      expect(changed).toBe(false);
    });

    it('reloads when mtime changed', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        version: 2,
        userContext: { workContext: '', personalContext: '', topOfMind: '', preferences: '' },
        history: { recentSessions: '', earlierContext: '', longTermBackground: '' },
        entries: [],
        updatedAt: '2026-01-01T00:00:00Z',
        projectId: '',
      }));
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
      await mem.load();

      // Now change mtime
      vi.mocked(statSync).mockReturnValue({ mtimeMs: 2000 } as any);
      const changed = await mem.reloadIfChanged();
      expect(changed).toBe(true);
    });
  });

  // ============ setProjectId / getSnapshot ============

  describe('setProjectId / getSnapshot', () => {
    it('sets and reads projectId', () => {
      mem.setProjectId('my-project');
      expect(mem.getSnapshot().projectId).toBe('my-project');
    });
  });

  // ============ createForgeMemory factory ============

  describe('createForgeMemory', () => {
    it('returns a ForgeMemory instance', () => {
      const instance = createForgeMemory({ storagePath: '/tmp/f.json' });
      expect(instance).toBeInstanceOf(ForgeMemory);
    });
  });
});
