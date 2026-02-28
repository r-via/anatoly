import { describe, it, expect, vi, beforeEach } from 'vitest';

const { workerPoolSpy } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerPoolSpy = vi.fn<any>();
  return { workerPoolSpy };
});

// Mock fs for processFileForIndex (reads source files)
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('export function foo() { return 1; }'),
}));

vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Array(768).fill(0)),
  setEmbeddingLogger: vi.fn(),
  buildEmbedCode: vi.fn().mockReturnValue('// foo\nfunction foo()\nexport function foo() { return 1; }'),
  buildEmbedNlp: vi.fn().mockReturnValue('Function: foo\nPurpose: test'),
  EMBEDDING_DIM: 768,
  EMBEDDING_MODEL: 'jinaai/jina-embeddings-v2-base-code',
}));

vi.mock('./vector-store.js', () => {
  class MockVectorStore {
    init = vi.fn().mockResolvedValue(undefined);
    rebuild = vi.fn().mockResolvedValue(undefined);
    upsert = vi.fn().mockResolvedValue(undefined);
    listIndexedFiles = vi.fn().mockResolvedValue(new Set<string>());
    deleteByFile = vi.fn().mockResolvedValue(undefined);
    stats = vi.fn().mockResolvedValue({ totalCards: 0, totalFiles: 0, lastIndexed: null, dualEmbedding: false });
    hasDualEmbedding = false;
  }
  return {
    VectorStore: MockVectorStore,
    sanitizeId: vi.fn((id: string) => id),
    sanitizeFilePath: vi.fn((p: string) => p),
  };
});

vi.mock('./indexer.js', () => ({
  buildFunctionCards: vi.fn().mockReturnValue([]),
  buildFunctionId: vi.fn((_file: string, start: number, end: number) => `mock-${start}-${end}`),
  needsReindex: vi.fn().mockReturnValue(true),
  embedCards: vi.fn().mockResolvedValue([]),
  applyNlpSummaries: vi.fn().mockResolvedValue({ enrichedCards: [], nlpEmbeddings: [] }),
  extractFunctionBody: vi.fn().mockReturnValue('export function foo() { return 1; }'),
  loadRagCache: vi.fn().mockReturnValue({ entries: {} }),
  saveRagCache: vi.fn(),
}));

vi.mock('./nlp-summarizer.js', () => ({
  generateNlpSummaries: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../core/worker-pool.js', () => ({
  runWorkerPool: workerPoolSpy,
}));

import { indexProject, processFileForIndex } from './orchestrator.js';
import { buildFunctionCards, buildFunctionId, needsReindex, embedCards } from './indexer.js';
import type { Task } from '../schemas/task.js';
import type { WorkerPoolOptions } from '../core/worker-pool.js';
import type { FunctionCard } from './types.js';

function poolArgs(): WorkerPoolOptions<Task> {
  return workerPoolSpy.mock.calls[0][0] as WorkerPoolOptions<Task>;
}

function makeTask(file: string): Task {
  return {
    version: 1,
    file,
    hash: 'abc123',
    symbols: [{ name: 'foo', kind: 'function', line_start: 1, line_end: 10, exported: true }],
    scanned_at: '2024-01-01T00:00:00.000Z',
  };
}

