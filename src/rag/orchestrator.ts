// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { VectorStore } from './vector-store.js';
import { buildFunctionCards, buildFunctionId, needsReindex, embedCards, applyNlpSummaries, enrichCardsWithSummaries, generateNlpEmbeddings, loadRagCache, saveRagCache, loadNlpSummaryCache, saveNlpSummaryCache, extractFunctionBody, computeBodyHash } from './indexer.js';
import type { NlpSummaryCache } from './indexer.js';
import { embedCode, embedNlp, setEmbeddingLogger, configureModels } from './embeddings.js';
import type { ResolvedModels } from './hardware-detect.js';
import { generateNlpSummaries } from './nlp-summarizer.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { contextLogger } from '../utils/log-context.js';
import { indexDocSections } from './doc-indexer.js';
import type { Semaphore } from '../core/sdk-semaphore.js';

export type RagMode = 'lite' | 'advanced';

export interface RagIndexOptions {
  projectRoot: string;
  tasks: Task[];
  /** Model used for NLP summary generation (dual embedding mode). */
  indexModel?: string;
  /** Enable dual embedding (code + NLP). Requires indexModel. */
  dualEmbedding?: boolean;
  /** Resolved embedding models (from hardware detection). Configures code/NLP model selection. */
  resolvedModels?: ResolvedModels;
  /** RAG mode determines table name and cache file. */
  ragMode?: RagMode;
  /** Directory containing markdown docs for doc section indexing (default: 'docs'). */
  docsDir?: string;
  rebuild?: boolean;
  concurrency?: number;
  verbose?: boolean;
  onLog: (message: string) => void;
  onProgress?: (current: number, total: number) => void;
  onFileStart?: (file: string) => void;
  onFileDone?: (file: string) => void;
  /** Called when indexing transitions between phases. */
  onPhase?: (phase: 'code' | 'nlp' | 'upsert' | 'doc') => void;
  isInterrupted: () => boolean;
  /** Full path to conversations/ dir for LLM conversation dumps. */
  conversationDir?: string;
  /** Global SDK concurrency semaphore. */
  semaphore?: Semaphore;
}

export interface RagIndexResult {
  vectorStore: VectorStore;
  cardsIndexed: number;
  filesIndexed: number;
  totalCards: number;
  totalFiles: number;
  /** Whether dual embedding (code + NLP) was used during indexing. */
  dualEmbedding: boolean;
  /** Number of doc sections indexed from /docs/. */
  docSectionsIndexed: number;
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
  /** Card IDs where NLP summarization failed (zero vector). Excluded from cache. */
  nlpFailedIds?: Set<string>;
  /** NLP summary cache entries produced during this file's processing. */
  nlpCacheUpdates?: Record<string, { bodyHash: string; summary: import('./nlp-summarizer.js').NlpSummary }>;
}

/**
 * Read source and build cards + code embeddings for a single file.
 * Shared core logic for both code-only and dual-embedding modes.
 */
function readAndBuildCards(
  projectRoot: string,
  task: Task,
  cache: { entries: Record<string, string> },
): { source: string; toIndex: FunctionCard[]; embeddings: Promise<number[][]> } | null {
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  if (functionSymbols.length === 0) return null;

  const absPath = resolve(projectRoot, task.file);
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    // File deleted between scan and index — skip silently
    return null;
  }

  const cards = buildFunctionCards(task, source);
  const toIndex = cards.filter((card) => needsReindex(cache, card, task.hash));
  if (toIndex.length === 0) return null;

  return {
    source,
    toIndex,
    embeddings: embedCards(toIndex, source, task.symbols),
  };
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
  const built = readAndBuildCards(projectRoot, task, cache);
  if (!built) return { task, cards: [], embeddings: [] };

  return { task, cards: built.toIndex, embeddings: await built.embeddings };
}

/**
 * Process a single file for dual-embedding RAG indexing:
 * builds cards from AST, embeds code locally, then generates NLP summaries
 * via LLM and embeds the NLP text. Reads the file only once.
 */
