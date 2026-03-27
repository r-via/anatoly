// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename, dirname, extname } from 'node:path';
import { toOutputName } from '../utils/cache.js';
import { runWithContext, contextLogger } from '../utils/log-context.js';
import { AnatolyError } from '../utils/errors.js';
import { isRateLimitStandbyError, retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { ReviewFile, BestPractices } from '../schemas/review.js';
import type { AxisContext, AxisEvaluator, AxisId, AxisResult, PreResolvedRag, RelevantDoc } from './axis-evaluator.js';
import type { Semaphore } from './sdk-semaphore.js';
import type { GeminiCircuitBreaker } from './circuit-breaker.js';
import type { UsageGraph } from './usage-graph.js';
import type { DependencyMeta } from './dependency-meta.js';
import { extractFileDeps } from './dependency-meta.js';
import type { VectorStore } from '../rag/vector-store.js';
import { buildFunctionId } from '../rag/indexer.js';
import { resolveRelevantDocs, resolveRelevantDocsViaRag, resolveAllRelevantDocs } from './docs-resolver.js';
import { mergeAxisResults } from './axis-merger.js';
import { resolveAxisModel, resolveDeliberationModel, runSingleTurnQuery } from './axis-evaluator.js';
import {
  DeliberationResponseSchema,
  buildDeliberationSystemPrompt,
  buildDeliberationUserMessage,
  needsDeliberation,
  applyDeliberation,
} from './deliberation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link evaluateFile} — bundles every input the
 * file-level evaluation pipeline needs: source context, axis evaluators,
 * optional RAG/dependency/deliberation features, and progress callbacks.
 */
export interface EvaluateFileOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** The scanned task describing the file and its symbols. */
  task: Task;
  /** Resolved project configuration (model, axes, thresholds, etc.). */
  config: Config;
  /** Axis evaluators to run in parallel against this file. */
  evaluators: AxisEvaluator[];
  /** Controller used to abort in-flight LLM calls (e.g. on Ctrl+C). */
  abortController: AbortController;
  /** Absolute path to the current run directory (for output artifacts). */
  runDir: string;
  /** Cross-file usage graph for utility/dead-code analysis. */
  usageGraph?: UsageGraph;
  /** Pre-built vector store for RAG similarity search. */
  vectorStore?: VectorStore;
  /** Whether RAG-based duplicate detection is enabled. */
  ragEnabled?: boolean;
  /** Resolved dependency metadata (package.json, lock files, etc.). */
  depMeta?: DependencyMeta;
  /** ASCII tree of the project directory structure. */
  projectTree?: string;
  /** When true (default), run an optional deliberation pass to reconcile conflicting axis scores. */
  deliberation?: boolean;
  /** ASCII tree of docs/ directory for documentation axis */
  docsTree?: string | null;
  /** ASCII tree of .anatoly/docs/ (internal generated docs) */
  internalDocsTree?: string | null;
  /** Absolute path to .anatoly/docs/ directory */
  internalDocsDir?: string;
  /** Weight for code similarity in hybrid search (0-1). NLP weight = 1 - codeWeight. */
  codeWeight?: number;
  /** Full path to conversations/ dir for LLM conversation dumps */
  conversationDir?: string;
  /** Callback fired after each axis evaluator finishes (success or failure). */
  onAxisComplete?: (axisId: AxisId) => void;
  /** Stream transcript chunks to disk as each axis completes. */
  onTranscriptChunk?: (chunk: string) => void;
  /** Global SDK concurrency semaphore — bounds total in-flight SDK calls */
  semaphore?: Semaphore;
  /** Gemini-specific concurrency semaphore — bounds total in-flight Gemini SDK calls */
  geminiSemaphore?: Semaphore;
  /** Circuit breaker for Gemini fallback — when tripped, Gemini models redirect to Claude */
  circuitBreaker?: GeminiCircuitBreaker;
  /** Claude model to fall back to when circuit breaker redirects Gemini calls */
  fallbackModel?: string;
}

