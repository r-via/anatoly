import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { VectorStore } from './vector-store.js';
import { buildFunctionCards, buildFunctionId, needsReindex, embedCards, applyNlpSummaries, loadRagCache, saveRagCache, extractFunctionBody } from './indexer.js';
import { embed, setEmbeddingLogger } from './embeddings.js';
import { generateNlpSummaries } from './nlp-summarizer.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { contextLogger } from '../utils/log-context.js';

export interface RagIndexOptions {
  projectRoot: string;
  tasks: Task[];
  /** Model used for NLP summary generation (dual embedding mode). */
  indexModel?: string;
  /** Enable dual embedding (code + NLP). Requires indexModel. */
  dualEmbedding?: boolean;
  rebuild?: boolean;
  concurrency?: number;
  verbose?: boolean;
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
  /** Whether dual embedding (code + NLP) was used during indexing. */
  dualEmbedding: boolean;
}

/**
 * Result of processing a single file for indexing.
 * Contains cards and pre-computed embeddings — does NOT touch VectorStore or cache.
 */
export interface IndexedFileResult {
  task: Task;
  cards: FunctionCard[];
  embeddings: number[][];
  /** NLP embeddings (same length as cards). Only present when dual embedding is enabled. */
  nlpEmbeddings?: number[][];
}

/**
 * Process a single file for RAG indexing: build cards from AST + embed code directly.
 * No LLM call — purely local operation (code embedding only).
 */
export async function processFileForIndex(
  projectRoot: string,
  task: Task,
  cache: { entries: Record<string, string> },
): Promise<IndexedFileResult> {
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  if (functionSymbols.length === 0) {
    return { task, cards: [], embeddings: [] };
  }

  const absPath = resolve(projectRoot, task.file);
  const source = readFileSync(absPath, 'utf-8');
  const cards = buildFunctionCards(task, source);

  // Filter to only cards that need re-indexing
  const toIndex = cards.filter((card) => needsReindex(cache, card, task.hash));
  if (toIndex.length === 0) {
    return { task, cards: [], embeddings: [] };
  }

  // Generate embeddings for cards that need indexing (code-direct, no API)
  const embeddings = await embedCards(toIndex, source, task.symbols);

  return { task, cards: toIndex, embeddings };
}

/**
 * Process a single file for dual-embedding RAG indexing:
 * builds cards from AST, embeds code locally, then generates NLP summaries
 * via LLM and embeds the NLP text.
 */
export async function processFileForDualIndex(
  projectRoot: string,
  task: Task,
  cache: { entries: Record<string, string> },
  indexModel: string,
): Promise<IndexedFileResult> {
  // First pass: same as regular indexing (code embedding)
  const baseResult = await processFileForIndex(projectRoot, task, cache);
  if (baseResult.cards.length === 0) {
    return baseResult;
  }

  // Read source for function body extraction
  const absPath = resolve(projectRoot, task.file);
  const source = readFileSync(absPath, 'utf-8');

  // Extract function bodies for NLP summarization
  const functionBodies: string[] = baseResult.cards.map((card) => {
    const symbol = task.symbols.find(
      (s) => s.name === card.name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    );
    return symbol ? extractFunctionBody(source, symbol) : card.signature;
  });

  // Generate NLP summaries via LLM
  const nlpSummaries = await generateNlpSummaries(
    baseResult.cards,
    functionBodies,
    task.file,
    indexModel,
    projectRoot,
  );

  // Apply NLP summaries and generate NLP embeddings
  const { enrichedCards, nlpEmbeddings } = await applyNlpSummaries(baseResult.cards, nlpSummaries);

  return {
    task: baseResult.task,
    cards: enrichedCards,
    embeddings: baseResult.embeddings,
    nlpEmbeddings,
  };
}

/**
 * Run the RAG indexing phase: build function cards from AST,
 * compute code embeddings locally, and upsert into the vector store.
 *
 * When dualEmbedding is enabled, also generates NLP summaries via LLM
 * and computes NLP embeddings for hybrid search.
 */
export async function indexProject(options: RagIndexOptions): Promise<RagIndexResult> {
  const { projectRoot, tasks, rebuild, concurrency = 4, onLog, onProgress, isInterrupted } = options;
  const dualMode = !!(options.dualEmbedding && options.indexModel);

  setEmbeddingLogger(onLog);

  const store = new VectorStore(projectRoot, onLog);
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

  const log = contextLogger();
  log.debug(
    { totalFiles: tasks.length, filesWithFunctions: tasksWithFunctions.length, dualEmbedding: dualMode },
    'RAG index: filtering files',
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
      const modeLabel = dualMode ? ' [dual]' : '';
      onLog(`[${idx}/${tasksToIndex.length}]${modeLabel} ${task.file}`);

      const result = dualMode
        ? await processFileForDualIndex(projectRoot, task, cache, options.indexModel!)
        : await processFileForIndex(projectRoot, task, cache);

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
    await store.upsert(result.cards, result.embeddings, {
      nlpEmbeddings: result.nlpEmbeddings,
    });
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

  log.debug(
    {
      cardsIndexed,
      filesIndexed,
      cached: tasksWithFunctions.length - tasksToIndex.length,
      totalCards: stats.totalCards,
      totalFiles: stats.totalFiles,
      dualEmbedding: dualMode,
    },
    'RAG index summary',
  );

  return {
    vectorStore: store,
    cardsIndexed,
    filesIndexed,
    totalCards: stats.totalCards,
    totalFiles: stats.totalFiles,
    dualEmbedding: dualMode,
  };
}
