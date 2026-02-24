import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { VectorStore } from './vector-store.js';
import { generateFunctionCards } from './card-generator.js';
import { buildFunctionCards, buildFunctionId, needsReindex, embedCards, loadRagCache, saveRagCache } from './indexer.js';
import { embed, setEmbeddingLogger } from './embeddings.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';

export interface RagIndexOptions {
  projectRoot: string;
  tasks: Task[];
  indexModel: string;
  rebuild?: boolean;
  concurrency?: number;
  onLog: (message: string) => void;
  onProgress?: (current: number, total: number) => void;
  isInterrupted: () => boolean;
}

export interface RagIndexResult {
  vectorStore: VectorStore;
  cardsIndexed: number;
  filesIndexed: number;
  totalCards: number;
  totalFiles: number;
}

/**
 * Result of processing a single file for indexing.
 * Contains cards and pre-computed embeddings — does NOT touch VectorStore or cache.
 */
export interface IndexedFileResult {
  task: Task;
  cards: FunctionCard[];
  embeddings: number[][];
}

/**
 * Process a single file for RAG indexing: Haiku LLM call + build cards + embed.
 * Returns cards and embeddings without touching VectorStore or cache.
 * This is the pure, parallelizable unit of work.
 */
export async function processFileForIndex(
  projectRoot: string,
  task: Task,
  indexModel: string,
  cache: { entries: Record<string, string> },
): Promise<IndexedFileResult> {
  // Early exit: skip LLM call if all functions are already cached for this hash
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );
  const allCached =
    functionSymbols.length > 0 &&
    functionSymbols.every((symbol) => {
      const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
      return cache.entries[id] === task.hash;
    });
  if (allCached) {
    return { task, cards: [], embeddings: [] };
  }

  const llmCards = await generateFunctionCards(projectRoot, task, indexModel);
  if (llmCards.length === 0) {
    return { task, cards: [], embeddings: [] };
  }

  const absPath = resolve(projectRoot, task.file);
  const source = readFileSync(absPath, 'utf-8');
  const cards = buildFunctionCards(task, source, llmCards);

  // Filter to only cards that need re-indexing
  const toIndex = cards.filter((card) => needsReindex(cache, card, task.hash));
  if (toIndex.length === 0) {
    return { task, cards: [], embeddings: [] };
  }

  // Generate embeddings for cards that need indexing
  const embeddings = await embedCards(toIndex);

  return { task, cards: toIndex, embeddings };
}

/**
 * Run the RAG indexing phase: generate function cards via Haiku,
 * compute embeddings, and upsert into the vector store.
 *
 * Returns the initialized VectorStore and indexing stats.
 */
export async function indexProject(options: RagIndexOptions): Promise<RagIndexResult> {
  const { projectRoot, tasks, indexModel, rebuild, concurrency = 4, onLog, onProgress, isInterrupted } = options;

  setEmbeddingLogger(onLog);

  const store = new VectorStore(projectRoot);
  await store.init();

  if (rebuild) {
    await store.rebuild();
  }

  // Pre-warm embedding model before processing files
  await embed('');

  // Pre-load cache for the entire indexing run
  const cache = loadRagCache(projectRoot);

  // Garbage-collect stale entries: remove cards for files no longer in the project
  const currentFiles = new Set(tasks.map((t) => t.file));
  const indexedFiles = await store.listIndexedFiles();
  for (const orphan of indexedFiles) {
    if (!currentFiles.has(orphan)) {
      await store.deleteByFile(orphan);
      onLog(`gc: removed stale cards for ${orphan}`);
    }
  }

  const tasksWithFunctions = tasks.filter((t) =>
    t.symbols.some((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
  );

  // Filter out files where all function cards are already cached for the current hash
  const tasksToIndex = tasksWithFunctions.filter((task) => {
    const fnSymbols = task.symbols.filter(
      (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
    );
    return !fnSymbols.every((symbol) => {
      const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
      return cache.entries[id] === task.hash;
    });
  });

  // Accumulate results from all files via concurrent worker pool
  const results: IndexedFileResult[] = [];
  let fileCounter = 0;

  await runWorkerPool({
    items: tasksToIndex,
    concurrency,
    isInterrupted,
    handler: async (task) => {
      const idx = ++fileCounter;
      onLog(`[${idx}/${tasksToIndex.length}] ${task.file}`);

      const result = await retryWithBackoff(
        () => processFileForIndex(projectRoot, task, indexModel, cache),
        {
          maxRetries: 5,
          baseDelayMs: 2000,
          maxDelayMs: 30_000,
          jitterFactor: 0.2,
          filePath: task.file,
          isInterrupted,
          onRetry: (attempt, delayMs) => {
            const delaySec = (delayMs / 1000).toFixed(0);
            onLog(`  rate limited — retrying ${task.file} in ${delaySec}s (attempt ${attempt}/5)`);
          },
        },
      );
      if (result.cards.length > 0) {
        results.push(result);
      }
      onProgress?.(fileCounter, tasksToIndex.length);
    },
  });

  // Batch upsert all accumulated results sequentially
  let cardsIndexed = 0;
  let filesIndexed = 0;

  for (const result of results) {
    await store.upsert(result.cards, result.embeddings);
    cardsIndexed += result.cards.length;
    filesIndexed++;

    // Update cache entries for this file's cards
    for (const card of result.cards) {
      cache.entries[card.id] = result.task.hash;
    }
  }

  // Single atomic cache write for all results
  if (results.length > 0) {
    saveRagCache(projectRoot, cache);
  }

  const stats = await store.stats();

  return {
    vectorStore: store,
    cardsIndexed,
    filesIndexed,
    totalCards: stats.totalCards,
    totalFiles: stats.totalFiles,
  };
}
