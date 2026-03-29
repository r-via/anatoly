// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { globSync } from 'tinyglobby';
import picomatch from 'picomatch';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { VectorStore } from './vector-store.js';
import { buildFunctionCards, buildFunctionId, needsReindex, embedCards, applyNlpSummaries, enrichCardsWithSummaries, generateNlpEmbeddings, generateDocEmbeddings, loadRagCache, saveRagCache, loadNlpSummaryCache, saveNlpSummaryCache, extractFunctionBody, computeBodyHash } from './indexer.js';
import type { NlpSummaryCache } from './indexer.js';
import { embedCode, embedNlp, setEmbeddingLogger, configureModels } from './embeddings.js';
import type { ResolvedModels } from './hardware-detect.js';
import { generateNlpSummaries } from './nlp-summarizer.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { contextLogger } from '../utils/log-context.js';
import { indexDocSections, areDocTreesIdentical } from './doc-indexer.js';
import type { Semaphore } from '../core/sdk-semaphore.js';

/**
 * RAG indexing mode. Determines the LanceDB table name and cache file suffix
 * used for vector storage. `'lite'` uses lightweight code-only embeddings;
 * `'advanced'` adds NLP summaries and hybrid search capabilities.
 */
export type RagMode = 'lite' | 'advanced';

/**
 * Configuration options for the RAG indexing pipeline. Controls which files
 * are indexed, how embeddings are generated, and provides lifecycle callbacks
 * for progress reporting and interruption.
 */
export interface RagIndexOptions {
  /** Absolute path to the project root directory. All task file paths are resolved relative to this. */
  projectRoot: string;
  /** AST-parsed task descriptors for each source file to index. */
  tasks: Task[];
  /** Model used for NLP summary generation (required — always dual). */
  indexModel: string;
  /** Resolved embedding models (from hardware detection). Configures code/NLP model selection. */
  resolvedModels?: ResolvedModels;
  /** RAG mode determines table name and cache file. */
  ragMode?: RagMode;
  /** Directory containing markdown docs for doc section indexing (default: 'docs'). */
  docsDir?: string;
  /** When true, drops and rebuilds the LanceDB table and purges index caches. */
  rebuild?: boolean;
  /** Maximum number of files to process in parallel (default: 4). */
  concurrency?: number;
  /** Enable verbose logging output. */
  verbose?: boolean;
  /** Callback invoked for each log message during indexing. */
  onLog: (message: string) => void;
  /** Callback reporting indexing progress as (current, total) file counts. */
  onProgress?: (current: number, total: number) => void;
  /** Callback invoked when a file begins processing. */
  onFileStart?: (file: string) => void;
  /** Callback invoked when a file finishes processing. */
  onFileDone?: (file: string) => void;
  /** Called when indexing transitions between phases. */
  onPhase?: (phase: 'code' | 'nlp' | 'upsert' | 'doc-project' | 'doc-internal') => void;
  /** Returns true if the indexing run should be aborted (checked between files). */
  isInterrupted: () => boolean;
  /** Full path to conversations/ dir for LLM conversation dumps. */
  conversationDir?: string;
  /** Global SDK concurrency semaphore (Claude). */
  semaphore?: Semaphore;
  /** Gemini-specific concurrency semaphore (used when indexModel is a Gemini model). */
  geminiSemaphore?: Semaphore;
  /** When set, scopes --rebuild-rag to only purge entries matching this glob (instead of dropping the entire table). */
  fileFilter?: string;
}

/**
 * Summary statistics returned after a RAG indexing run. The `*Indexed` counters
 * reflect how many items were newly processed in this run, while the `total*`
 * counters reflect the cumulative state of the vector store after indexing.
 */
