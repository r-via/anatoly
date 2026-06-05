// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename, dirname, extname } from 'node:path';
import picomatch from 'picomatch';
import { toOutputName } from '../../utils/cache.js';
import { runWithContext, contextLogger } from '../../utils/log-context.js';
import { AnatolyError, isFatalAuthError, isCircuitOpenError } from '../../utils/errors.js';
import { isRateLimitStandbyError } from '../../utils/rate-limiter.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import type { ReviewFile, BestPractices } from '../../schemas/review.js';
import type { AxisContext, AxisEvaluator, AxisId, AxisResult, PreResolvedRag, RelevantDoc } from './contract.js';
import type { TransportRouter } from '../transports/index.js';
import type { UsageGraph } from '../scanning/index.js';
import type { DependencyMeta } from '../scanning/index.js';
import { extractFileDeps } from '../scanning/index.js';
import type { VectorStore } from '../../rag/vector-store.js';
import { buildFunctionId } from '../../rag/indexer.js';
import { retrieveRelevantDocsForFile } from '../../rag/per-file-doc-retrieval.js';
import { resolveRelevantDocsViaRag, resolveAllRelevantDocs } from '../documentation/index.js';
import type { ReferenceDoc } from '../documentation/index.js';
import { mergeAxisResults } from './axis-merger.js';
import { getEffectiveSourceRoot } from '../worktree/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link evaluateFile} — bundles every input the
 * file-level evaluation pipeline needs: source context, axis evaluators,
 * optional RAG/dependency/deliberation features, and progress callbacks.
 */
export interface EvaluateFileOptions {
  /** Absolute path to the project root (used for outputs and as default source). */
  projectRoot: string;
  /** Absolute path to the source tree (worktree). When set, source files are read from here instead of projectRoot. */
  sourceRoot?: string;
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
  /** Callback fired just before an axis evaluator starts. Used to track in-flight axes for timeout diagnostics. */
  onAxisStart?: (axisId: AxisId) => void;
  /** Stream transcript chunks to disk as each axis completes. */
  onTranscriptChunk?: (chunk: string) => void;
  /** Mode-aware transport router — handles concurrency, circuit breaking, and transport selection */
  router?: TransportRouter;
  /** User instructions from ANATOLY.md — passed to each axis evaluator for prompt calibration */
  userInstructions?: import('../../utils/user-instructions.js').UserInstructions;
  /** Doc-wins arbitrated fragments promoted to authoritative status. Story 55.7. */
  arbitratedFragments?: import('./axes/reference-docs-context.js').ArbitratedFragment[];
}