export interface AxisTiming {
  axisId: AxisId;
  /** LLM provider used for this axis call ('anthropic' or 'gemini'). */
  provider: 'anthropic' | 'gemini';
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface EvaluateFileResult {
  review: ReviewFile;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
  axisTiming: AxisTiming[];
  /** Axis IDs that crashed during evaluation (empty when all axes succeed). */
  failedAxes: AxisId[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a single file through all enabled axis evaluators in parallel.
 *
 * 1. Reads the file content once
 * 2. Pre-resolves RAG similarity (if enabled)
 * 3. Executes all evaluators concurrently via Promise.allSettled
 * 4. Extracts best_practices and docs_coverage data if present
 * 5. Merges results into a single ReviewFile v2
 * 6. Optionally runs a deliberation pass to reconcile conflicting scores
 *
 * @param opts - Full evaluation configuration (see {@link EvaluateFileOptions}).
 * @returns A {@link EvaluateFileResult} containing the merged review, aggregate
 *   cost/token metrics, a human-readable transcript, per-axis timing breakdown,
 *   and a list of any axis IDs that failed during evaluation.
 */
export async function evaluateFile(opts: EvaluateFileOptions): Promise<EvaluateFileResult> {
  const { projectRoot, task, config, evaluators, abortController, usageGraph, onAxisComplete } = opts;

  return runWithContext({ file: task.file }, async () => {
  const fileContent = readFileSync(resolve(projectRoot, task.file), 'utf-8');

  // Pre-resolve RAG for duplication axis
  const preResolvedRag = await preResolveRag(task, opts);

  const fileDeps = opts.depMeta ? extractFileDeps(fileContent, opts.depMeta) : undefined;

  // Resolve associated test file(s)
  // Strategies (first match wins):
  //   1. Sibling: foo.test.ts / foo.spec.ts (JS/TS convention)
  //   2. Sibling: foo_test.go (Go convention)
  //   3. Sibling: test_foo.py / foo_test.py (Python convention)
  //   4. __tests__/foo.test.ts or __tests__/foo.spec.ts (Jest/Vitest)
  //   5. tests/ directory at crate/package root (Rust: crate/tests/*.rs)
  let testFileContent: string | undefined;
  let testFileName: string | undefined;
  const ext = extname(task.file);
  const base = basename(task.file, ext);
  const dir = dirname(task.file);
  const lang = task.language;
  if (!base.endsWith('.test') && !base.endsWith('.spec') && !base.startsWith('test_') && !base.endsWith('_test')) {
    const candidates: string[] = [];

    // Strategy 1: sibling .test / .spec (JS/TS/Rust/Python etc.)
    candidates.push(`${dir}/${base}.test${ext}`, `${dir}/${base}.spec${ext}`);

    // Strategy 2: Go sibling _test
    if (lang === 'go') {
      candidates.push(`${dir}/${base}_test${ext}`);
    }

    // Strategy 3: Python sibling test_foo / foo_test
    if (lang === 'python') {
      candidates.push(`${dir}/test_${base}${ext}`, `${dir}/${base}_test${ext}`);
    }

    // Strategy 4: __tests__/ subdirectory
    candidates.push(
      `${dir}/__tests__/${base}.test${ext}`,
      `${dir}/__tests__/${base}.spec${ext}`,
    );

    for (const relTestPath of candidates) {
      const testPath = resolve(projectRoot, relTestPath);
      if (existsSync(testPath)) {
        try {
          testFileContent = readFileSync(testPath, 'utf-8');
          testFileName = relTestPath;
        } catch (err) {
          contextLogger().debug({ testPath, err }, 'failed to read test file');
        }
        break;
      }
    }

    // Strategy 5: tests/ directory at crate/package root (Rust, Python, etc.)
    // For src/lib.rs → look at ../tests/, for src/foo.rs → ../tests/foo.rs
    if (!testFileContent) {
      const testsDir = resolveTestsDirectory(dir, base, ext, lang, projectRoot);
      if (testsDir) {
        testFileContent = testsDir.content;
        testFileName = testsDir.name;
      }
    }
  }

  // Resolve relevant docs for documentation axis
  // Use RAG NLP search when vector store is available (semantic matching),
  // fall back to convention-based matching (with dual source support) otherwise
  let relevantDocs: RelevantDoc[] | undefined = undefined;
  let docResolveMethod: 'rag' | 'convention' | 'none' = 'none';
  if (opts.ragEnabled && opts.vectorStore) {
    try {
      relevantDocs = await resolveRelevantDocsViaRag(task.file, opts.vectorStore, projectRoot, config.llm.model);
      docResolveMethod = 'rag';
    } catch {
      // Fall back to convention-based matching on RAG failure
      relevantDocs = resolveAllRelevantDocs(task.file, config, projectRoot, {
        docsTree: opts.docsTree ?? null,
        internalDocsTree: opts.internalDocsTree ?? null,
        internalDocsDir: opts.internalDocsDir ?? '',
      });
      docResolveMethod = relevantDocs.length > 0 ? 'convention' : 'none';
    }
  } else {
    relevantDocs = resolveAllRelevantDocs(task.file, config, projectRoot, {
      docsTree: opts.docsTree ?? null,
      internalDocsTree: opts.internalDocsTree ?? null,
      internalDocsDir: opts.internalDocsDir ?? '',
    });
    docResolveMethod = relevantDocs.length > 0 ? 'convention' : 'none';
  }
  contextLogger().info({
    event: 'doc_resolve',
    file: task.file,
    method: docResolveMethod,
    docsFound: relevantDocs?.length ?? 0,
    docPaths: relevantDocs?.map((d) => d.path) ?? [],
  }, 'docs resolved');

  const fileSlug = opts.conversationDir ? toOutputName(task.file) : undefined;

  const ctx: AxisContext = {
    task,
    fileContent,
    config,
    projectRoot,
    usageGraph,
    preResolvedRag,
    fileDeps,
    projectTree: opts.projectTree,
    testFileContent,
    testFileName,
    docsTree: opts.docsTree ?? undefined,
    relevantDocs,
    conversationDir: opts.conversationDir,
    conversationFileSlug: fileSlug,
    semaphore: opts.semaphore,
    geminiSemaphore: opts.geminiSemaphore,
    circuitBreaker: opts.circuitBreaker,
    fallbackModel: opts.fallbackModel,
  };

  const startTime = Date.now();
  const transcriptParts: string[] = [];

  // Execute all evaluators in parallel, each in its own axis sub-context
  const settledResults = await Promise.allSettled(
    evaluators.map(async (evaluator) => {
      return runWithContext({ axis: evaluator.id }, async () => {
        const result = await evaluator.evaluate(ctx, abortController);
        onAxisComplete?.(evaluator.id);
        return result;
      });
    }),
  );

  // Collect successful results, log failures — stream transcript chunks as available
  const successResults: AxisResult[] = [];
  const failedAxes: AxisId[] = [];
  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const evaluator = evaluators[i];
    let chunk: string;
    if (settled.status === 'fulfilled') {
      successResults.push(settled.value);
      chunk = `# Axis: ${evaluator.id}\n\n${settled.value.transcript}\n`;
      contextLogger().info({ event: 'axis_complete', axis: evaluator.id, file: task.file, durationMs: settled.value.durationMs, costUsd: settled.value.costUsd, success: true }, 'axis complete');
    } else {
      failedAxes.push(evaluator.id);
      onAxisComplete?.(evaluator.id);
      const axisMsg = settled.reason instanceof AnatolyError ? settled.reason.message : String(settled.reason);
      chunk = `# Axis: ${evaluator.id} — FAILED\n\n${axisMsg}\n`;
      // Suppress noisy warnings when the user interrupted via Ctrl+C
      if (!abortController.signal.aborted) {
        const errFields = settled.reason instanceof AnatolyError
          ? settled.reason.toLogObject()
          : { errorMessage: String(settled.reason) };
        const dumpFile = settled.reason instanceof AnatolyError
          ? settled.reason.writeDump(join(opts.runDir, 'errors'), `${toOutputName(task.file)}__${evaluator.id}`)
          : undefined;
        contextLogger().warn({ event: 'axis_failed', axis: evaluator.id, file: task.file, ...errFields, ...(dumpFile ? { dumpFile } : {}) }, 'axis evaluation failed');
      }
    }
    transcriptParts.push(chunk);
    opts.onTranscriptChunk?.(chunk + '\n---\n\n');
  }

  // If ALL axes failed and at least one is a tier-level rate limit, propagate it
  // so the outer retryWithBackoff can enter standby mode instead of marking the
  // file as degraded.
  if (successResults.length === 0 && failedAxes.length > 0) {
    const standbyErr = settledResults
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => s.reason)
      .find(isRateLimitStandbyError);
    if (standbyErr) {
      throw standbyErr;
    }
  }

  // Extract best_practices and docs_coverage data from dedicated evaluators
  let bestPractices: BestPractices | undefined;
  let docsCoverage: import('../schemas/review.js').DocsCoverage | undefined;
  for (const r of successResults) {
    if (r.axisId === 'best_practices') {
      const bpResult = r as AxisResult & { _bestPractices?: BestPractices };
      if (bpResult._bestPractices) {
        bestPractices = bpResult._bestPractices;
      }
    }
    if (r.axisId === 'documentation') {
      const docResult = r as AxisResult & { _docsCoverage?: import('../schemas/review.js').DocsCoverage };
      if (docResult._docsCoverage) {
        docsCoverage = docResult._docsCoverage;
      }
    }
  }

  let totalCost = successResults.reduce((sum, r) => sum + r.costUsd, 0);
  let totalInputTokens = successResults.reduce((sum, r) => sum + r.inputTokens, 0);
  let totalOutputTokens = successResults.reduce((sum, r) => sum + r.outputTokens, 0);
  let totalCacheReadTokens = successResults.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  let totalCacheCreationTokens = successResults.reduce((sum, r) => sum + r.cacheCreationTokens, 0);

  const enabledAxes = opts.evaluators.map((e) => e.id);
  let review = mergeAxisResults(task, successResults, bestPractices, failedAxes, enabledAxes, docsCoverage);

  // --- Deliberation pass (optional) ---
  if (opts.deliberation !== false) {
    if (needsDeliberation(review)) {
      try {
        const deliberationModel = resolveDeliberationModel(config);
        const deliberationResult = await retryWithBackoff(
          () => runSingleTurnQuery(
            {
              systemPrompt: buildDeliberationSystemPrompt(),
              userMessage: buildDeliberationUserMessage(
                review,
                fileContent,
                testFileContent && testFileName ? { name: testFileName, content: testFileContent } : undefined,
              ),
              model: deliberationModel,
              projectRoot,
              abortController,
              conversationDir: opts.conversationDir,
              conversationPrefix: fileSlug ? `${fileSlug}__deliberation` : undefined,
              semaphore: opts.semaphore,
              geminiSemaphore: opts.geminiSemaphore,
              circuitBreaker: opts.circuitBreaker,
              fallbackModel: opts.fallbackModel,
            },
            DeliberationResponseSchema,
          ),
          {
            maxRetries: 3,
            baseDelayMs: 5_000,
            maxDelayMs: 60_000,
            jitterFactor: 0.2,
            filePath: task.file,
          },
        );

        review = applyDeliberation(review, deliberationResult.data, projectRoot);
        totalCost += deliberationResult.costUsd;
        totalInputTokens += deliberationResult.inputTokens;
        totalOutputTokens += deliberationResult.outputTokens;
        totalCacheReadTokens += deliberationResult.cacheReadTokens;
        totalCacheCreationTokens += deliberationResult.cacheCreationTokens;
        const delibChunk = `# Deliberation Pass\n\n${deliberationResult.transcript}\n`;
        transcriptParts.push(delibChunk);
        opts.onTranscriptChunk?.(delibChunk);
      } catch (err) {
        const shortMsg = err instanceof AnatolyError ? err.message : String(err);
        const failChunk = `# Deliberation Pass — FAILED\n\n${shortMsg}\n`;
        transcriptParts.push(failChunk);
        opts.onTranscriptChunk?.(failChunk);
        // Suppress noisy warnings when the user interrupted via Ctrl+C
        if (!abortController.signal.aborted) {
          const errFields = err instanceof AnatolyError
            ? err.toLogObject()
            : { errorMessage: String(err) };
          const dumpFile = err instanceof AnatolyError
            ? err.writeDump(join(opts.runDir, 'errors'), `${toOutputName(task.file)}__deliberation`)
            : undefined;
          contextLogger().warn({ file: task.file, ...errFields, ...(dumpFile ? { dumpFile } : {}) }, 'deliberation failed');
        }
      }
    } else {
      const skipChunk = '# Deliberation Pass — SKIPPED\n\nFile is CLEAN with high confidence.\n';
      transcriptParts.push(skipChunk);
      opts.onTranscriptChunk?.(skipChunk);
    }
  }

  const totalDuration = Date.now() - startTime;
  const transcript = transcriptParts.join('\n---\n\n');
  const axisTiming: AxisTiming[] = successResults.map((r) => {
    const ev = evaluators.find(e => e.id === r.axisId);
    const model = ev ? resolveAxisModel(ev, opts.config) : '';
    return {
      axisId: r.axisId,
      provider: (model.startsWith('gemini-') ? 'gemini' : 'anthropic') as 'anthropic' | 'gemini',
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
    };
  });

  return {
    review,
    costUsd: totalCost,
    durationMs: totalDuration,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    transcript,
    axisTiming,
    failedAxes,
  };
  });
}

// ---------------------------------------------------------------------------
// RAG pre-resolution (moved from reviewer.ts)
// ---------------------------------------------------------------------------

async function preResolveRag(task: Task, opts: EvaluateFileOptions): Promise<PreResolvedRag | undefined> {
  if (!opts.ragEnabled || !opts.vectorStore) return undefined;

  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  const codeWeight = opts.codeWeight ?? 0.6;

  const preResolved: PreResolvedRag = [];
  for (const symbol of functionSymbols) {
    const functionId = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    try {
      const results = await opts.vectorStore.searchByIdHybrid(functionId, codeWeight);
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results });
      contextLogger().info({
        event: 'rag_search',
        symbol: symbol.name,
        file: task.file,
        searchMethod: 'hybrid',
        codeWeight,
        candidateCount: results.length,
        topScore: results.length > 0 ? results[0].score : null,
        topCandidate: results.length > 0 ? `${results[0].card.name}@${results[0].card.filePath}` : null,
      }, 'RAG pre-resolve result');
    } catch (err) {
      contextLogger().warn({ symbol: symbol.name, file: task.file, err: String(err) }, 'RAG lookup failed for symbol');
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results: null });
    }
  }

  return preResolved.length > 0 ? preResolved : undefined;
}