describe('indexProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerPoolSpy.mockResolvedValue({ completed: 0, errored: 0, skipped: 0 });
  });

  it('should pass concurrency option to runWorkerPool', async () => {
    await indexProject({
      projectRoot: '/tmp/test',
      tasks: [makeTask('src/a.ts')],
      concurrency: 6,
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    expect(workerPoolSpy).toHaveBeenCalledOnce();
    expect(poolArgs().concurrency).toBe(6);
  });

  it('should default concurrency to 4 when not specified', async () => {
    await indexProject({
      projectRoot: '/tmp/test',
      tasks: [makeTask('src/a.ts')],
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    expect(workerPoolSpy).toHaveBeenCalledOnce();
    expect(poolArgs().concurrency).toBe(4);
  });

  it('should pass isInterrupted to runWorkerPool', async () => {
    const isInterrupted = () => false;

    await indexProject({
      projectRoot: '/tmp/test',
      tasks: [makeTask('src/a.ts')],
      onLog: vi.fn(),
      isInterrupted,
    });

    expect(poolArgs().isInterrupted).toBe(isInterrupted);
  });

  it('should filter tasks to only those with function symbols', async () => {
    const taskWithFunctions = makeTask('src/a.ts');
    const taskWithoutFunctions: Task = {
      version: 1,
      file: 'src/b.ts',
      hash: 'def456',
      symbols: [{ name: 'MyType', kind: 'type', line_start: 1, line_end: 5, exported: true }],
      scanned_at: '2024-01-01T00:00:00.000Z',
    };

    await indexProject({
      projectRoot: '/tmp/test',
      tasks: [taskWithFunctions, taskWithoutFunctions],
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    expect(workerPoolSpy).toHaveBeenCalledOnce();
    expect(poolArgs().items).toHaveLength(1);
    expect(poolArgs().items[0]).toBe(taskWithFunctions);
  });

  it('should use runWorkerPool instead of sequential loop', async () => {
    const tasks = [makeTask('src/a.ts'), makeTask('src/b.ts'), makeTask('src/c.ts')];

    await indexProject({
      projectRoot: '/tmp/test',
      tasks,
      concurrency: 3,
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    // Verify worker pool was called (not a sequential loop)
    expect(workerPoolSpy).toHaveBeenCalledOnce();
    expect(poolArgs().items).toHaveLength(3);
    expect(poolArgs().concurrency).toBe(3);
  });

  it('should call processFileForIndex directly (no retryWithBackoff for local indexation)', async () => {
    // Make workerPool invoke the handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workerPoolSpy.mockImplementation(async (opts: any) => {
      for (const item of opts.items) {
        await opts.handler(item, 0);
      }
      return { completed: opts.items.length, errored: 0, skipped: 0 };
    });

    await indexProject({
      projectRoot: '/tmp/test',
      tasks: [makeTask('src/a.ts')],
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    // buildFunctionCards is called inside processFileForIndex
    expect(buildFunctionCards).toHaveBeenCalled();
  });
});

function makeCard(name: string, filePath: string): FunctionCard {
  return {
    id: `card-${name}`,
    filePath,
    name,
    signature: `function ${name}()`,
    complexityScore: 1,
    calledInternals: [],
    lastIndexed: '2024-01-01T00:00:00.000Z',
  };
}

describe('processFileForIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty for task with no function symbols', async () => {
    const task: Task = {
      version: 1,
      file: 'src/types.ts',
      hash: 'abc123',
      symbols: [{ name: 'MyType', kind: 'type', line_start: 1, line_end: 5, exported: true }],
      scanned_at: '2024-01-01T00:00:00.000Z',
    };

    const result = await processFileForIndex('/tmp/test', task, { entries: {} });

    expect(result.cards).toEqual([]);
    expect(result.embeddings).toEqual([]);
  });

  it('filters out cached cards via needsReindex', async () => {
    const card1 = makeCard('foo', 'src/a.ts');
    const card2 = makeCard('bar', 'src/a.ts');

    vi.mocked(buildFunctionCards).mockReturnValue([card1, card2]);
    // card1 is cached (needsReindex=false), card2 needs reindex
    vi.mocked(needsReindex)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.mocked(embedCards).mockResolvedValue([[0.1, 0.2]]);

    const result = await processFileForIndex('/tmp/test', makeTask('src/a.ts'), { entries: {} });

    expect(result.cards).toEqual([card2]);
  });

  it('returns empty when all cards are cached', async () => {
    const card = makeCard('foo', 'src/a.ts');

    vi.mocked(buildFunctionCards).mockReturnValue([card]);
    vi.mocked(needsReindex).mockReturnValue(false);

    const result = await processFileForIndex('/tmp/test', makeTask('src/a.ts'), { entries: { 'card-foo': 'abc123' } });

    expect(result.cards).toEqual([]);
    expect(result.embeddings).toEqual([]);
    expect(embedCards).not.toHaveBeenCalled();
  });

  it('generates embeddings for cards that need reindexing', async () => {
    const card = makeCard('foo', 'src/a.ts');
    const embedding = [0.1, 0.2, 0.3];

    vi.mocked(buildFunctionCards).mockReturnValue([card]);
    vi.mocked(needsReindex).mockReturnValue(true);
    vi.mocked(embedCards).mockResolvedValue([embedding]);

    const result = await processFileForIndex('/tmp/test', makeTask('src/a.ts'), { entries: {} });

    expect(result.cards).toEqual([card]);
    expect(result.embeddings).toEqual([embedding]);
    expect(result.task.file).toBe('src/a.ts');
  });
});
