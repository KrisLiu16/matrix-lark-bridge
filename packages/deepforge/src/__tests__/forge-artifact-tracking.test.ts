/**
 * DeepForge 2.0 — ArtifactTrackingMiddleware Unit Tests
 *
 * Covers:
 * - Constructor & config defaults
 * - shouldRun guard (fs existence check)
 * - Filesystem snapshot + diff (added/modified/removed)
 * - Message scanning for artifact references
 * - ArtifactRegistry CRUD (registerArtifact, merge semantics)
 * - mergeArtifacts deduplication (via execute)
 * - Query API: getByCategory / getByCreator / getByPath / getEntries / totalCount
 * - Event emission (artifact:added / artifact:modified / artifact:removed)
 * - classifyArtifact (directory-based, extension-based, test pattern)
 * - createArtifactTracker factory
 *
 * @module __tests__/forge-artifact-tracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and path before importing the module
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  relative: vi.fn((from: string, to: string) => {
    if (to.startsWith(from)) {
      const result = to.slice(from.length);
      return result.startsWith('/') ? result.slice(1) : result;
    }
    return to;
  }),
  extname: vi.fn((p: string) => {
    const parts = p.split('.');
    return parts.length > 1 ? '.' + parts.pop() : '';
  }),
}));

import type { Dirent, Stats } from 'node:fs';
import { readdirSync, statSync, existsSync } from 'node:fs';
import type { MiddlewareContext, MiddlewareNext } from '../types/middleware';
import {
  ArtifactTrackingMiddleware,
  createArtifactTracker,
  type ArtifactEventEmitter,
  type ArtifactCategory,
} from '../forge-artifact-tracking';

// ── Helpers ──

/** Build a minimal MiddlewareContext for testing */
function makeCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    messages: [],
    config: {
      projectId: 'test-project',
      model: 'test-model',
      effort: 'normal',
      maxConcurrent: 3,
      phase: 'executing',
    },
    iteration: undefined,
    state: {},
    metadata: {
      runId: 'run-1',
      chain: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      timing: {},
      aborted: false,
    },
    ...overrides,
  };
}

/** Artifact tracking summary shape stored in ctx.state */
interface ArtifactSummary {
  added: string[];
  modified: string[];
  removed: string[];
  totalArtifacts: number;
}

/** Extract typed summary from ctx.state */
function getSummary(state: Record<string, unknown>): ArtifactSummary {
  return state['artifact-tracking:summary'] as ArtifactSummary;
}

/** Type-safe mock helper: avoids TS2345 on readdirSync overload mismatch */
const mockReaddirSync = vi.mocked(readdirSync) as unknown as {
  mockImplementation: (fn: (...args: unknown[]) => Dirent[]) => void;
  mockReturnValue: (val: Dirent[]) => void;
};

/** Create a mock Dirent-like object for readdirSync (cast once here) */
function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '',
    path: '',
  } as Dirent;
}

/** Create an array of mock Dirent objects (properly typed for readdirSync mock) */
function makeDirents(...entries: Array<[name: string, isDir: boolean]>): Dirent[] {
  return entries.map(([name, isDir]) => makeDirent(name, isDir));
}

/** Create a mock stat result (cast once here) */
function makeStat(size: number, mtimeMs: number): Stats {
  return { size, mtimeMs } as Stats;
}

function createMockEmitter(): ArtifactEventEmitter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    emit: vi.fn((event) => {
      calls.push(event);
    }),
  };
}

// ── Tests ──