// ---------------------------------------------------------------------------
// Test directory resolution (Strategy 5)
// ---------------------------------------------------------------------------

/**
 * Look for a tests/ directory at the crate/package root.
 *
 * For Rust:
 *   - `crate/src/lib.rs` → collect all files from `crate/tests/*.rs`
 *   - `crate/src/foo.rs` → try `crate/tests/foo.rs`, then fall back to all
 *
 * For Python:
 *   - `pkg/module.py` → try `tests/test_module.py`, `tests/module_test.py`, then all
 *
 * General:
 *   - Walk up from `dir` looking for a sibling `tests/` directory
 *
 * Returns concatenated content of discovered test files (capped at 1000 lines).
 */
// Cache directory listings to avoid repeated readdirSync on the hot path
const dirListingCache = new Map<string, string[]>();
function cachedReaddirSync(absDir: string): string[] {
  const cached = dirListingCache.get(absDir);
  if (cached) return cached;
  const entries = readdirSync(absDir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name);
  dirListingCache.set(absDir, entries);
  return entries;
}

function resolveTestsDirectory(
  dir: string,
  base: string,
  ext: string,
  lang: string | undefined,
  projectRoot: string,
): { content: string; name: string } | undefined {
  const log = contextLogger();

  // Walk up from dir to find a sibling tests/ directory.
  // For "crate/src/lib.rs", dir="crate/src" → parent="crate" → tests="crate/tests"
  // For "src/lib.rs", dir="src" → parent="" → tests="tests"
  const parentDir = dirname(dir);
  const rawCandidates = [
    parentDir !== '.' ? `${parentDir}/tests` : 'tests',  // crate/src/foo.rs → crate/tests/
    dir !== '.' ? `${dir}/tests` : 'tests',              // pkg/foo.py → pkg/tests/
  ];
  const testsDirCandidates = [...new Set(rawCandidates)];

  for (const testsRelDir of testsDirCandidates) {
    const testsAbsDir = resolve(projectRoot, testsRelDir);
    if (!existsSync(testsAbsDir)) continue;

    let entries: string[];
    try {
      entries = cachedReaddirSync(testsAbsDir).filter((f) => f.endsWith(ext));
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    // Try specific match first (e.g. crate/tests/foo.rs for crate/src/foo.rs)
    const specificCandidates: string[] = [];
    if (lang === 'python') {
      specificCandidates.push(`test_${base}${ext}`, `${base}_test${ext}`);
    } else {
      specificCandidates.push(`${base}${ext}`);
    }

    for (const specific of specificCandidates) {
      if (entries.includes(specific)) {
        const fullPath = resolve(testsAbsDir, specific);
        try {
          return { content: readFileSync(fullPath, 'utf-8'), name: `${testsRelDir}/${specific}` };
        } catch (err) {
          log.debug({ testPath: fullPath, err }, 'failed to read specific test file from tests/');
        }
      }
    }

    // For lib.rs / __init__.py (crate/package root), collect all test files
    const isPackageRoot = base === 'lib' || base === 'mod' || base === '__init__' || base === 'index';
    if (isPackageRoot) {
      const MAX_LINES = 500; // matches deliberation's MAX_TEST_LINES cap
      const parts: string[] = [];
      const names: string[] = [];
      let totalLines = 0;

      for (const entry of entries.sort()) {
        const fullPath = resolve(testsAbsDir, entry);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n').length;
          if (totalLines + lines > MAX_LINES && parts.length > 0) {
            parts.push(`\n// ... ${entries.length - names.length} more test files truncated\n`);
            break;
          }
          parts.push(`// === ${testsRelDir}/${entry} ===\n${content}`);
          names.push(`${testsRelDir}/${entry}`);
          totalLines += lines;
        } catch (err) {
          log.debug({ testPath: fullPath, err }, 'failed to read test file from tests/');
        }
      }

      if (parts.length > 0) {
        return { content: parts.join('\n\n'), name: names.join(', ') };
      }
    }
  }

  return undefined;
}