export async function processFileForDualIndex(
  projectRoot: string,
  task: Task,
  cache: { entries: Record<string, string> },
  indexModel: string,
  nlpSummaryCache?: NlpSummaryCache,
  deferNlpEmbeddings?: boolean,
  conversationDir?: string,
  semaphore?: Semaphore,
): Promise<IndexedFileResult> {
  const built = readAndBuildCards(projectRoot, task, cache);
  if (!built) return { task, cards: [], embeddings: [] };

  const codeEmbeddings = await built.embeddings;

  // Extract function bodies for NLP summarization (reuse already-read source)
  const functionBodies: string[] = built.toIndex.map((card) => {
    const symbol = task.symbols.find(
      (s) => s.name === card.name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    );
    return symbol ? extractFunctionBody(built.source, symbol) : card.signature;
  });

  // Partition functions into cached (reuse summary) and uncached (need LLM)
  const mergedSummaries = new Map<string, import('./nlp-summarizer.js').NlpSummary>();
  const uncachedCards: FunctionCard[] = [];
  const uncachedBodies: string[] = [];
  const nlpCacheUpdates: Record<string, { bodyHash: string; summary: import('./nlp-summarizer.js').NlpSummary }> = {};

  for (let i = 0; i < built.toIndex.length; i++) {
    const card = built.toIndex[i];
    const body = functionBodies[i];
    const bodyHash = computeBodyHash(body);
    const cached = nlpSummaryCache?.entries[card.id];

    if (cached && cached.bodyHash === bodyHash) {
      // Reuse cached summary — no LLM call needed
      mergedSummaries.set(card.id, cached.summary);
      nlpCacheUpdates[card.id] = cached;
    } else {
      uncachedCards.push(card);
      uncachedBodies.push(body);
    }
  }

  // Generate NLP summaries via LLM only for uncached functions
  if (uncachedCards.length > 0) {
    const newSummaries = await generateNlpSummaries(
      uncachedCards,
      uncachedBodies,
      task.file,
      indexModel,
      projectRoot,
      conversationDir,
      semaphore,
    );

    // Merge new summaries and build cache entries
    for (let i = 0; i < uncachedCards.length; i++) {
      const card = uncachedCards[i];
      const summary = newSummaries.get(card.id);
      if (summary) {
        mergedSummaries.set(card.id, summary);
        const bodyHash = computeBodyHash(uncachedBodies[i]);
        nlpCacheUpdates[card.id] = { bodyHash, summary };
      }
    }
  }

  if (deferNlpEmbeddings) {
    // Enrich cards but skip NLP embedding (deferred to batch phase)
    const { enrichedCards, nlpFailedIds } = enrichCardsWithSummaries(built.toIndex, mergedSummaries);
    return { task, cards: enrichedCards, embeddings: codeEmbeddings, nlpFailedIds, nlpCacheUpdates };
  }

  // Apply all NLP summaries (cached + new) and generate NLP embeddings
  const { enrichedCards, nlpEmbeddings, nlpFailedIds } = await applyNlpSummaries(built.toIndex, mergedSummaries);

  return {
    task,
    cards: enrichedCards,
    embeddings: codeEmbeddings,
    nlpEmbeddings,
    nlpFailedIds,
    nlpCacheUpdates,
  };
}

/**
 * Run the RAG indexing phase: build function cards from AST,
 * compute code embeddings locally, and upsert into the vector store.
 *
 * When dualEmbedding is enabled, also generates NLP summaries via LLM
 * and computes NLP embeddings for hybrid search.
 */
/** Derive LanceDB table name and cache suffix from RAG mode. */
export function ragModeArtifacts(mode: RagMode): { tableName: string; cacheSuffix: string } {
  return { tableName: `function_cards_${mode}`, cacheSuffix: mode };
}

