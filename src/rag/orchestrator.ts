// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import picomatch from 'picomatch';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { VectorStore } from './vector-store.js';
import { buildFunctionCards, buildDeclarationCards, buildFunctionId, isFunctionKind, isIndexableKind, needsReindex, embedCards, enrichCardsWithSummaries, generateNlpEmbeddings, generateDocEmbeddings, loadRagCache, saveRagCache, loadNlpSummaryCache, saveNlpSummaryCache, extractFunctionBody, computeBodyHash } from './indexer.js';
import type { NlpSummaryCache } from './indexer.js';
import { embedCode, setEmbeddingLogger, configureModels } from './embeddings.js';
import type { ResolvedModels } from './hardware-detect.js';
import { generateNlpSummaries } from './nlp-summarizer.js';
import { runWorkerPool } from '../core/platform/index.js';
import { contextLogger } from '../utils/log-context.js';
import { indexDocSources } from './doc-sources.js';
import type { TransportRouter } from '../core/transports/index.js';

/**
 * RAG indexing mode. Determines the LanceDB table name and cache file suffix
 * used for vector storage. `'lite'` uses local ONNX embeddings; `'advanced'`
 * uses local GGUF Docker embeddings; `'external'` routes embeddings through
 * a third-party SDK provider (OpenAI, Mistral, OpenRouter, etc.).
 */
export type RagMode = 'lite' | 'advanced' | 'external';

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
  /**
   * `documentation.reference.paths` globs from the project config. When
   * provided, the indexer enumerates files matching these globs (including
   * root-level entries like `README.md` that fall outside any single
   * `docsDir`). When absent, falls back to globbing `docsDir`.
   */
  referencePaths?: string[];
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
  /** Mode-aware transport router — handles concurrency, circuit breaking, and transport selection. */
  router?: TransportRouter;
  /** When set, scopes --rebuild-rag to only purge entries matching this glob (instead of dropping the entire table). */
  fileFilter?: string;
  /** Auto-drop the LanceDB table when stored vector dimensions don't match
   *  the active embedding model. Default true — leaving stale dims in place
   *  silently corrupts search ranking. Sourced from
   *  `runtime.rag.rebuild_on_drift` in .anatoly.yml. */
  rebuildOnDrift?: boolean;
  /** Per-LLM-call wall-clock budget in ms (= `runtime.timeout_per_call * 1000`).
   *  Forwarded to NLP summarization calls so a stuck SDK subprocess aborts
   *  instead of stalling the indexer indefinitely. */
  timeoutMs?: number;
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
 *   embeddings, or `null` if nothing needs indexing (no indexable symbols,
 *   file unreadable, or all cards already cached).
 */
