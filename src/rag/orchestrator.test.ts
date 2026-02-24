import { describe, it, expect, vi, beforeEach } from 'vitest';

const { workerPoolSpy } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerPoolSpy = vi.fn<any>();
  return { workerPoolSpy };
});

// Mock all heavy dependencies before importing the module under test
vi.mock('./card-generator.js', () => ({
  generateFunctionCards: vi.fn().mockResolvedValue([]),
}));

vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
  setEmbeddingLogger: vi.fn(),
}));

vi.mock('./vector-store.js', () => {
  class MockVectorStore {
    init = vi.fn().mockResolvedValue(undefined);
    rebuild = vi.fn().mockResolvedValue(undefined);
    upsert = vi.fn().mockResolvedValue(undefined);
    stats = vi.fn().mockResolvedValue({ totalCards: 0, totalFiles: 0 });
  }
  return {
    VectorStore: MockVectorStore,
    sanitizeId: vi.fn((id: string) => id),
    sanitizeFilePath: vi.fn((p: string) => p),
  };
});

vi.mock('./indexer.js', () => ({
  buildFunctionCards: vi.fn().mockReturnValue([]),
  needsReindex: vi.fn().mockReturnValue(true),
  embedCards: vi.fn().mockResolvedValue([]),
  loadRagCache: vi.fn().mockReturnValue({ entries: {} }),
  saveRagCache: vi.fn(),
  indexCards: vi.fn(),
}));

vi.mock('../core/worker-pool.js', () => ({
  runWorkerPool: workerPoolSpy,
}));

import { indexProject } from './orchestrator.js';
import type { Task } from '../schemas/task.js';
import type { WorkerPoolOptions } from '../core/worker-pool.js';

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
      indexModel: 'claude-haiku-4-5-20251001',
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
      indexModel: 'claude-haiku-4-5-20251001',
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
      indexModel: 'claude-haiku-4-5-20251001',
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
      indexModel: 'claude-haiku-4-5-20251001',
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
      indexModel: 'claude-haiku-4-5-20251001',
      concurrency: 3,
      onLog: vi.fn(),
      isInterrupted: () => false,
    });

    // Verify worker pool was called (not a sequential loop)
    expect(workerPoolSpy).toHaveBeenCalledOnce();
    expect(poolArgs().items).toHaveLength(3);
    expect(poolArgs().concurrency).toBe(3);
  });
});