export async function indexProject(options: RagIndexOptions): Promise<RagIndexResult> {
  const { projectRoot, tasks, rebuild, concurrency = 4, onLog, onProgress, onFileStart, onFileDone, onPhase, isInterrupted } = options;
  const dualMode = !!(options.dualEmbedding && options.indexModel);
  const effectiveMode = options.ragMode ?? 'lite';
  const { tableName, cacheSuffix } = ragModeArtifacts(effectiveMode);

  onLog?.(`rag: mode=${effectiveMode} table=${tableName} dual=${dualMode} codeRuntime=${options.resolvedModels?.codeRuntime ?? '?'}`);

  setEmbeddingLogger(onLog);

  // Configure embedding models if resolved models provided
  if (options.resolvedModels) {
    const nlpInfo = dualMode ? ` + nlp=${options.resolvedModels.nlpModel} (${options.resolvedModels.nlpRuntime})` : '';
    onLog?.(`rag: models — code=${options.resolvedModels.codeModel} (${options.resolvedModels.codeRuntime})${nlpInfo}`);
    configureModels(options.resolvedModels);
  }

  const store = new VectorStore(projectRoot, tableName, onLog);
  await store.init();

  if (rebuild) {
    await store.rebuild();
  }

  // If the vector store is empty but cache has entries, the DB was reset
  // (e.g. legacy table dropped during migration). Purge cache so all files
  // get re-indexed instead of being skipped as "already indexed".
  const storeStats = await store.stats();
  let cache = loadRagCache(projectRoot, cacheSuffix);
  if (storeStats.totalCards === 0 && Object.keys(cache.entries).length > 0) {
    onLog?.('vector store empty but cache exists — purging stale cache');
    cache = { entries: {} };
    saveRagCache(projectRoot, cache, cacheSuffix);
  }

  // Pre-warm code embedding model (always needed, starts the GGUF code container)
  // Use a non-empty string — nomic-embed-code crashes on empty input
  // NLP warmup is deferred to the batch NLP phase to avoid a container swap here.
  await embedCode('function warmup() {}');

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

  // Load NLP summary cache for per-function body-hash caching (dual mode only)
  const nlpSummaryCache = dualMode ? loadNlpSummaryCache(projectRoot, cacheSuffix) : undefined;

  // Accumulate results from all files via concurrent worker pool
  const results: IndexedFileResult[] = [];
  let fileCounter = 0;

  onPhase?.('code');
  await runWorkerPool({
    items: tasksToIndex,
    concurrency,
    isInterrupted,
    handler: async (task) => {
      const idx = ++fileCounter;
      const modeLabel = dualMode ? ' [dual]' : '';
      onLog(`[${idx}/${tasksToIndex.length}]${modeLabel} ${task.file}`);
      onFileStart?.(task.file);

      try {
        const result = dualMode
          ? await processFileForDualIndex(projectRoot, task, cache, options.indexModel!, nlpSummaryCache, true, options.conversationDir, options.semaphore)
          : await processFileForIndex(projectRoot, task, cache);

        if (result.cards.length > 0) {
          results.push(result);
        }
        onFileDone?.(task.file);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        onLog?.(`rag: failed to index ${task.file}: ${msg}`);

        // Fatal: GGUF container is unreachable — abort the entire indexing run
        if (msg.includes('fetch failed') || msg.includes('GGUF container failed') || msg.includes('No GGUF model is loaded')) {
          throw new Error(`GGUF container unreachable — aborting RAG indexing (${msg})`);
        }
      }
      onProgress?.(fileCounter, tasksToIndex.length);
    },
  });

  // Batch NLP embeddings: all code embeddings are done, now generate NLP embeddings
  // in a single pass. This avoids swapping GGUF containers back and forth per file.
  if (dualMode && results.length > 0) {
    onPhase?.('nlp');
    onLog?.(`rag: generating NLP embeddings for ${results.length} files (batch)...`);
    let nlpCounter = 0;
    for (const result of results) {
      if (result.cards.length > 0 && !result.nlpEmbeddings) {
        onFileStart?.(result.task.file);
        result.nlpEmbeddings = await generateNlpEmbeddings(result.cards);
        onFileDone?.(result.task.file);
      }
      nlpCounter++;
      onProgress?.(nlpCounter, results.length);
    }
    onLog?.('rag: NLP embeddings batch complete');
  }

  // Batch upsert all accumulated results sequentially
  onPhase?.('upsert');
  onLog?.(`rag: upserting ${results.length} file results to ${tableName}`);
  let cardsIndexed = 0;
  let filesIndexed = 0;

  for (const result of results) {
    // Delete all existing cards for this file first to remove stale entries
    // (e.g. functions that were removed or renamed since last indexing)
    await store.deleteByFile(result.task.file);
    await store.upsert(result.cards, result.embeddings, {
      nlpEmbeddings: result.nlpEmbeddings,
    });
    cardsIndexed += result.cards.length;
    filesIndexed++;

    // Update cache entries for this file's cards.
    // In dual mode, skip cards where NLP failed (zero vector) so they
    // get retried on the next run instead of being served stale.
    for (const card of result.cards) {
      if (result.nlpFailedIds?.has(card.id)) continue;
      cache.entries[card.id] = result.task.hash;
    }
  }

  // Single atomic cache write for all results
  if (results.length > 0) {
    saveRagCache(projectRoot, cache, cacheSuffix);

    // Merge and save NLP summary cache updates (dual mode only)
    if (nlpSummaryCache) {
      for (const result of results) {
        if (result.nlpCacheUpdates) {
          Object.assign(nlpSummaryCache.entries, result.nlpCacheUpdates);
        }
      }
      saveNlpSummaryCache(projectRoot, nlpSummaryCache, cacheSuffix);
    }
  }

  // Index doc sections from /docs/ and .anatoly/docs/ (dual mode only — needs NLP embeddings)
  let docSectionsIndexed = 0;
  if (dualMode) {
    onPhase?.('doc');
    // Project docs (docs/)
    try {
      docSectionsIndexed += await indexDocSections({
        projectRoot,
        vectorStore: store,
        docsDir: options.docsDir,
        cacheSuffix,
        chunkModel: options.indexModel,
        onLog,
        onProgress,
        onFileStart,
        onFileDone,
        isInterrupted,
        conversationDir: options.conversationDir,
        semaphore: options.semaphore,
      });
    } catch (err) {
      onLog(`rag: doc section indexing failed: ${(err as Error).message}`);
    }

    // Internal docs (.anatoly/docs/) — Story 29.18
    try {
      docSectionsIndexed += await indexDocSections({
        projectRoot,
        vectorStore: store,
        docsDir: join('.anatoly', 'docs'),
        cacheSuffix: `${cacheSuffix}-internal`,
        chunkModel: options.indexModel,
        onLog,
        onProgress,
        onFileStart,
        onFileDone,
        isInterrupted,
        conversationDir: options.conversationDir,
        semaphore: options.semaphore,
      });
    } catch (err) {
      onLog(`rag: internal doc section indexing failed: ${(err as Error).message}`);
    }
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
      docSectionsIndexed,
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
    docSectionsIndexed,
  };
}