export interface RagIndexResult {
  /** The initialized vector store instance (ready for queries after indexing). */
  vectorStore: VectorStore;
  /** Number of function cards newly indexed in this run. */
  cardsIndexed: number;
  /** Number of source files that had cards indexed in this run. */
  filesIndexed: number;
  /** Total function cards in the vector store after indexing (including previously cached). */
  totalCards: number;
  /** Total source files represented in the vector store after indexing. */
  totalFiles: number;
  /** Total doc sections indexed (project + internal). */
  docSectionsIndexed: number;
  /** Doc sections from project docs/ (newly indexed count). */
  projectDocSections: number;
  /** True when project docs exist but were all cache-hits. */
  projectDocsCached: boolean;
  /** Doc sections from .anatoly/docs/ (newly indexed count). */
  internalDocSections: number;
  /** True when internal docs exist but were all cache-hits. */
  internalDocsCached: boolean;
  /** True when docs/ and .anatoly/docs/ were byte-identical (project docs aliased, not chunked). */
  docsIdentical: boolean;
  /** Total LLM cost (USD) incurred during RAG indexing (NLP summaries + doc chunking). */
  costUsd: number;
}

/**
 * Result of processing a single file for indexing.
 * Contains cards and pre-computed embeddings — does NOT touch VectorStore or cache.
 */
export interface IndexedFileResult {
  task: Task;
  cards: FunctionCard[];
  embeddings: number[][];
  /** NLP embeddings (same length as cards). */
  nlpEmbeddings?: number[][];
  /** Doc-oriented NLP embeddings for gap detection (same length as cards). */
  docEmbeddings?: number[][];
  /** Card IDs where NLP summarization failed (zero vector). Excluded from cache. */
  nlpFailedIds?: Set<string>;
  /** NLP summary cache entries produced during this file's processing. */
  nlpCacheUpdates?: Record<string, { bodyHash: string; summary: import('./nlp-summarizer.js').NlpSummary }>;
  /** Total LLM cost (USD) incurred for NLP summarization of this file. */
  costUsd?: number;
  /** Raw function bodies, carried over so the NLP phase can summarize without re-reading files. */
  functionBodies?: string[];
}

/**
 * Read source and build cards + code embeddings for a single file.
 * Filters the task's symbols to function/method/hook kinds, reads the source
 * from disk, builds function cards, and kicks off code embedding generation.
 *
 * @param projectRoot - Absolute path to the project root for resolving file paths.
 * @param task - AST-parsed task descriptor for the file to process.
 * @param cache - RAG index cache mapping card IDs to file hashes; cards already
 *   cached with the current hash are skipped.
 * @returns The source text, cards needing indexing, and a promise for their code
 *   embeddings, or `null` if no functions need indexing (no function symbols,
 *   file unreadable, or all cards already cached).
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
 * Process a single file for RAG indexing: build cards from AST and embed code.
 *
 * When {@link deferNlpEmbeddings} is true (code phase), only code embeddings are
 * generated and raw function bodies are returned for later LLM summarization.
 * When false (standalone mode), LLM summarization and NLP embeddings are done
 * in the same call.
 *
 * @param deferNlpEmbeddings - When true, skips LLM summarization and NLP
 *   embeddings entirely; returns raw cards + functionBodies for the NLP phase.
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
  geminiSemaphore?: Semaphore,
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

  if (deferNlpEmbeddings) {
    // Code-only phase: return raw cards + bodies for the NLP phase to summarize later
    return { task, cards: built.toIndex, embeddings: codeEmbeddings, functionBodies };
  }

  // Non-deferred path: summarize + embed in one shot
  const { mergedSummaries, nlpCacheUpdates, costUsd: nlpCostUsd } = await summarizeFile(
    built.toIndex, functionBodies, task.file, indexModel, projectRoot,
    nlpSummaryCache, conversationDir, semaphore, geminiSemaphore,
  );

  const { enrichedCards, nlpEmbeddings, docEmbeddings, nlpFailedIds } = await applyNlpSummaries(built.toIndex, mergedSummaries);

  return {
    task,
    cards: enrichedCards,
    embeddings: codeEmbeddings,
    nlpEmbeddings,
    docEmbeddings,
    nlpFailedIds,
    nlpCacheUpdates,
    costUsd: nlpCostUsd,
  };
}

/**
 * Run NLP summarization for a single file: partition functions into cached vs
 * uncached, call the LLM for uncached ones, and return merged summaries.
 */