function readAndBuildCards(
  projectRoot: string,
  task: Task,
  cache: { entries: Record<string, string> },
): { source: string; toIndex: FunctionCard[]; embeddings: Promise<number[][]> } | null {
  const indexableSymbols = task.symbols.filter((s) => isIndexableKind(s.kind));

  if (indexableSymbols.length === 0) return null;

  const absPath = resolve(projectRoot, task.file);
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    // File deleted between scan and index — skip silently
    return null;
  }

  // Function cards (LLM-summarized) plus declaration cards (AST summary, no LLM)
  // so data-only files still get an NLP vector for reference-doc routing.
  const cards = [...buildFunctionCards(task, source), ...buildDeclarationCards(task, source)];
  // The upsert path deletes a file's existing rows wholesale (store.deleteByFile)
  // before writing the cards returned here, so a file must be re-indexed as a
  // COMPLETE unit. Filtering down to only the cards whose hash changed would let
  // deleteByFile drop the unchanged-but-cached cards and the partial upsert would
  // never put them back, silently orphaning them. This bit mixed files (functions
  // + declarations): when a pre-existing file's function cards were already cached
  // but its declaration cards were newly introduced, the functions were deleted and
  // not re-inserted. Gate on "does any card need (re)indexing?" to keep skipping
  // untouched files, but then rebuild the ENTIRE card set. Unchanged cards reuse
  // their body-hash-keyed NLP summary, so this re-embeds code locally (cheap) without
  // re-paying the LLM. This also self-heals stale pre-declaration caches on the next
  // incremental run (the new declaration cards pull the file back into the pipeline).
  if (!cards.some((card) => needsReindex(cache, card, task.hash))) return null;
  const toIndex = cards;

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
  router?: TransportRouter,
  timeoutMs?: number,
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
    nlpSummaryCache, conversationDir, router, timeoutMs,
  );

  // Enrich then batch-embed (NLP + doc spaces), mirroring the deferred path
  // below. Replaces the superseded `applyNlpSummaries` monolith, which fused
  // these three steps and embedded one card at a time instead of batching.
  const { enrichedCards, nlpFailedIds } = enrichCardsWithSummaries(built.toIndex, mergedSummaries);
  const nlpEmbeddings = await generateNlpEmbeddings(enrichedCards);
  const docEmbeddings = await generateDocEmbeddings(enrichedCards);

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
  router?: TransportRouter,
  timeoutMs?: number,
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
    // Declaration cards carry an AST-synthesized summary — never call the LLM
    // for them (and never enter them into mergedSummaries; enrichCardsWithSummaries
    // keeps their existing summary and does not flag them failed).
    if (card.kind === 'declaration') continue;
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
      conversationDir, router, timeoutMs,
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
  // files in parallel — let the router semaphore be the sole concurrency limiter.
  const anthropicSem = options.router?.semaphores.get('anthropic');
  const docConcurrency = anthropicSem?.capacity ?? concurrency;
  const effectiveMode = options.ragMode ?? 'lite';
  const { tableName, cacheSuffix } = ragModeArtifacts(effectiveMode);

  onLog?.(`mode=${effectiveMode} table=${tableName} codeRuntime=${options.resolvedModels?.codeRuntime ?? '?'}`);

  setEmbeddingLogger(onLog);

  // Configure embedding models if resolved models provided
  if (options.resolvedModels) {
    onLog?.(`models — code=${options.resolvedModels.codeModel} (${options.resolvedModels.codeRuntime}) + nlp=${options.resolvedModels.nlpModel} (${options.resolvedModels.nlpRuntime})`);
    configureModels(options.resolvedModels);
  }

  const store = new VectorStore(projectRoot, tableName, onLog, options.rebuildOnDrift ?? true);
  await store.init();

  if (rebuild && options.fileFilter) {
    // Scoped rebuild: only purge entries matching the file glob
    const isMatch = picomatch(options.fileFilter);
    const indexedFiles = await store.listIndexedFiles();
    let purgedCount = 0;
    const cache = loadRagCache(projectRoot, cacheSuffix);
    for (const file of indexedFiles) {
      if (isMatch(file)) {
        await store.deleteByFile(file, 'function');
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
    const nlpCache = loadNlpSummaryCache(projectRoot);
    if (nlpCache) {
      for (const key of Object.keys(nlpCache.entries)) {
        if (isMatch(key.split('::')[0])) {
          delete nlpCache.entries[key];
        }
      }
      saveNlpSummaryCache(projectRoot, nlpCache);
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
  } else if (store.wasTableReset()) {
    // init() auto-healed a drifted / stale-schema table by dropping it. The
    // on-disk index cache now points at cards that no longer exist, so without
    // purging it the filter below would skip every "already cached" function
    // and leave the freshly emptied table without cards. Purge the code + doc
    // index caches (same as --rebuild-rag); the NLP summary cache is preserved
    // (content-hash keyed) so summaries are reused rather than re-generated.
    onLog?.('rag cache purge: table was auto-rebuilt during init (drift) — forcing full re-index');
    saveRagCache(projectRoot, { entries: {} }, cacheSuffix);
    const { saveDocCacheToRagCache: saveDc } = await import('./doc-indexer.js');
    saveDc(projectRoot, cacheSuffix, {});
    saveDc(projectRoot, `${cacheSuffix}-internal`, {});
  }

  const cache = loadRagCache(projectRoot, cacheSuffix);

  // Pre-warm code embedding model (always needed, starts the GGUF code container)
  // Use a non-empty string — nomic-embed-code crashes on empty input
  // NLP warmup is deferred to the batch NLP phase to avoid a container swap here.
  await embedCode('function warmup() {}');

  // Garbage-collect stale function card entries (not doc_sections) for files no longer in the project
  const currentFiles = new Set(tasks.map((t) => t.file));
  const indexedFiles = await store.listIndexedFiles();
  for (const orphan of indexedFiles) {
    if (!currentFiles.has(orphan)) {
      await store.deleteByFile(orphan, 'function');
      onLog(`gc: removed stale cards for ${orphan}`);
    }
  }

  const tasksWithSymbols = tasks.filter((t) =>
    t.symbols.some((s) => isIndexableKind(s.kind)),
  );

  // Garbage-collect orphaned cache entries whose card IDs no longer match
  // any current task symbol (e.g. after parser changes shift line ranges).
  const validIds = new Set<string>();
  for (const task of tasksWithSymbols) {
    for (const s of task.symbols) {
      if (isIndexableKind(s.kind)) {
        validIds.add(buildFunctionId(task.file, s.line_start, s.line_end));
      }
    }
  }
  let gcCacheCount = 0;
  for (const id of Object.keys(cache.entries)) {
    if (!validIds.has(id)) { delete cache.entries[id]; gcCacheCount++; }
  }
  if (gcCacheCount > 0) {
    onLog(`gc: removed ${gcCacheCount} orphaned cache entries`);
    saveRagCache(projectRoot, cache, cacheSuffix);
  }

  const log = contextLogger();
  log.debug(
    { totalFiles: tasks.length, filesWithSymbols: tasksWithSymbols.length },
    'RAG index: filtering files',
  );

  // Load NLP summary cache for per-function body-hash caching
  // (mode-agnostic — same content regardless of lite/advanced backend)
  const nlpSummaryCache = loadNlpSummaryCache(projectRoot);

  // GC orphaned NLP summary entries too
  let gcNlpCount = 0;
  for (const id of Object.keys(nlpSummaryCache.entries)) {
    if (!validIds.has(id)) { delete nlpSummaryCache.entries[id]; gcNlpCount++; }
  }
  if (gcNlpCount > 0) {
    onLog(`gc: removed ${gcNlpCount} orphaned NLP summary cache entries`);
    saveNlpSummaryCache(projectRoot, nlpSummaryCache);
  }

  // Filter out files where all cards are already cached for the current hash
  // AND (for function cards) have a valid NLP summary cache entry (cross-validation
  // prevents stale cache from a crashed run leaving functions without NLP summaries).
  // Declaration cards have no NLP-summary cache entry (AST summary, no LLM), so only
  // their code-cache hash is checked.
  const tasksToIndex = tasksWithSymbols.filter((task) => {
    const indexableSymbols = task.symbols.filter((s) => isIndexableKind(s.kind));
    return !indexableSymbols.every((symbol) => {
      const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
      if (cache.entries[id] !== task.hash) return false;
      // Cross-check: ensure NLP summary exists (function cards only).
      if (isFunctionKind(symbol.kind) && !nlpSummaryCache.entries[id]) return false;
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
        const result = await processFileForDualIndex(projectRoot, task, cache, options.indexModel, nlpSummaryCache, true, options.conversationDir, options.router, options.timeoutMs);

        if (result.cards.length > 0) {
          results.push(result);
        }
        onFileDone?.(task.file);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        onLog?.(`failed to index ${task.file}: ${msg}`);

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
  onLog?.(`code phase done — ${results.length} files with cards (of ${tasksToIndex.length} indexed)`);
  if (results.length > 0) {
    onPhase?.('nlp');

    // Step 1 — LLM summarization (concurrent via worker pool)
    onLog?.(`summarizing ${results.length} files via LLM...`);
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
          projectRoot, nlpSummaryCache, options.conversationDir, options.router, options.timeoutMs,
        );
        const { enrichedCards, nlpFailedIds } = enrichCardsWithSummaries(result.cards, mergedSummaries);
        result.cards = enrichedCards;
        result.nlpFailedIds = nlpFailedIds;
        result.nlpCacheUpdates = nlpCacheUpdates;
        result.costUsd = costUsd;
        result.functionBodies = undefined; // free memory

        // Stream the NLP summary cache immediately so an interrupt never
        // discards the (paid) LLM summaries for this file. atomicWriteJson makes
        // the concurrent writes safe; each writes the full, monotonically
        // growing cache, so the last writer always persists a superset.
        if (nlpCacheUpdates && Object.keys(nlpCacheUpdates).length > 0) {
          Object.assign(nlpSummaryCache.entries, nlpCacheUpdates);
          saveNlpSummaryCache(projectRoot, nlpSummaryCache);
        }

        if (nlpFailedIds.size > 0) {
          const failedNames = result.cards.filter((c) => nlpFailedIds.has(c.id)).map((c) => c.name);
          onLog?.(`⚠ ${result.task.file}: ${nlpFailedIds.size}/${result.cards.length} functions failed NLP summarization (${failedNames.join(', ')}) — will retry next run`);
        }

        onFileDone?.(result.task.file);
        nlpCounter++;
        onProgress?.(nlpCounter, results.length);
      },
    });

    onLog?.('NLP summaries complete');
  }

  // Embed + upsert + persist, one file at a time. The cache is streamed (atomic
  // write) after EVERY file so an interrupted run RESUMES instead of restarting:
  // a file whose cards are in the table AND whose id→hash entry is on disk is
  // filtered out of tasksToIndex on the next run. NLP summaries were already
  // streamed per file above, so an interrupt never re-pays the LLM cost.
  // Embeddings stay sequential to avoid swapping GGUF containers per file.
  onPhase?.('upsert');
  onLog?.(`embedding + upserting ${results.length} file results to ${tableName}`);
  let cardsIndexed = 0;
  let filesIndexed = 0;
  let ragCostUsd = 0;
  let upsertCounter = 0;
  for (const result of results) {
    // Stop cleanly on interrupt: everything upserted so far is already persisted
    // (cache streamed per file), so the next run resumes from here.
    if (isInterrupted()) break;
    ragCostUsd += result.costUsd ?? 0;
    upsertCounter++;
    if (result.cards.length === 0) {
      onProgress?.(upsertCounter, results.length);
      continue;
    }

    if (!result.nlpEmbeddings) {
      result.nlpEmbeddings = await generateNlpEmbeddings(result.cards);
      result.docEmbeddings = await generateDocEmbeddings(result.cards);
    }

    // Delete stale cards for this file (removed/renamed functions), then upsert.
    await store.deleteByFile(result.task.file);
    await store.upsert(result.cards, result.embeddings, {
      nlpEmbeddings: result.nlpEmbeddings,
      docEmbeddings: result.docEmbeddings,
    });
    cardsIndexed += result.cards.length;
    filesIndexed++;

    // Stream this file's cache entries now. Skip NLP-failed cards (zero vector)
    // so they retry next run instead of being served stale.
    for (const card of result.cards) {
      if (result.nlpFailedIds?.has(card.id)) continue;
      cache.entries[card.id] = result.task.hash;
    }
    saveRagCache(projectRoot, cache, cacheSuffix);
    onProgress?.(upsertCounter, results.length);
  }

  // Final safety write (the cache was already streamed per file above).
  if (results.length > 0) {
    saveRagCache(projectRoot, cache, cacheSuffix);
    saveNlpSummaryCache(projectRoot, nlpSummaryCache);
  }

  // Index doc sections from /docs/ (project) and the internal docs tree.
  // The docsIdentical / alias decision tree is unified in `indexDocSources`
  // (doc-indexer.ts) and shared with the post-update incremental reindex
  // (reindexDocsAfterUpdate), so both passes stay byte-consistent.
  const docResult = await indexDocSources({
    projectRoot,
    vectorStore: store,
    docsDir: options.docsDir ?? 'docs',
    internalDocsDir: join('.anatoly', 'state', 'internal-docs'),
    internalFlowsDir: join('.anatoly', 'state', 'internal-flows'),
    cacheSuffix,
    chunkModel: options.indexModel,
    referencePaths: options.referencePaths,
    onLog,
    onProgress,
    onFileStart,
    onFileDone,
    onPhase,
    isInterrupted,
    conversationDir: options.conversationDir,
    router: options.router,
    concurrency: docConcurrency,
  });
  const {
    docSectionsIndexed,
    projectDocSections,
    projectDocsCached,
    internalDocSections,
    internalDocsCached,
    docsIdentical,
  } = docResult;
  ragCostUsd += docResult.costUsd;

  const stats = await store.stats();

  log.debug(
    {
      cardsIndexed,
      filesIndexed,
      cached: tasksWithSymbols.length - tasksToIndex.length,
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