export interface AxisTiming {
  axisId: AxisId;
  /** LLM provider used for this axis call. */
  provider: 'anthropic';
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
 *
 * @param opts - Full evaluation configuration (see {@link EvaluateFileOptions}).
 * @returns A {@link EvaluateFileResult} containing the merged review, aggregate
 *   cost/token metrics, a human-readable transcript, per-axis timing breakdown,
 *   and a list of any axis IDs that failed during evaluation.
 */
export async function evaluateFile(opts: EvaluateFileOptions): Promise<EvaluateFileResult> {
  const { projectRoot, task, config, evaluators, abortController, usageGraph, onAxisComplete, onAxisStart } = opts;
  const effectiveSourceRoot = getEffectiveSourceRoot(projectRoot, opts.sourceRoot);

  return runWithContext({ file: task.file }, async () => {
  const fileContent = readFileSync(resolve(effectiveSourceRoot, task.file), 'utf-8');

  // Pre-resolve RAG for duplication axis
  const preResolvedRag = await preResolveRag(task, opts);

  const fileDeps = opts.depMeta ? extractFileDeps(fileContent, opts.depMeta) : undefined;

  // Resolve associated test file(s).
  //
  // The previous "first match wins" cascade picked one conventional file
  // (e.g. reporter.test.ts) and stopped, so feature-grouped sibling tests
  // (e.g. doc-divergence.test.ts testing symbols in reporter.ts) were never
  // surfaced to the tests-axis grader — which then reported the exercised
  // symbols as NONE ("not imported in the test file") at 70-90% confidence.
  // Switch to ALL-match accumulation: each strategy contributes any test
  // files it finds; we dedupe by path, then concat all contents (capped at
  // MAX_TEST_LINES inside the grader anyway) into one payload.
  let testFileContent: string | undefined;
  let testFileName: string | undefined;
  const ext = extname(task.file);
  const base = basename(task.file, ext);
  const dir = dirname(task.file);
  const lang = task.language;
  if (!base.endsWith('.test') && !base.endsWith('.spec') && !base.startsWith('test_') && !base.endsWith('_test')) {
    const collected = new Set<string>();

    // Convention candidates — JS/TS/Go/Python siblings + Jest-style __tests__/
    const conventionCandidates: string[] = [
      `${dir}/${base}.test${ext}`,
      `${dir}/${base}.spec${ext}`,
      `${dir}/__tests__/${base}.test${ext}`,
      `${dir}/__tests__/${base}.spec${ext}`,
    ];
    if (lang === 'go') conventionCandidates.push(`${dir}/${base}_test${ext}`);
    if (lang === 'python') conventionCandidates.push(`${dir}/test_${base}${ext}`, `${dir}/${base}_test${ext}`);
    for (const rel of conventionCandidates) {
      if (existsSync(resolve(effectiveSourceRoot, rel))) collected.add(rel);
    }

    // tests/ directory at crate/package root (Rust, Python, etc.)
    const testsDir = resolveTestsDirectory(dir, base, ext, lang, effectiveSourceRoot);
    if (testsDir) {
      // resolveTestsDirectory returns concatenated content already; treat its
      // name as a single virtual entry so downstream concat logic can append.
      const parts: string[] = [`// ---- ${testsDir.name} ----\n${testsDir.content}`];
      // Add discoverImportingTestFiles output (sibling *.test.* files that
      // import this source, in addition to any test-dir matches).
      for (const rel of discoverImportingTestFiles(effectiveSourceRoot, task.file, base)) {
        if (!collected.has(rel)) collected.add(rel);
      }
      for (const rel of collected) {
        try {
          parts.push(`// ---- ${rel} ----\n${readFileSync(resolve(effectiveSourceRoot, rel), 'utf-8')}`);
        } catch (err) {
          contextLogger().debug({ rel, err }, 'failed to read discovered test file');
        }
      }
      testFileContent = parts.join('\n\n');
      testFileName = collected.size === 0 ? testsDir.name : `${collected.size + 1} test files (testsDir + sibling-import-discovered)`;
    } else {
      // Discover sibling/test-dir files importing this source — added to
      // the convention matches, not used as a fallback. Catches feature-
      // grouped tests whose basename doesn't match the source.
      for (const rel of discoverImportingTestFiles(effectiveSourceRoot, task.file, base)) {
        collected.add(rel);
      }
      if (collected.size > 0) {
        const parts: string[] = [];
        for (const rel of collected) {
          try {
            parts.push(`// ---- ${rel} ----\n${readFileSync(resolve(effectiveSourceRoot, rel), 'utf-8')}`);
          } catch (err) {
            contextLogger().debug({ rel, err }, 'failed to read discovered test file');
          }
        }
        if (parts.length > 0) {
          testFileContent = parts.join('\n\n');
          testFileName = collected.size === 1
            ? [...collected][0]
            : `${collected.size} test files (convention + sibling-import-discovered)`;
        }
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
      relevantDocs = await resolveRelevantDocsViaRag(task.file, opts.vectorStore, effectiveSourceRoot, config.models.quality);
      docResolveMethod = 'rag';
    } catch {
      // Fall back to convention-based matching on RAG failure
      relevantDocs = resolveAllRelevantDocs(task.file, config, effectiveSourceRoot, {
        docsTree: opts.docsTree ?? null,
        internalDocsTree: opts.internalDocsTree ?? null,
        internalDocsDir: opts.internalDocsDir ?? '',
      });
      docResolveMethod = relevantDocs.length > 0 ? 'convention' : 'none';
    }
  } else {
    relevantDocs = resolveAllRelevantDocs(task.file, config, effectiveSourceRoot, {
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

  // Per-file reference-doc retrieval — feeds `correction`, `best-practices`,
  // and `overengineering` via `ctx.referenceDocs` and replaces the
  // lite-mode digest. Each retrieval emits a structured `rag.query` event
  // tagged with the file under review so the chain is fully observable.
  let referenceDocs: ReferenceDoc[] | undefined;
  if (opts.ragEnabled && opts.vectorStore) {
    try {
      referenceDocs = await retrieveRelevantDocsForFile(
        task.file,
        opts.vectorStore,
        effectiveSourceRoot,
        { caller: `file-evaluator:file=${task.file}`, filePath: task.file },
      );
      contextLogger().info({
        event: 'reference_docs_resolve',
        file: task.file,
        docsFound: referenceDocs.length,
        docPaths: referenceDocs.map((d) => d.path),
      }, 'per-file reference docs resolved');
    } catch (err) {
      contextLogger().warn({ file: task.file, err: String(err) }, 'per-file reference doc retrieval failed');
      referenceDocs = undefined;
    }
  }

  // doc 19 PR 3: the file slug is the per-call disambiguator (callId
  // segment) of the harness-assigned dump slug. Axes pass it through
  // unchanged to runSingleTurnQuery, which feeds it into the ALS scope
  // alongside composer + primitive.
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
    referenceDocs,
    conversationDir: opts.conversationDir,
    callId: fileSlug,
    router: opts.router,
    userInstructions: opts.userInstructions,
    arbitratedFragments: opts.arbitratedFragments,
  };

  // Filter out evaluators whose axes.*.skip patterns match this file
  const activeEvaluators = evaluators.filter((ev) => {
    const axisConf = config.axes?.[ev.id];
    if (!axisConf?.skip || axisConf.skip.length === 0) return true;
    const isSkipped = picomatch(axisConf.skip)(task.file);
    if (isSkipped) {
      contextLogger().info({ event: 'axis_skipped', axis: ev.id, file: task.file, patterns: axisConf.skip }, 'axis skipped by config skip pattern');
    }
    return !isSkipped;
  });
  const skippedAxes = evaluators.filter((ev) => !activeEvaluators.includes(ev)).map((ev) => ev.id);
  // Fire progress callbacks for config-skipped axes so UI counters stay accurate
  for (const ev of evaluators) {
    if (skippedAxes.includes(ev.id)) onAxisComplete?.(ev.id);
  }

  const startTime = Date.now();
  const transcriptParts: string[] = [];

  // Execute all evaluators in parallel, each in its own axis sub-context.
  // onAxisComplete fires in finally so progress counters advance for failed
  // axes too (the callback contract is "after each evaluator finishes,
  // success or failure"); placing it after await would skip the failure path.
  const settledResults = await Promise.allSettled(
    activeEvaluators.map(async (evaluator) => {
      return runWithContext({ axis: evaluator.id }, async () => {
        onAxisStart?.(evaluator.id);
        try {
          return await evaluator.evaluate(ctx, abortController);
        } finally {
          onAxisComplete?.(evaluator.id);
        }
      });
    }),
  );

  // Collect successful results, log failures — stream transcript chunks as available.
  // settledResults is built from activeEvaluators (skipped axes filtered out),
  // so it must be indexed against activeEvaluators, not the full evaluators
  // list — otherwise per-axis attribution (transcript header, failedAxes,
  // warning log) drifts whenever an axis is config-skipped.
  const successResults: AxisResult[] = [];
  const failedAxes: AxisId[] = [];
  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const evaluator = activeEvaluators[i];
    let chunk: string;
    if (settled.status === 'fulfilled') {
      successResults.push(settled.value);
      chunk = `# Axis: ${evaluator.id}\n\n${settled.value.transcript}\n`;
      contextLogger().info({ event: 'axis_complete', axis: evaluator.id, file: task.file, durationMs: settled.value.durationMs, costUsd: settled.value.costUsd, success: true }, 'axis complete');
    } else {
      failedAxes.push(evaluator.id);
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
  // A provider-auth failure OR an open circuit breaker is run-fatal, not a
  // per-file problem: never degrade the file with it. Propagate (even if some
  // axes hit cache) so the orchestrator stops the whole run instead of
  // silently producing a hollow review served from stale cache.
  const fatalErr = settledResults
    .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    .map((s) => s.reason)
    .find((r) => isFatalAuthError(r) || isCircuitOpenError(r));
  if (fatalErr) {
    throw fatalErr;
  }

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
  let docsCoverage: import('../../schemas/review.js').DocsCoverage | undefined;
  for (const r of successResults) {
    if (r.axisId === 'best_practices') {
      const bpResult = r as AxisResult & { _bestPractices?: BestPractices };
      if (bpResult._bestPractices) {
        bestPractices = bpResult._bestPractices;
      }
    }
    if (r.axisId === 'documentation') {
      const docResult = r as AxisResult & { _docsCoverage?: import('../../schemas/review.js').DocsCoverage };
      if (docResult._docsCoverage) {
        docsCoverage = docResult._docsCoverage;
      }
    }
  }

  const totalCost = successResults.reduce((sum, r) => sum + r.costUsd, 0);
  const totalInputTokens = successResults.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = successResults.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalCacheReadTokens = successResults.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  const totalCacheCreationTokens = successResults.reduce((sum, r) => sum + r.cacheCreationTokens, 0);

  const enabledAxes = opts.evaluators.map((e) => e.id);
  // Config-skipped axes produce '-' markers (same as disabled axes) — don't treat as failures
  const review = mergeAxisResults(task, successResults, bestPractices, failedAxes, enabledAxes, docsCoverage);

  // Per-file deliberation removed (Story 41.1) — verdict comes from merge logic.
  // Refinement tiers (41.2–41.4) will post-process ReviewFiles after the review phase.

  const totalDuration = Date.now() - startTime;
  const transcript = transcriptParts.join('\n---\n\n');
  const axisTiming: AxisTiming[] = successResults.map((r) => ({
    axisId: r.axisId,
    provider: 'anthropic' as const,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
  }));

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
      const results = await opts.vectorStore.searchByIdHybrid(functionId, codeWeight, undefined, undefined, {
        caller: `axis:duplication:file=${task.file}:symbol=${symbol.name}`,
        axis: 'duplication',
        filePath: task.file,
      });
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
/**
 * Scan test directories (`__tests__/`, `tests/`, `test/`) anywhere between
 * the source file's dir and the project root for test files that import
 * this source file. Matches import paths ending with the source's basename
 * (with or without extension). Handles:
 * - sibling test dirs (JS/TS: `src/__tests__/basic.test.ts`)
 * - project-root test dirs (Python: `tests/test_payments.py` testing `src/foo/payments.py`)
 * - non-conventional test file names (test file name ≠ source basename)
 */
function discoverImportingTestFiles(
  projectRoot: string,
  sourceRelPath: string,
  sourceBase: string,
): string[] {
  const testDirNames = ['__tests__', 'tests', 'test'];
  // Matches JS/TS `import ... from '...'` / `require('...')` and Python `from x import`/`import x`.
  const importRegex = /(?:import\s[^;]*?from\s+|require\s*\(\s*)['"]([^'"]+)['"]|from\s+([\w.]+)\s+import|import\s+([\w.]+)/g;
  const results = new Set<string>();

  // Collect all candidate test directories: walk up from sourceDir to project
  // root, including the source's own directory at each level so feature-grouped
  // sibling tests (e.g. src/core/reporting/doc-divergence.test.ts testing
  // symbols defined in src/core/reporting/reporter.ts) are discovered too.
  // Without the source-dir inclusion the function only found tests living in
  // `__tests__/` / `tests/` / `test/` subdirs and missed every test file whose
  // basename didn't match the source — accounting for ~50-100 NONE false
  // positives on the tests axis in the 2026-05-19 self-audit.
  const candidateDirs = new Set<string>();
  let cur = dirname(sourceRelPath);
  while (true) {
    candidateDirs.add(cur === '' ? '.' : cur);
    for (const td of testDirNames) {
      const rel = cur === '.' ? td : `${cur}/${td}`;
      candidateDirs.add(rel);
    }
    if (cur === '.' || cur === '') break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const relDir of candidateDirs) {
    const absDir = resolve(projectRoot, relDir);
    let entries: string[];
    try {
      entries = cachedReaddirSync(absDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = `${relDir}/${entry}`;
      // Pass the composed relPath, not the bare filename: isTestFilePath's
      // directory checks (/tests/, /__tests__/) only match when a path
      // separator is present, so a non-conventionally-named file in a test
      // dir was otherwise skipped.
      if (!isTestFilePath(relPath)) continue;

      // --- Match A: filename convention ---
      // `<base>.test.*`, `<base>.spec.*`, `<base>_test.*`, `test_<base>.*`
      const entryNoExt = entry.replace(/\.[^.]+$/, '');
      const conventionMatch =
        entryNoExt === `${sourceBase}.test` ||
        entryNoExt === `${sourceBase}.spec` ||
        entryNoExt === `${sourceBase}_test` ||
        entryNoExt === `test_${sourceBase}`;
      if (conventionMatch) {
        results.add(relPath);
        continue;
      }

      // --- Match B: import-based ---
      let content: string;
      try {
        content = readFileSync(resolve(projectRoot, relPath), 'utf-8');
      } catch {
        continue;
      }
      for (const m of content.matchAll(importRegex)) {
        const importPath = m[1] ?? m[2] ?? m[3];
        if (!importPath) continue;
        const normalized = importPath.replace(/\.(?:js|ts|mjs|cjs|jsx|tsx|py)$/, '');
        // Match on any path segment (handles `from pkg.sub.foo import` / `'../foo'` / `'pkg/sub/foo'`).
        const segments = normalized.split(/[/.]/);
        if (segments.includes(sourceBase)) {
          results.add(relPath);
          break;
        }
      }
    }
  }
  return [...results];
}

function isTestFilePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('_test.') ||
    lower.includes('/test_') ||
    lower.startsWith('test_') ||
    lower.includes('/__tests__/') ||
    lower.includes('/tests/')
  );
}

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