async function summarizeFile(
  cards: FunctionCard[],
  functionBodies: string[],
  filePath: string,
  indexModel: string,
  projectRoot: string,
  nlpSummaryCache?: NlpSummaryCache,
  conversationDir?: string,
  semaphore?: Semaphore,
  geminiSemaphore?: Semaphore,
): Promise<{
  mergedSummaries: Map<string, import('./nlp-summarizer.js').NlpSummary>;
  nlpCacheUpdates: Record<string, { bodyHash: string; summary: import('./nlp-summarizer.js').NlpSummary }>;
  costUsd: number;
}> {
  const mergedSummaries = new Map<string, import('./nlp-summarizer.js').NlpSummary>();
  const uncachedCards: FunctionCard[] = [];
  const uncachedBodies: string[] = [];
  const nlpCacheUpdates: Record<string, { bodyHash: string; summary: import('./nlp-summarizer.js').NlpSummary }> = {};

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const body = functionBodies[i];
    const bodyHash = computeBodyHash(body);
    const cached = nlpSummaryCache?.entries[card.id];

    if (cached && cached.bodyHash === bodyHash) {
      mergedSummaries.set(card.id, cached.summary);
      nlpCacheUpdates[card.id] = cached;
    } else {
      uncachedCards.push(card);
      uncachedBodies.push(body);
    }
  }

  let costUsd = 0;
  if (uncachedCards.length > 0) {
    const nlpResult = await generateNlpSummaries(
      uncachedCards, uncachedBodies, filePath, indexModel, projectRoot,
      conversationDir, semaphore, geminiSemaphore,
    );
    costUsd = nlpResult.costUsd;

    for (let i = 0; i < uncachedCards.length; i++) {
      const card = uncachedCards[i];
      const summary = nlpResult.summaries.get(card.id);
      if (summary) {
        mergedSummaries.set(card.id, summary);
        const bodyHash = computeBodyHash(uncachedBodies[i]);
        nlpCacheUpdates[card.id] = { bodyHash, summary };
      }
    }
  }

  return { mergedSummaries, nlpCacheUpdates, costUsd };
}

/** Derive LanceDB table name and cache suffix from RAG mode. */
export function ragModeArtifacts(mode: RagMode): { tableName: string; cacheSuffix: string } {
  return { tableName: `function_cards_${mode}`, cacheSuffix: mode };
}

/**
 * Run the full RAG indexing pipeline: build function cards from AST, compute
 * code embeddings locally, generate NLP summaries via LLM, compute NLP
 * embeddings for hybrid search, and upsert everything into the vector store.
 * Also indexes doc sections from project and internal documentation directories.
 *
 * Execution proceeds in phases: code embedding, NLP embedding (batched),
 * vector store upsert, project doc indexing, and internal doc indexing.
 * Stale entries for files no longer in the project are garbage-collected
 * before indexing begins.
 *
 * @param options - Configuration controlling the indexing run. See {@link RagIndexOptions}.
 * @returns Summary statistics for the completed indexing run. See {@link RagIndexResult}.
 */