describe('ArtifactTrackingMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────
  // 1. Constructor & static properties
  // ──────────────────────────────────────────

  describe('constructor & defaults', () => {
    it('sets default config values', () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      expect(tracker.name).toBe('artifact-tracking');
      expect(tracker.priority).toBe(65);
      expect(tracker.enabled).toBe(true);
      expect(tracker.continueOnError).toBe(true);
      expect(tracker.timeout).toBe(10_000);
      expect(tracker.totalCount).toBe(0);
    });

    it('respects custom config', () => {
      const tracker = new ArtifactTrackingMiddleware({
        projectRoot: '/proj',
        artifactsDir: 'out',
        ignoreDirs: ['dist'],
        defaultRole: 'builder',
      });
      // Verify via registerArtifact which uses defaultRole
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      const record = tracker.registerArtifact('out/foo.ts');
      expect(record.creator).toBe('builder');
    });
  });

  // ──────────────────────────────────────────
  // 2. shouldRun guard
  // ──────────────────────────────────────────

  describe('shouldRun', () => {
    it('returns true when artifacts dir exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      const ctx = makeCtx();
      expect(tracker.shouldRun(ctx)).toBe(true);
      expect(existsSync).toHaveBeenCalledWith('/proj/artifacts');
    });

    it('returns false when artifacts dir does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      expect(tracker.shouldRun(makeCtx())).toBe(false);
    });

    it('uses custom artifactsDir in path check', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const tracker = new ArtifactTrackingMiddleware({
        projectRoot: '/proj',
        artifactsDir: 'output',
      });
      tracker.shouldRun(makeCtx());
      expect(existsSync).toHaveBeenCalledWith('/proj/output');
    });
  });

  // ──────────────────────────────────────────
  // 3. Filesystem snapshot + diff
  // ──────────────────────────────────────────

  describe('execute — filesystem diff', () => {
    it('detects newly added files', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      const emitter = createMockEmitter();
      const trackerWithEmitter = new ArtifactTrackingMiddleware(
        { projectRoot: '/proj' },
        emitter,
      );

      let callCount = 0;
      // Before snapshot: empty dir
      // After snapshot: one new file
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return [] as Dirent[]; // before: empty
        return [makeDirent('new-file.ts', false)]; // after: one file
      });
      vi.mocked(statSync).mockReturnValue(makeStat(500, 2000));

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;

      const result = await trackerWithEmitter.execute(ctx, next);
      const summary = getSummary(result.state);

      expect(summary.added).toContain('artifacts/new-file.ts');
      expect(summary.modified).toHaveLength(0);
      expect(summary.removed).toHaveLength(0);
      expect(summary.totalArtifacts).toBe(1);

      // Event emitted
      expect(emitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'artifact:added' }),
      );
    });

    it('detects modified files (mtime changed)', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        makeDirent('file.ts', false),
      ]);

      // Before: size=100, mtime=1000; After: size=200, mtime=2000
      vi.mocked(statSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return makeStat(100, 1000);
        return makeStat(200, 2000);
      });

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);
      const summary = getSummary(result.state);

      expect(summary.modified).toContain('artifacts/file.ts');
      expect(summary.added).toHaveLength(0);
    });

    it('detects removed files', async () => {
      const emitter = createMockEmitter();
      const tracker = new ArtifactTrackingMiddleware(
        { projectRoot: '/proj' },
        emitter,
      );

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1)
          return [makeDirent('old-file.ts', false)]; // before: exists
        return [] as Dirent[]; // after: gone
      });
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);
      const summary = getSummary(result.state);

      expect(summary.removed).toContain('artifacts/old-file.ts');
      expect(emitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'artifact:removed' }),
      );
    });
  });

  // ──────────────────────────────────────────
  // 4. Message scanning — extractArtifactRefs
  // ──────────────────────────────────────────

  describe('execute — message scanning', () => {
    it('extracts artifact paths from assistant messages', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockReturnValue([] as Dirent[]);

      const ctx = makeCtx({
        messages: [
          {
            role: 'assistant',
            content: 'Created artifacts/src/new-module.ts and artifacts/design/spec.md',
          },
          {
            role: 'user',
            content: 'Also check artifacts/src/ignored.ts', // user messages ignored
          },
        ],
      });

      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);

      // Message-referenced artifacts registered with sizeBytes=0
      const record1 = tracker.getByPath('artifacts/src/new-module.ts');
      const record2 = tracker.getByPath('artifacts/design/spec.md');
      expect(record1).toBeDefined();
      expect(record1!.sizeBytes).toBe(0);
      expect(record2).toBeDefined();
    });

    it('ignores user and system messages', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockReturnValue([] as Dirent[]);

      const ctx = makeCtx({
        messages: [
          { role: 'user', content: 'Check artifacts/src/foo.ts' },
          { role: 'system', content: 'Context: artifacts/src/bar.ts' },
        ],
      });

      const next: MiddlewareNext = async () => ctx;
      await tracker.execute(ctx, next);

      expect(tracker.totalCount).toBe(0);
    });
  });

  // ──────────────────────────────────────────
  // 5. ArtifactRegistry CRUD — registerArtifact
  // ──────────────────────────────────────────

  describe('registerArtifact', () => {
    it('creates a new artifact record', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(1024, 5000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      const record = tracker.registerArtifact('src/module.ts', {
        creator: 'coder',
        description: 'A new module',
        category: 'code',
        taskId: 'task-1',
      });

      expect(record.path).toBe('src/module.ts');
      expect(record.creator).toBe('coder');
      expect(record.description).toBe('A new module');
      expect(record.type).toBe('code');
      expect(record.taskId).toBe('task-1');
      expect(record.sizeBytes).toBe(1024);
      expect(record.version).toBe(1);
      expect(record.id).toMatch(/^art-/);
    });

    it('merges existing record — bumps version', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(512, 3000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      tracker.registerArtifact('src/module.ts', { creator: 'dev-a' });
      const updated = tracker.registerArtifact('src/module.ts', {
        creator: 'dev-b',
      });

      expect(updated.version).toBe(2);
      expect(updated.creator).toBe('dev-b');
      expect(tracker.totalCount).toBe(1); // no duplicate
    });

    it('handles missing file gracefully (sizeBytes=0)', () => {
      vi.mocked(statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      const record = tracker.registerArtifact('future/planned.ts');
      expect(record.sizeBytes).toBe(0);
    });

    it('applies description and category overrides after merge', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      tracker.registerArtifact('data/results.json');
      const record = tracker.registerArtifact('data/results.json', {
        description: 'Benchmark results',
        category: 'analysis',
      });

      expect(record.description).toBe('Benchmark results');
      expect(record.type).toBe('analysis'); // overridden from 'data'
    });
  });

  // ──────────────────────────────────────────
  // 6. mergeArtifacts deduplication
  // ──────────────────────────────────────────

  describe('deduplication via execute', () => {
    it('deduplicates same path from fs and messages', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return [] as Dirent[];
        return [makeDirent('new.ts', false)];
      });
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const ctx = makeCtx({
        messages: [
          {
            role: 'assistant',
            content: 'Written to artifacts/new.ts',
          },
        ],
      });

      const next: MiddlewareNext = async () => ctx;
      await tracker.execute(ctx, next);

      // Should have exactly 1 entry, not 2
      expect(tracker.totalCount).toBe(1);
    });
  });

  // ──────────────────────────────────────────
  // 7. Query API
  // ──────────────────────────────────────────

  describe('query API', () => {
    let tracker: ArtifactTrackingMiddleware;

    beforeEach(() => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      tracker.registerArtifact('src/main.ts', {
        creator: 'coder',
        category: 'code',
      });
      tracker.registerArtifact('design/spec.md', {
        creator: 'architect',
        category: 'design',
      });
      tracker.registerArtifact('research/analysis.md', {
        creator: 'researcher',
        category: 'analysis',
      });
      tracker.registerArtifact('src/utils.ts', {
        creator: 'coder',
        category: 'code',
      });
    });

    it('getEntries returns all records', () => {
      expect(tracker.getEntries()).toHaveLength(4);
    });

    it('getByCategory filters correctly', () => {
      const codeArtifacts = tracker.getByCategory('code');
      expect(codeArtifacts).toHaveLength(2);
      expect(codeArtifacts.every((a) => a.type === 'code')).toBe(true);
    });

    it('getByCreator filters correctly', () => {
      const coderArtifacts = tracker.getByCreator('coder');
      expect(coderArtifacts).toHaveLength(2);
      expect(coderArtifacts.every((a) => a.creator === 'coder')).toBe(true);
    });

    it('getByPath returns single record or undefined', () => {
      expect(tracker.getByPath('src/main.ts')).toBeDefined();
      expect(tracker.getByPath('src/main.ts')!.type).toBe('code');
      expect(tracker.getByPath('nonexistent.ts')).toBeUndefined();
    });

    it('totalCount reflects registry size', () => {
      expect(tracker.totalCount).toBe(4);
    });

    it('getRegistrySnapshot returns plain object copy', () => {
      const snap = tracker.getRegistrySnapshot();
      expect(typeof snap).toBe('object');
      expect(Object.keys(snap)).toHaveLength(4);
      // Verify it's a copy — mutating snap does not affect registry
      delete snap['src/main.ts'];
      expect(tracker.totalCount).toBe(4);
    });
  });

  // ──────────────────────────────────────────
  // 8. Event emission
  // ──────────────────────────────────────────

  describe('event emission', () => {
    it('emits artifact:added on new artifacts', () => {
      const emitter = createMockEmitter();
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const tracker = new ArtifactTrackingMiddleware(
        { projectRoot: '/proj' },
        emitter,
      );
      tracker.registerArtifact('src/new.ts', { creator: 'dev' });

      expect(emitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'artifact:added',
          path: 'src/new.ts',
          creator: 'dev',
          source: 'artifact-tracking',
        }),
      );
    });

    it('emits artifact:modified on merge update', () => {
      const emitter = createMockEmitter();
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const tracker = new ArtifactTrackingMiddleware(
        { projectRoot: '/proj' },
        emitter,
      );
      tracker.registerArtifact('src/file.ts');
      tracker.registerArtifact('src/file.ts'); // second call → merge

      const typedCalls = emitter.calls as Array<Record<string, unknown>>;
      const modifiedEvents = typedCalls.filter(
        (e) => e.type === 'artifact:modified',
      );
      expect(modifiedEvents.length).toBe(1);
    });

    it('does not crash when emitter throws', () => {
      const emitter: ArtifactEventEmitter = {
        emit: vi.fn(() => {
          throw new Error('emitter boom');
        }),
      };
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const tracker = new ArtifactTrackingMiddleware(
        { projectRoot: '/proj' },
        emitter,
      );
      // Should not throw
      expect(() =>
        tracker.registerArtifact('src/file.ts'),
      ).not.toThrow();
    });

    it('skips emission when no emitter provided', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      // No emitter — should not throw
      expect(() => tracker.registerArtifact('src/file.ts')).not.toThrow();
    });
  });

  // ──────────────────────────────────────────
  // 9. classifyArtifact (indirect via registerArtifact)
  // ──────────────────────────────────────────

  describe('artifact classification', () => {
    let tracker: ArtifactTrackingMiddleware;

    beforeEach(() => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
    });

    it('classifies by directory name (research → analysis)', () => {
      const r = tracker.registerArtifact('research/findings.md');
      expect(r.type).toBe('analysis');
    });

    it('classifies by directory name (design → design)', () => {
      const r = tracker.registerArtifact('design/spec.md');
      expect(r.type).toBe('design');
    });

    it('classifies test files by pattern', () => {
      const r = tracker.registerArtifact('src/utils.test.ts');
      expect(r.type).toBe('test');
    });

    it('classifies spec files', () => {
      const r = tracker.registerArtifact('src/module.spec.ts');
      expect(r.type).toBe('test');
    });

    it('classifies by extension (.ts → code)', () => {
      const r = tracker.registerArtifact('src/main.ts');
      expect(r.type).toBe('code');
    });

    it('classifies by extension (.md → document)', () => {
      const r = tracker.registerArtifact('notes.md');
      expect(r.type).toBe('document');
    });

    it('classifies by extension (.json → data)', () => {
      const r = tracker.registerArtifact('data.json');
      expect(r.type).toBe('data');
    });

    it('classifies by extension (.yaml → config)', () => {
      const r = tracker.registerArtifact('settings.yaml');
      expect(r.type).toBe('config');
    });

    it('falls back to data for unknown extensions', () => {
      const r = tracker.registerArtifact('binary.xyz');
      expect(r.type).toBe('data');
    });

    it('directory classification takes priority over extension', () => {
      // "tests" directory → test, even though .ts → code
      const r = tracker.registerArtifact('tests/helper.ts');
      expect(r.type).toBe('test');
    });

    it('category override via registerArtifact opts', () => {
      const r = tracker.registerArtifact('output.log', { category: 'report' });
      expect(r.type).toBe('report');
    });
  });

  // ──────────────────────────────────────────
  // 10. execute — state & registry attachment
  // ──────────────────────────────────────────

  describe('execute — state population', () => {
    it('attaches summary and registry snapshot to ctx.state', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockReturnValue([] as Dirent[]);

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);

      expect(result.state['artifact-tracking:summary']).toBeDefined();
      expect(result.state['artifact-tracking:registry']).toBeDefined();

      const summary = getSummary(result.state);
      expect(typeof summary.totalArtifacts).toBe('number');
      expect(Array.isArray(summary.added)).toBe(true);
      expect(Array.isArray(summary.modified)).toBe(true);
      expect(Array.isArray(summary.removed)).toBe(true);
    });

    it('uses currentRole from state as creator', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return [] as Dirent[];
        return [makeDirent('file.ts', false)];
      });
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const ctx = makeCtx({ state: { currentRole: 'architect' } });
      const next: MiddlewareNext = async () => ctx;
      await tracker.execute(ctx, next);

      const record = tracker.getByPath('artifacts/file.ts');
      expect(record?.creator).toBe('architect');
    });

    it('falls back to defaultRole when no role in state', async () => {
      const tracker = new ArtifactTrackingMiddleware({
        projectRoot: '/proj',
        defaultRole: 'bot',
      });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return [] as Dirent[];
        return [makeDirent('out.ts', false)];
      });
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      await tracker.execute(ctx, next);

      const record = tracker.getByPath('artifacts/out.ts');
      expect(record?.creator).toBe('bot');
    });
  });

  // ──────────────────────────────────────────
  // 11. Recursive directory walk & ignore
  // ──────────────────────────────────────────

  describe('execute — directory walking', () => {
    it('recurses into subdirectories', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation((dir) => {
        callCount++;
        // First call = before snapshot (empty dir, no recursion); rest = after snapshot
        if (callCount <= 1) return [] as Dirent[];
        const dirStr = String(dir);
        if (dirStr.endsWith('/artifacts')) {
          return [makeDirent('src', true)];
        }
        if (dirStr.endsWith('/src')) {
          return [makeDirent('index.ts', false)];
        }
        return [] as Dirent[];
      });
      vi.mocked(statSync).mockReturnValue(makeStat(200, 3000));

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);
      const summary = getSummary(result.state);

      expect(summary.added.length).toBeGreaterThan(0);
    });

    it('skips ignored directories (node_modules, .git)', async () => {
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });

      let callCount = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) return [] as Dirent[]; // before
        return [
          makeDirent('node_modules', true),
          makeDirent('.git', true),
          makeDirent('real.ts', false),
        ];
      });
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));

      const ctx = makeCtx();
      const next: MiddlewareNext = async () => ctx;
      const result = await tracker.execute(ctx, next);
      const summary = getSummary(result.state);

      // Only real.ts should be tracked, not node_modules or .git contents
      expect(summary.added).toHaveLength(1);
      expect(summary.added[0]).toContain('real.ts');
    });
  });

  // ──────────────────────────────────────────
  // 12. createArtifactTracker factory
  // ──────────────────────────────────────────

  describe('createArtifactTracker', () => {
    it('creates instance with defaults', () => {
      const tracker = createArtifactTracker('/my/project');
      expect(tracker).toBeInstanceOf(ArtifactTrackingMiddleware);
      expect(tracker.name).toBe('artifact-tracking');
    });

    it('accepts optional emitter', () => {
      const emitter = createMockEmitter();
      const tracker = createArtifactTracker('/my/project', emitter);
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      tracker.registerArtifact('file.ts');
      expect(emitter.emit).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────
  // 13. pathToId determinism
  // ──────────────────────────────────────────

  describe('deterministic IDs', () => {
    it('same path produces same ID', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      const r1 = tracker.registerArtifact('src/a.ts');
      // Re-register and check ID is same
      const r2 = tracker.registerArtifact('src/a.ts');
      expect(r1.id).toBe(r2.id);
      expect(r1.id).toMatch(/^art-[a-z0-9]+$/);
    });

    it('different paths produce different IDs', () => {
      vi.mocked(statSync).mockReturnValue(makeStat(100, 1000));
      const tracker = new ArtifactTrackingMiddleware({ projectRoot: '/proj' });
      const r1 = tracker.registerArtifact('src/a.ts');
      const r2 = tracker.registerArtifact('src/b.ts');
      expect(r1.id).not.toBe(r2.id);
    });
  });
});