export async function indexProject(options: RagIndexOptions): Promise<RagIndexResult> {
  const { projectRoot, tasks, rebuild, concurrency = 4, onLog, onProgress, onFileStart, onFileDone, onPhase, isInterrupted } = options;
  // Doc chunking is now 1 LLM call per file (batched), so we can process more
  // files in parallel — let the semaphore be the sole concurrency limiter.
  const docConcurrency = options.semaphore?.capacity ?? concurrency;
  const effectiveMode = options.ragMode ?? 'lite';
  const { tableName, cacheSuffix } = ragModeArtifacts(effectiveMode);

  onLog?.(`rag: mode=${effectiveMode} table=${tableName} codeRuntime=${options.resolvedModels?.codeRuntime ?? '?'}`);

  setEmbeddingLogger(onLog);

  // Configure embedding models if resolved models provided
  if (options.resolvedModels) {
    onLog?.(`rag: models — code=${options.resolvedModels.codeModel} (${options.resolvedModels.codeRuntime}) + nlp=${options.resolvedModels.nlpModel} (${options.resolvedModels.nlpRuntime})`);
    configureModels(options.resolvedModels);
  }

  const store = new VectorStore(projectRoot, tableName, onLog);
  await store.init();

  if (rebuild && options.fileFilter) {
    // Scoped rebuild: only purge entries matching the file glob
    const isMatch = picomatch(options.fileFilter);
    const indexedFiles = await store.listIndexedFiles();
    let purgedCount = 0;
    const cache = loadRagCache(projectRoot, cacheSuffix);
    for (const file of indexedFiles) {
      if (isMatch(file)) {
        await store.deleteByFile(file, 'function_card');
        purgedCount++;
      }
    }
    // Purge matching entries from index cache and NLP summary cache
    for (const key of Object.keys(cache.entries)) {
      // Cache keys are function IDs like "file::startLine::endLine"
      if (isMatch(key.split('::')[0])) {
        delete cache.entries[key];
      }
    }
    saveRagCache(projectRoot, cache, cacheSuffix);
    const nlpCache = loadNlpSummaryCache(projectRoot, cacheSuffix);
    if (nlpCache) {
      for (const key of Object.keys(nlpCache.entries)) {
        if (isMatch(key.split('::')[0])) {
          delete nlpCache.entries[key];
        }
      }
      saveNlpSummaryCache(projectRoot, nlpCache, cacheSuffix);
    }
    onLog?.(`rebuild (scoped): purged ${purgedCount} files matching ${options.fileFilter}`);
  } else if (rebuild) {
    await store.rebuild();
    // Purge index caches (file→sectionIDs mappings are invalid after table drop)
    // NLP summary cache and chunk cache are preserved (content-based, not tied to LanceDB rows)
    onLog?.('rebuild: purging index caches (code + doc)');
    saveRagCache(projectRoot, { entries: {} }, cacheSuffix);
    const { saveDocCacheToRagCache: saveDc } = await import('./doc-indexer.js');
    saveDc(projectRoot, cacheSuffix, {});
    saveDc(projectRoot, `${cacheSuffix}-internal`, {});
  }

  let cache = loadRagCache(projectRoot, cacheSuffix);

  // Pre-warm code embedding model (always needed, starts the GGUF code container)
  // Use a non-empty string — nomic-embed-code crashes on empty input
  // NLP warmup is deferred to the batch NLP phase to avoid a container swap here.
  await embedCode('function warmup() {}');

  // Garbage-collect stale function card entries (not doc_sections) for files no longer in the project
  const currentFiles = new Set(tasks.map((t) => t.file));
  const indexedFiles = await store.listIndexedFiles();
  for (const orphan of indexedFiles) {
    if (!currentFiles.has(orphan)) {
      await store.deleteByFile(orphan, 'function_card');
      onLog(`gc: removed stale cards for ${orphan}`);
    }
  }

  const tasksWithFunctions = tasks.filter((t) =>
    t.symbols.some((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
  );

  const log = contextLogger();
  log.debug(
    { totalFiles: tasks.length, filesWithFunctions: tasksWithFunctions.length },
    'RAG index: filtering files',
  );

  // Load NLP summary cache for per-function body-hash caching
  const nlpSummaryCache = loadNlpSummaryCache(projectRoot, cacheSuffix);

  // Filter out files where all function cards are already cached for the current hash
  // AND have a valid NLP summary cache entry (cross-validation prevents stale cache
  // from a crashed run leaving functions without NLP summaries)
  const tasksToIndex = tasksWithFunctions.filter((task) => {
    const fnSymbols = task.symbols.filter(
      (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
    );
    return !fnSymbols.every((symbol) => {
      const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
      if (cache.entries[id] !== task.hash) return false;
      // Cross-check: ensure NLP summary exists for this function
      if (!nlpSummaryCache.entries[id]) return false;
      return true;
    });
  });

  // Accumulate results from all files via concurrent worker pool
  const results: IndexedFileResult[] = [];
  let fileCounter = 0;
  let fileStartCounter = 0;

  onPhase?.('code');
  await runWorkerPool({
    items: tasksToIndex,
    concurrency,
    isInterrupted,
    handler: async (task) => {
      const fileNum = ++fileStartCounter;
      onLog(`[${fileNum}/${tasksToIndex.length}] ${task.file}`);
      onFileStart?.(task.file);

      try {
        const result = await processFileForDualIndex(projectRoot, task, cache, options.indexModel, nlpSummaryCache, true, options.conversationDir, options.semaphore, options.geminiSemaphore);

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
      fileCounter++;
      onProgress?.(fileCounter, tasksToIndex.length);
    },
  });

  // NLP phase: summarize via LLM (concurrent) then embed (sequential to avoid GGUF container swaps)
  onLog?.(`rag: code phase done — ${results.length} files with cards (of ${tasksToIndex.length} indexed)`);
  if (results.length > 0) {
    onPhase?.('nlp');

    // Step 1 — LLM summarization (concurrent via worker pool)
    onLog?.(`rag: summarizing ${results.length} files via LLM...`);
    let nlpCounter = 0;
    await runWorkerPool({
      items: results,
      concurrency,
      isInterrupted,
      handler: async (result) => {
        if (result.cards.length === 0 || !result.functionBodies) return;
        onFileStart?.(result.task.file);

        const { mergedSummaries, nlpCacheUpdates, costUsd } = await summarizeFile(
          result.cards, result.functionBodies, result.task.file, options.indexModel,
          projectRoot, nlpSummaryCache, options.conversationDir, options.semaphore, options.geminiSemaphore,
        );
        const { enrichedCards, nlpFailedIds } = enrichCardsWithSummaries(result.cards, mergedSummaries);
        result.cards = enrichedCards;
        result.nlpFailedIds = nlpFailedIds;
        result.nlpCacheUpdates = nlpCacheUpdates;
        result.costUsd = costUsd;
        result.functionBodies = undefined; // free memory

        onFileDone?.(result.task.file);
        nlpCounter++;
        onProgress?.(nlpCounter, results.length);
      },
    });

    // Step 2 — NLP + doc embeddings (sequential to avoid swapping GGUF containers)
    onLog?.(`rag: embedding summaries for ${results.length} files...`);
    for (const result of results) {
      if (result.cards.length > 0 && !result.nlpEmbeddings) {
        result.nlpEmbeddings = await generateNlpEmbeddings(result.cards);
        result.docEmbeddings = await generateDocEmbeddings(result.cards);
      }
    }
    onLog?.('rag: NLP phase complete');
  }

  // Batch upsert all accumulated results sequentially
  onPhase?.('upsert');
  onLog?.(`rag: upserting ${results.length} file results to ${tableName}`);
  let cardsIndexed = 0;
  let filesIndexed = 0;
  let ragCostUsd = 0;

  // Accumulate NLP summarization costs from file processing
  for (const r of results) {
    ragCostUsd += r.costUsd ?? 0;
  }

  for (const result of results) {
    // Delete all existing cards for this file first to remove stale entries
    // (e.g. functions that were removed or renamed since last indexing)
    await store.deleteByFile(result.task.file);
    await store.upsert(result.cards, result.embeddings, {
      nlpEmbeddings: result.nlpEmbeddings,
      docEmbeddings: result.docEmbeddings,
    });
    cardsIndexed += result.cards.length;
    filesIndexed++;

    // Update cache entries for this file's cards.
    // Skip cards where NLP failed (zero vector) so they
    // get retried on the next run instead of being served stale.
    for (const card of result.cards) {
      if (result.nlpFailedIds?.has(card.id)) continue;
      cache.entries[card.id] = result.task.hash;
    }
  }

  // Single atomic cache write for all results
  if (results.length > 0) {
    saveRagCache(projectRoot, cache, cacheSuffix);

    // Merge and save NLP summary cache updates
    for (const result of results) {
      if (result.nlpCacheUpdates) {
        Object.assign(nlpSummaryCache.entries, result.nlpCacheUpdates);
      }
    }
    saveNlpSummaryCache(projectRoot, nlpSummaryCache, cacheSuffix);
  }

  // Index doc sections from /docs/ (project) and .anatoly/docs/ (internal)
  let docSectionsIndexed = 0;
  let projectDocSections = 0;
  let projectDocsCached = false;
  let internalDocSections = 0;
  let internalDocsCached = false;

  // Check if docs/ and .anatoly/docs/ are byte-identical to avoid double-chunking
  const internalDocsDir = join('.anatoly', 'docs');
  let docsIdentical = false;
  try {
    docsIdentical = areDocTreesIdentical(projectRoot, options.docsDir ?? 'docs', internalDocsDir);
  } catch (err) {
    onLog(`rag: doc identity check failed, falling back to double indexing: ${(err as Error).message}`);
  }

  if (docsIdentical) {
    // Trees are identical — index only internal, then alias as project
    onLog('rag: docs/ identical to .anatoly/docs/ — indexing internal only, aliasing project');

    onPhase?.('doc-project'); // emit both phases so UI task transitions work
    onPhase?.('doc-internal');
    try {
      const intResult = await indexDocSections({
        projectRoot,
        vectorStore: store,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        chunkModel: options.indexModel,
        onLog,
        onProgress,
        onFileStart,
        onFileDone,
        isInterrupted,
        conversationDir: options.conversationDir,
        semaphore: options.semaphore,
        concurrency: docConcurrency,
        docSource: 'internal',
      });
      internalDocSections = intResult.sections;
      internalDocsCached = intResult.cached;
      ragCostUsd += intResult.costUsd;
      docSectionsIndexed += internalDocSections;

      // Alias internal → project in vector store (don't add to docSectionsIndexed — same content)
      const aliased = await store.aliasDocSource('internal', 'project', options.docsDir ?? 'docs');
      projectDocSections = aliased;
      projectDocsCached = intResult.cached;
    } catch (err) {
      onLog(`rag: internal doc section indexing failed: ${(err as Error).message}`);
    }
  } else {
    // Trees differ — index both independently (original behavior)

    // Project docs (docs/)
    onPhase?.('doc-project');
    try {
      const projResult = await indexDocSections({
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
        concurrency: docConcurrency,
        docSource: 'project',
      });
      projectDocSections = projResult.sections;
      projectDocsCached = projResult.cached;
      ragCostUsd += projResult.costUsd;
      docSectionsIndexed += projectDocSections;
    } catch (err) {
      onLog(`rag: doc section indexing failed: ${(err as Error).message}`);
    }

    // Internal docs (.anatoly/docs/)
    onPhase?.('doc-internal');
    try {
      const intResult = await indexDocSections({
        projectRoot,
        vectorStore: store,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        chunkModel: options.indexModel,
        onLog,
        onProgress,
        onFileStart,
        onFileDone,
        isInterrupted,
        conversationDir: options.conversationDir,
        semaphore: options.semaphore,
        concurrency: docConcurrency,
        docSource: 'internal',
      });
      internalDocSections = intResult.sections;
      internalDocsCached = intResult.cached;
      ragCostUsd += intResult.costUsd;
      docSectionsIndexed += internalDocSections;
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
    docSectionsIndexed,
    projectDocSections,
    projectDocsCached,
    internalDocSections,
    internalDocsCached,
    docsIdentical,
    costUsd: ragCostUsd,
  };
}
