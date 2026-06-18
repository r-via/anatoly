// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Review phase (extracted from run.ts in PR 7, doc 11 Strategy B).
 *
 * The hot path, deliberately extracted last and against the most-exercised
 * regression net. Originally a move-only extraction of the run.ts tail
 * (runReviewPhase + the review-only helpers filterReviewAxes / cacheReview).
 * Since then the cache layer moved to per-axis freshness keys: runReviewPhase
 * resolves, per file, which requested axes are reusable vs stale (via
 * resolveAxisCache) and runs only the stale ones, merging onto the cached
 * blob. `export` on runReviewPhase (the spine calls it); the helpers are
 * cluster-private.
 *
 * No run.ts-local helpers were needed: recordLlmCost and
 * requestFatalStop already live in their relocated homes (PR 4/5).
 * `RunContext` is type-only (erased). Imports seeded from run.ts
 * (path-rewritten) then pruned.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';
import { loadTasks } from '../../run/index.js';
import { ProgressManager } from '../../run/index.js';
import { writeReviewOutput, writeTranscript } from '../../reporting/index.js';
import { AnatolyError, ERROR_CODES, isFatalAuthError, isCircuitOpenError, circuitOpenError } from '../../../utils/errors.js';
import { logsDir as runLogsDir, transcriptLogPath, conversationsDir } from '../../../utils/run-layout.js';
import { getLogger } from '../../../utils/logger.js';
import { runWithContext } from '../../../utils/log-context.js';
import { retryWithBackoff } from '../../../utils/rate-limiter.js';
import type { Task } from '../../../schemas/task.js';
import type { ReviewFile } from '../../../schemas/review.js';
import { generateSkipReview, evaluatorAxesForSkip } from '../../evaluation/index.js';
import { getEnabledEvaluators } from '../../evaluation/index.js';
import { evaluateFile } from '../../evaluation/index.js';
import { runWorkerPool } from '../../platform/index.js';
import { countReviewFindings } from '../../../utils/format.js';
import { computeContentHash } from '../../../utils/cache.js';
import { flowArtifactPath } from '../../flows/index.js';
import { warnDisabledAxes } from '../../../utils/axes-filter.js';
import { resolveAxisModel, type AxisId } from '../../evaluation/index.js';
import { getEffectiveSourceRoot } from '../../worktree/index.js';
import { writeProjectReview, resolveAxisCache, snapshotAndPrune } from '../../run/index.js';
import { mergeRefreshedReview } from '../../run/review-merge.js';
import { computeAxisPromptHash } from '../../run/axes-prompt-hash.js';
import { recordAgentCosts } from '../cost.js';
import { requestFatalStop } from '../run-control.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { OrchestrationEventName } from '../events.js';
import type { RunContext } from '../../../commands/run.js';

/**
 * The axis evaluators that will actually run on a file this run. Single source
 * of truth shared by the `evaluateTotal` denominator and the review handler's
 * per-file dispatch: a file is "evaluated" (one completedCount++) iff this
 * returns a non-empty list; an empty list means the handler takes the
 * pure-skip path (synthetic review, no LLM call, no count).
 *
 * Only STALE axes run (reusable axes come from the cached blob via the merge);
 * a skip-tier file further narrows to its per-reason partial-axes policy. The
 * counter denominator MUST derive its per-file decision from the same function
 * — when the two computations drifted (denominator testing the full evaluator
 * set, handler testing only stale ∩ partial), a skip-tier file whose
 * partial-policy axes were all cache-reusable was counted but never completed,
 * stranding the progress line at "9/10".
 */
export function selectFileEvaluators<E extends { id: AxisId }>(
  evaluators: readonly E[],
  staleAxes: readonly AxisId[],
  triageEnabled: boolean,
  triage: { tier: string; reason: string } | undefined,
): E[] {
  const staleSet = new Set<AxisId>(staleAxes);
  const staleEvaluators = evaluators.filter((e) => staleSet.has(e.id));
  const isSkipTier = triageEnabled && triage?.tier === 'skip';
  if (!isSkipTier) return staleEvaluators;
  const partialAxes = evaluatorAxesForSkip(triage.reason);
  return staleEvaluators.filter((e) => partialAxes.has(e.id));
}

export async function runReviewPhase(
  ctx: RunContext,
  handoff: Handoff,
  ragContext: RagContext,
): Promise<void> {
  // doc 14 PR 4b: the setup -> review inter-phase data is threaded through
  // the typed Handoff, not a positional fan-out. These are the exact refs
  // setup produced (setup.ts populates handoff with them); destructured here
  // so the body below is byte-unchanged. review still reads tasks from disk
  // via loadTasks: handoff.allTasks is the scan-filtered set, a different
  // semantic deliberately left as-is (doc 14 §8 PR 4b).
  const { triageMap, usageGraph, depMeta, projectTree, docsTree, internalDocsTree, internalDocsDir } = handoff;
  const log = getLogger();
  const rl = ctx.runLog;

  // Fail-fast: a provider circuit breaker tripped during an earlier phase
  // (e.g. doc-conflict-update) is still open when review starts moments
  // later — its half-open delay has not elapsed. Proceeding would fast-fail
  // every axis on every file and silently produce a report whose
  // un-evaluated axes render as "clean". Stop the run with an actionable
  // error instead of publishing a misleading green report.
  const openBreakers = ctx.router
    ? [...ctx.router.breakers.entries()].filter(([, b]) => b.isOpen())
    : [];
  if (openBreakers.length > 0) {
    const openProviders = openBreakers.map(([id]) => id);
    // If any open breaker tripped on quota/rate-limit, surface the actionable
    // "exhausted, resume later" message rather than the generic health one.
    const reason = openBreakers.some(([, b]) => b.openReason() === 'rate_limit')
      ? 'rate_limit'
      : 'health';
    requestFatalStop(ctx, circuitOpenError(openProviders.join(', '), reason));
    return;
  }

  const pm = new ProgressManager(ctx.projectRoot);

  const progress = pm.getProgress();
  if (ctx.fileFilter) {
    // Explicit --file filter: always re-review matching files (implicit no-cache)
    const isMatch = picomatch(ctx.fileFilter);
    for (const [, fp] of Object.entries(progress.files)) {
      if (isMatch(fp.file) && (fp.status === 'DONE' || fp.status === 'CACHED')) {
        pm.updateFileStatus(fp.file, 'PENDING');
      }
    }
  } else if (ctx.noCache) {
    // --no-cache: BYPASS the cache, never destroy it. Mark CACHED files as
    // PENDING so they're re-evaluated this run. cacheReview() and
    // writeProjectReview() are gated separately to skip writes too. If the
    // run fails, the cache on disk is unchanged — `anatoly reset` is the
    // command that actually wipes it.
    log.info('--no-cache: bypassing cache for this run (no files deleted).');
    for (const [, fp] of Object.entries(progress.files)) {
      if (fp.status === 'CACHED') pm.updateFileStatus(fp.file, 'PENDING');
    }
  } else if (ctx.cacheRefresh) {
    // --cache-refresh: same PENDING promotion as --no-cache, but writes
    // are NOT gated — fresh reviews overwrite stale cache entries. Use
    // case: a tool-internal fix changed verdicts without changing the
    // prompt hash, so the on-disk cache is now stale for content the
    // user has not touched. --no-cache alone would re-eval but leave the
    // stale entries forever.
    //
    // Take an auto-snapshot of the current cache BEFORE the overwrite —
    // a previous version of this code path silently corrupted the cache
    // on a real user run; never again. The snapshot survives the run's
    // outcome and is recoverable via `anatoly cache restore`.
    const snap = snapshotAndPrune({
      projectRoot: ctx.projectRoot,
      reason: 'auto-cache-refresh',
      triggerCommand: process.argv.slice(1).join(' '),
    });
    if (snap) {
      log.info({ snapshot: snap.name, files: snap.fileCount }, 'auto-snapshot of cache taken before --cache-refresh');
    }
    log.info('--cache-refresh: forcing re-evaluation and overwriting the cache for every file.');
    for (const [, fp] of Object.entries(progress.files)) {
      if (fp.status === 'CACHED') pm.updateFileStatus(fp.file, 'PENDING');
    }
  }

  // --retry-timeout: promote TIMEOUT files (left behind by a prior run that
  // crashed mid-axis or hit a real timeout) back to PENDING so this run takes
  // another shot at them. getPendingFiles() includes PENDING+ERROR+IN_PROGRESS
  // by default but deliberately excludes TIMEOUT (some files genuinely
  // timeout every time and shouldn't burn budget on auto-retry); this opt-in
  // flag is the explicit "I want to retry the stuck ones too" lever.
  if (ctx.retryTimeout) {
    const promoted: string[] = [];
    for (const [, fp] of Object.entries(progress.files)) {
      if (fp.status === 'TIMEOUT') {
        pm.updateFileStatus(fp.file, 'PENDING');
        promoted.push(fp.file);
      }
    }
    log.info({ promoted: promoted.length }, '--retry-timeout: promoted TIMEOUT files to PENDING');
  }

  let pending = pm.getPendingFiles();
  if (ctx.fileFilter) {
    const isMatch = picomatch(ctx.fileFilter);
    pending = pending.filter((fp) => isMatch(fp.file));
  }

  // Collect cached files so they flow through the handler for accurate metrics + display
  const currentProgress = pm.getProgress();
  const cachedFiles = Object.values(currentProgress.files).filter((f) => f.status === 'DONE' || f.status === 'CACHED');

  if (pending.length === 0 && cachedFiles.length === 0) {
    console.log('anatoly — review');
    console.log('  No pending files to review.');
    console.log('');
    return;
  }

  const allTasks = loadTasks(getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot));
  const taskMap = new Map<string, Task>();
  for (const t of allTasks) taskMap.set(t.file, t);

  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  if (ctx.axesFilter) {
    warnDisabledAxes(ctx.axesFilter, evaluators.map((e) => e.id));
  }
  const axisIds = evaluators.map((e) => e.id);
  const axesTotal = evaluators.length;

  // Per-axis freshness keys (replaces the bundle prompt hash). Each axis
  // carries its own system-prompt hash + model, so a `--axes utility` run
  // invalidates only utility's key and a later full run reuses the rest.
  const axisModelIds: Record<string, string> = {};
  const axisPromptHashes: Record<string, string> = {};
  for (const e of evaluators) {
    const model = resolveAxisModel(e, ctx.config);
    axisModelIds[e.id] = model;
    axisPromptHashes[e.id] = computeAxisPromptHash(e.id, model);
  }
  // The flow axis is deterministic on the flows.json artifact, not on the file
  // source or an LLM prompt. computeAxisPromptHash captures neither, so fold the
  // artifact's content hash into flow's freshness key: a flow verdict computed
  // against a different (or absent) artifact is then invalidated when flows.json
  // changes. Without this, a verdict cached before the flows phase first ran
  // (empty result, no artifact) is served stale after the artifact appears,
  // which silently zeroes every flow finding on a cached run.
  if (axisPromptHashes.flow) {
    let flowsArtifactHash = 'absent';
    try {
      flowsArtifactHash = computeContentHash(readFileSync(flowArtifactPath(ctx.projectRoot), 'utf-8'));
    } catch { /* artifact absent (flows phase disabled / not yet run) → 'absent' */ }
    // Schema-version tag: bump when the flow review's persisted shape changes
    // so existing on-disk caches invalidate once and re-evaluate (flow is
    // LLM-free, so the re-eval is free). v2 = the `flow_detail` field was added;
    // caches written before it lack the field and render "(no detail recorded)".
    axisPromptHashes.flow = `${axisPromptHashes.flow}:flows=${flowsArtifactHash}:v2`;
  }
  const axisMetaFor = (axes: readonly string[]): Record<string, { prompt_hash: string; model_id: string }> => {
    const out: Record<string, { prompt_hash: string; model_id: string }> = {};
    for (const a of axes) {
      if (axisPromptHashes[a]) out[a] = { prompt_hash: axisPromptHashes[a], model_id: axisModelIds[a] };
    }
    return out;
  };

  // Resolve, per file, which requested axes are reusable from cache vs stale.
  // This is BOTH the per-axis reuse decision and the source of truth for the
  // counter: a file is "cached" (no LLM work) only when zero axes are stale.
  const sourceRootEff = getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot);
  const fileFilterMatch = ctx.fileFilter ? picomatch(ctx.fileFilter) : null;
  type Resolution = { staleAxes: AxisId[]; reusableAxes: AxisId[]; cached: ReviewFile | null; contentHash: string | null };
  const resolveFile = (filePath: string): Resolution => {
    // Read once for the content hash (provenance stamp + cache lookup).
    let content: string | null = null;
    try { content = readFileSync(resolve(sourceRootEff, filePath), 'utf-8'); } catch { /* unreadable */ }
    const contentHash = content !== null ? computeContentHash(content) : null;
    // Unreadable, --no-cache, or an explicit --file match: bypass cache → every axis stale.
    if (content === null || ctx.noCache || (fileFilterMatch && fileFilterMatch(filePath))) {
      return { staleAxes: [...axisIds], reusableAxes: [], cached: null, contentHash };
    }
    const res = resolveAxisCache(ctx.projectRoot, filePath, content, axisIds, axisPromptHashes, axisModelIds);
    const stale = new Set<AxisId>(res.staleAxes as AxisId[]);
    // --cache-refresh: force re-evaluation of the targeted axes (axesFilter, or
    // all enabled axes when no filter) even when their per-axis key still matches.
    if (ctx.cacheRefresh) {
      const forced = ctx.axesFilter && ctx.axesFilter.length > 0 ? ctx.axesFilter : axisIds;
      for (const a of forced) if (axisIds.includes(a as AxisId)) stale.add(a as AxisId);
    }
    return {
      staleAxes: axisIds.filter((a) => stale.has(a)),
      reusableAxes: axisIds.filter((a) => !stale.has(a)),
      cached: res.cached,
      contentHash,
    };
  };

  const resolutions = new Map<string, Resolution>();
  const reviewItems: Array<{ filePath: string; task: Task; cached: boolean }> = [];
  for (const fp of [...cachedFiles, ...pending]) {
    const task = taskMap.get(fp.file);
    if (!task) continue;
    const r = resolveFile(fp.file);
    resolutions.set(fp.file, r);
    reviewItems.push({ filePath: fp.file, task, cached: r.staleAxes.length === 0 });
  }
  // Cached files first — instant, no API call.
  reviewItems.sort((a, b) => Number(b.cached) - Number(a.cached));

  const cachedCount = reviewItems.filter((i) => i.cached).length;
  const pendingCount = reviewItems.length - cachedCount;
  handoff.totalFiles = reviewItems.length;
  // Story 53.5 FR6: announce total file count so `anatoly attach` can render
  // the progress bar denominator (pending + cached). pending here = files with
  // at least one stale axis (real LLM work), not just status===PENDING.
  rl?.info({ event: ('estimate_total' satisfies OrchestrationEventName), phase: 'review', total: handoff.totalFiles, pending: pendingCount, cached: cachedCount }, 'estimate total');

  // A file counts toward evaluateTotal when at least one axis evaluator
  // actually runs on it. Skip-tier files with a partial-axes policy
  // (e.g. trivial files keeping correction/duplication/utility via
  // evaluatorAxesForSkip) trigger completedCount++ in the handler ONLY when
  // at least one of those partial axes is STALE — so they must be counted
  // here under the SAME condition, otherwise completedCount can exceed
  // evaluateTotal and produce displays like "13/12". Files with zero stale
  // axes are fully cache-served and excluded. doc: the pre-doc-15 bug where
  // cache-miss-fallthrough files re-evaluated but were never counted (the
  // "210 files re-run, counter shows 5" symptom) is gone — staleAxes drives
  // both the decision and the count.
  const evaluateTotal = reviewItems.filter((item) => {
    if (item.cached) return false;
    const triage = triageMap.get(item.filePath);
    const staleAxes = resolutions.get(item.filePath)?.staleAxes ?? axisIds;
    // SAME per-file decision the handler makes: counted iff at least one
    // evaluator actually runs. Deriving both from selectFileEvaluators is
    // what keeps the denominator and the handler from drifting (the drift
    // that stranded the counter at "9/10" — see selectFileEvaluators).
    return selectFileEvaluators(evaluators, staleAxes, ctx.triageEnabled, triage).length > 0;
  }).length;
  const state = ctx.pipelineState!;
  state.setPhase('review');
  state.startTask('review', `0/${evaluateTotal}`);

  let completedCount = 0;

  const updateReviewTask = () => {
    const findingsNote = handoff.totalFindings > 0 ? ` | ${handoff.totalFindings} findings` : '';
    state.updateTask('review', `${completedCount}/${evaluateTotal}${findingsNote}`);
  };

  await runWorkerPool({
    items: reviewItems,
    concurrency: ctx.concurrency,
    isInterrupted: () => ctx.interrupted,
    handler: async (item, workerIndex) => {
      const { filePath, task, cached } = item;
      await runWithContext({ file: filePath, worker: workerIndex }, async () => {

      const resolution = resolutions.get(filePath);
      // Axes to (re-)evaluate this run, the axes reused from cache, and the
      // cached blob the fresh verdicts are merged onto.
      let staleAxes: AxisId[] = resolution?.staleAxes ?? [...axisIds];
      const reusableAxes: AxisId[] = resolution?.reusableAxes ?? [];
      const cachedBlob: ReviewFile | null = resolution?.cached ?? null;

      // Fully-cached file (zero stale axes): serve the blob, no API call.
      if (cached) {
        const cachedReview = cachedBlob ? filterReviewAxes(cachedBlob, axisIds) : undefined;
        if (cachedReview) {
          // Copy into current run dir so the report is complete
          writeReviewOutput(ctx.projectRoot, cachedReview, ctx.runDir);
          handoff.filesReviewed++;
          ctx.reviewCounts.cached++;
          handoff.totalFindings += countReviewFindings(cachedReview, 60);
          if (ctx.plain) {
            const findings = countReviewFindings(cachedReview);
            const note = findings > 0 ? ` | ${findings} findings` : '';
            ctx.renderer?.logPlain(`[review] [CACHED] ${filePath} → ${cachedReview.verdict}${note}`);
          }
          rl?.info({ event: ('file_cached' satisfies OrchestrationEventName), phase: 'review', file: filePath, verdict: cachedReview.verdict }, 'file loaded from cache');
          // Story 53.5 FR6: drive attach progress bar
          rl?.info({ event: ('file_review_end' satisfies OrchestrationEventName), phase: 'review', file: filePath, verdict: cachedReview.verdict, source: 'cache' }, 'file review end');
          return;
        }
        // doc 15: the file was classified cached (zero stale axes) but the
        // blob is not retrievable (wiped/partial cache, index/blob drift). The
        // pre-doc-15 code `return`ed here SILENTLY: the file was audited by
        // nobody and produced zero signal — the exact root cause of
        // `src/wild.ts` vanishing from every slot-engine bench (INV-WILD a
        // structural miss). Make the escape impossible: emit a first-class
        // typed event and fall through to a FULL evaluation so the file IS
        // reviewed.
        rl?.warn({ event: ('file_cache_miss' satisfies OrchestrationEventName), phase: 'review', file: filePath }, 'expected-cached review missing — re-evaluating (no silent drop)');
        if (ctx.plain) ctx.renderer?.logPlain(`[review] [CACHE-MISS] ${filePath} → re-evaluating (no cached review for current axes)`);
        staleAxes = [...axisIds]; // blob gone — every axis must be re-evaluated
        // intentional fall-through (no return): the normal evaluate path runs.
      }

      const triage = triageMap.get(filePath);

      // Determine which evaluators actually run for this file. Skip-tier
      // files used to bypass every axis with blanket safe defaults; we
      // now apply per-skip-reason policy: trivial files still get
      // correction/duplication/utility (small surface, real signal),
      // while barrel-export / type-only / constants-only fall through
      // to the pure synthetic-review path.
      const isSkipTier = ctx.triageEnabled && triage?.tier === 'skip';
      // Only the STALE axes run; reusable axes come from the cached blob via
      // the merge below. Skip-tier further narrows to the partial-axes policy.
      // Same helper drives the evaluateTotal denominator, so the counter
      // cannot drift from what actually runs here.
      const fileEvaluators = selectFileEvaluators(evaluators, staleAxes, ctx.triageEnabled, triage);

      // Pure-skip path: triage decided no axis should run on this file.
      // Generate a synthetic review; the usage graph still resolves the
      // utility verdict per symbol so unused type/constant exports
      // surface as DEAD instead of blanket USED.
      if (isSkipTier && fileEvaluators.length === 0) {
        pm.updateFileStatus(filePath, 'IN_PROGRESS');
        const skipReview = generateSkipReview(task, triage.reason, ctx.axesFilter, usageGraph);
        if (resolution?.contentHash) skipReview.content_hash = resolution.contentHash;
        writeReviewOutput(ctx.projectRoot, skipReview, ctx.runDir);
        // The synthetic review carries a verdict for every enabled axis, so
        // mark all axes fresh — the file is fully cache-served next run.
        if (!ctx.noCache) cacheReview(ctx.projectRoot, skipReview, axisMetaFor(axisIds), axisIds, ctx.sourceRoot);
        pm.updateFileStatus(filePath, 'DONE', undefined, axisIds);
        handoff.filesReviewed++;
        ctx.reviewCounts.skipped++;
        rl?.info({ event: ('file_skip' satisfies OrchestrationEventName), phase: 'review', file: filePath, reason: triage.reason }, 'file skipped');
        // Story 53.5 FR6: drive attach progress bar
        rl?.info({ event: ('file_review_end' satisfies OrchestrationEventName), phase: 'review', file: filePath, verdict: skipReview.verdict, source: 'skip' }, 'file review end');
        return;
      }

      // Evaluate tier (or skip tier with a partial axis set): run the
      // selected axis evaluators. Axes not in fileEvaluators are filled
      // with '-' by the merger (axes-not-evaluated semantic).
      pm.updateFileStatus(filePath, 'IN_PROGRESS');
      state.trackFile(filePath, { axesTotal });
      rl?.info({ event: ('file_review_start' satisfies OrchestrationEventName), file: filePath, phase: 'review', worker: workerIndex, tier: triage?.tier ?? 'evaluate', symbolCount: task.symbols?.length ?? 0, axes: fileEvaluators.map((e) => e.id), partialSkip: isSkipTier }, 'file review started');
      ctx.timeline.push({ t: Date.now() - ctx.startTime, event: ('file_review_start' satisfies OrchestrationEventName), file: filePath });

      let currentAbort = new AbortController();
      ctx.activeAborts.add(currentAbort);
      // Axes that started but did not complete (still in flight or crashed).
      // Captured for SDK_TIMEOUT / generic-failure error details so the
      // end-of-run summary can name the suspect axes.
      const axesInFlight = new Set<AxisId>();

      try {
        const runEval = () => retryWithBackoff(
          async () => {
            if (ctx.interrupted) throw new Error('interrupted');
            if (currentAbort.signal.aborted) {
              ctx.activeAborts.delete(currentAbort);
              currentAbort = new AbortController();
              ctx.activeAborts.add(currentAbort);
            }
            // Prepare streaming transcript path
            const logsDir = runLogsDir(ctx.runDir);
            mkdirSync(logsDir, { recursive: true });
            const logPath = transcriptLogPath(ctx.runDir, filePath);

            return evaluateFile({
              projectRoot: ctx.projectRoot,
              sourceRoot: ctx.sourceRoot,
              task,
              config: ctx.config,
              evaluators: fileEvaluators,
              abortController: currentAbort,
              runDir: ctx.runDir,
              usageGraph,
              vectorStore: ragContext.vectorStore,
              ragEnabled: ragContext.ragEnabled,
              depMeta,
              projectTree,
              docsTree,
              internalDocsTree,
              internalDocsDir,
              deliberation: ctx.deliberation,
              codeWeight: ctx.config.rag.code_weight,
              conversationDir: conversationsDir(ctx.runDir),
              router: ctx.router,
              userInstructions: ctx.userInstructions,
              arbitratedFragments: handoff.arbitratedFragments,
              onAxisStart: (axisId) => {
                axesInFlight.add(axisId);
              },
              onAxisComplete: (axisId) => {
                axesInFlight.delete(axisId);
                state.markAxisDone(filePath);
              },
              onTranscriptChunk: (chunk) => {
                appendFileSync(logPath, chunk);
              },
            });
          },
          {
            maxRetries: 5,
            baseDelayMs: 5000,
            maxDelayMs: 120_000,
            jitterFactor: 0.2,
            filePath,
            isInterrupted: () => ctx.interrupted,
            onRetry: (attempt, delayMs) => {
              rl?.info({ event: ('retry' satisfies OrchestrationEventName), file: filePath, attempt, delayMs }, 'rate limited, retrying');
              const delaySec = (delayMs / 1000).toFixed(0);
              state.setRetryMessage(filePath, `retry ${delaySec}s (${attempt}/5)`);
            },
            onStandby: (resetsAtMs) => {
              const MARGIN_MS = 5 * 60 * 1000;
              const resumeDate = new Date(resetsAtMs + MARGIN_MS);
              const resumeStr = resumeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              rl?.info({ event: ('standby' satisfies OrchestrationEventName), file: filePath, resetsAt: resetsAtMs, resumeAt: resumeStr }, 'sleeping until rate limit expired');
              state.setRetryMessage(filePath, `sleeping until ${resumeStr} (rate limit)`);
            },
          },
        );
        // Per-LLM-call wall-clock budget lives in runSingleTurnQuery
        // (`runtime.timeout_per_call`), so each axis attempt is bounded
        // individually. Earlier this layer wrapped the full multi-axis
        // fan-out with a per-file wall: when the budget expired, every
        // in-flight axis was aborted at once (durationMs:0 in the
        // ledger) even when each call would have finished within its
        // own budget. With per-call bounding the file is naturally
        // bounded by max-axis-duration, and the per-file wall is gone.
        const result = await runEval();

        // Per-axis merge (now the DEFAULT path, no longer gated on
        // --cache-refresh): only the stale axes ran this file; merge their
        // fresh verdicts onto the cached blob so the run dir AND the rewritten
        // cache blob keep FULL coverage. `cachedBlob` is null when nothing was
        // reusable (new or content-changed file) → merge returns `fresh`. This
        // is what lets `--axes utility` then a full run reuse utility and only
        // run the other six axes per file.
        const freshAxes = fileEvaluators.map((e) => e.id) as AxisId[];
        const outputReview = mergeRefreshedReview(cachedBlob, result.review, freshAxes);
        // Provenance: stamp the content these verdicts describe so a later
        // `cache reseed` keys this review by the right hash (not the file's
        // content at reseed time).
        if (resolution?.contentHash) outputReview.content_hash = resolution.contentHash;
        writeReviewOutput(ctx.projectRoot, outputReview, ctx.runDir);
        writeTranscript(ctx.projectRoot, filePath, result.transcript, ctx.runDir);
        const succeededAxes = result.failedAxes.length > 0
          ? fileEvaluators.map(e => e.id).filter(id => !result.failedAxes.includes(id))
          : fileEvaluators.map(e => e.id);
        // Every axis evaluator crashed: `result.review` is all-default
        // placeholder verdicts (OK/UNIQUE/LEAN…), not a real evaluation.
        // Caching it or marking the file DONE would make the next run serve
        // this phantom "clean" review and permanently hide that the file was
        // never evaluated. Record it as a file-level error so it is
        // re-reviewed next run and counted honestly in run metrics; the
        // review output is still written so the file surfaces in THIS run's
        // Degraded Reviews section.
        const allAxesCrashed = fileEvaluators.length > 0 && succeededAxes.length === 0;
        if (allAxesCrashed) {
          const msg = `all ${fileEvaluators.length} axis evaluators crashed`;
          pm.updateFileStatus(filePath, 'ERROR', msg);
          ctx.errorCount++;
          ctx.errorsByCode[ERROR_CODES.AXES_ALL_FAILED] = (ctx.errorsByCode[ERROR_CODES.AXES_ALL_FAILED] ?? 0) + 1;
          ctx.errorDetails.push({ file: filePath, code: ERROR_CODES.AXES_ALL_FAILED, message: msg, phase: 'review', axesInFlight: result.failedAxes });
          ctx.degradedReviews++;
          completedCount++;
        } else {
          // Write per-axis keys ONLY for the axes that succeeded this run;
          // writeProjectReview preserves the reused axes' prior keys (same
          // content). Progress coverage = reused ∪ freshly-succeeded so the
          // scanner's next-run coarse classification stays accurate.
          if (!ctx.noCache) cacheReview(ctx.projectRoot, outputReview, axisMetaFor(succeededAxes), succeededAxes, ctx.sourceRoot);
          const coverageAxes = [...new Set<AxisId>([...reusableAxes, ...(succeededAxes as AxisId[])])];
          pm.updateFileStatus(filePath, 'DONE', undefined, coverageAxes);
          handoff.filesReviewed++;
          ctx.reviewCounts.evaluated++;
          ctx.freshFiles.add(filePath);
          completedCount++;
          handoff.totalFindings += countReviewFindings(outputReview, 60);
          if (result.failedAxes.length > 0) {
            ctx.degradedReviews++;
          }
        }
        // Story 53.5 FR6: drive attach progress bar + finding ticker. A single
        // emission below (line ~2670 with the full review fields) carries the
        // same event name — we previously emitted twice per file, which made
        // the attach progress counter double-count (e.g. 26/13 = 200%).
        // doc 14 PR 2b: the per-axis cost fold is now harness-owned
        // (orchestration/cost.ts recordAgentCosts). Verbatim relocation,
        // byte-identical rollup (cost.test.ts is the proof); the review
        // phase body no longer contains a recordLlmCost loop.
        recordAgentCosts(ctx, result.axisTiming);
        const symbolCount = task.symbols?.length ?? 0;
        const reviewFields = {
          file: filePath,
          verdict: result.review.verdict,
          tier: triage?.tier ?? 'evaluate',
          symbolCount,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          axisTiming: result.axisTiming.map((at) => ({
            axisId: at.axisId,
            durationMs: at.durationMs,
            costUsd: at.costUsd,
            inputTokens: at.inputTokens,
            outputTokens: at.outputTokens,
          })),
        };
        log.debug(reviewFields, 'file review completed');
        ctx.runLog?.info({ event: ('file_review_end' satisfies OrchestrationEventName), ...reviewFields }, 'file review completed');
        ctx.timeline.push({ t: Date.now() - ctx.startTime, event: ('file_review_end' satisfies OrchestrationEventName), file: filePath, verdict: result.review.verdict, durationMs: result.durationMs });
        if (ctx.plain) {
          const findings = countReviewFindings(result.review);
          const verdict = result.review.verdict;
          const dur = (result.durationMs / 1000).toFixed(1);
          const note = findings > 0 ? ` | ${findings} findings` : '';
          ctx.renderer?.logPlain(`[review] [${completedCount}/${evaluateTotal}] ${filePath} \u2192 ${verdict}${note} (${dur}s)`);
        }
      } catch (error) {
        // Run-fatal during review: provider-auth failure OR an open circuit
        // breaker. file-evaluator propagates these instead of degrading the
        // file, so they land here. A circuit-broken review is worthless
        // (every non-cached file fails) — stop now and fail the run loudly
        // instead of silently finishing `done` on stale cache.
        if (isFatalAuthError(error) || isCircuitOpenError(error)) {
          requestFatalStop(ctx, error);
          return;
        }
        if (ctx.interrupted) return;

        const message = error instanceof AnatolyError ? error.message : String(error);
        const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
        pm.updateFileStatus(filePath, errorCode === 'SDK_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
        ctx.errorCount++;
        ctx.errorsByCode[errorCode] = (ctx.errorsByCode[errorCode] ?? 0) + 1;
        const inFlight = axesInFlight.size > 0 ? Array.from(axesInFlight) : undefined;
        ctx.errorDetails.push({ file: filePath, code: errorCode, message, phase: 'review', axesInFlight: inFlight });
        log.error({ file: filePath, code: errorCode, phase: 'review', axesInFlight: inFlight, err: error }, 'file review failed');
        ctx.runLog?.error({ event: ('file_review_end' satisfies OrchestrationEventName), file: filePath, code: errorCode, message, phase: 'review', axesInFlight: inFlight, verdict: 'ERROR' }, 'file review failed');
        ctx.timeline.push({ t: Date.now() - ctx.startTime, event: ('file_review_end' satisfies OrchestrationEventName), file: filePath, verdict: 'ERROR', error: errorCode, axesInFlight: inFlight });
        completedCount++;
      } finally {
        ctx.activeAborts.delete(currentAbort);
        state.untrackFile(filePath);
        updateReviewTask();
      }
      });
    },
  });

  const findingsNote = handoff.totalFindings > 0 ? ` | ${handoff.totalFindings} findings` : '';
  state.completeTask('review', `${completedCount}/${evaluateTotal}${findingsNote}`);
  await pm.flush();

  log.info({ filesReviewed: handoff.filesReviewed, findings: handoff.totalFindings, concurrency: ctx.concurrency }, 'review details');
  rl?.info({ filesReviewed: handoff.filesReviewed, findings: handoff.totalFindings, concurrency: ctx.concurrency }, 'review details');
}


/**
 * Filter a review to only contain data for the specified enabled axes.
 * Blanks disabled axis verdicts to '-' and removes disabled-axis actions.
 */
function filterReviewAxes(review: ReviewFile, enabledAxes: AxisId[]): ReviewFile {
  const enabledSet = new Set<AxisId>(enabledAxes);
  const disabledSymbolAxes: Array<{ key: keyof import('../../../schemas/review.js').SymbolReview; axis: AxisId }> = [
    { key: 'correction', axis: 'correction' },
    { key: 'utility', axis: 'utility' },
    { key: 'duplication', axis: 'duplication' },
    { key: 'overengineering', axis: 'overengineering' },
    { key: 'tests', axis: 'tests' },
    { key: 'documentation', axis: 'documentation' },
  ];

  const filteredSymbols = review.symbols.map((s) => {
    const next = { ...s };
    for (const { key, axis } of disabledSymbolAxes) {
      if (!enabledSet.has(axis) && next[key] !== '-') {
        (next as Record<string, unknown>)[key] = '-';
      }
    }
    if (!enabledSet.has('duplication')) next.duplicate_target = undefined;
    return next;
  });

  const disabledActionSources = new Set<string>();
  for (const axis of ['correction', 'utility', 'duplication', 'overengineering', 'tests', 'documentation', 'best_practices'] as AxisId[]) {
    if (!enabledSet.has(axis)) disabledActionSources.add(axis);
  }
  if (!enabledSet.has('best_practices')) disabledActionSources.add('best-practices');

  const filteredActions = review.actions.filter((a) => !a.source || !disabledActionSources.has(a.source));
  const bestPractices = enabledSet.has('best_practices') ? review.best_practices : undefined;

  return { ...review, symbols: filteredSymbols, actions: filteredActions, best_practices: bestPractices };
}

/**
 * Persist a (merged, full-coverage) review to the project-local store and
 * record per-axis freshness keys for the axes just run. Failures are silently
 * swallowed (non-fatal, logged at debug level).
 *
 * @param axisMeta    Per-axis `{prompt_hash, model_id}` for the just-run axes.
 * @param justRunAxes Axes evaluated this run — their keys are (re)written;
 *                    reused axes keep their prior key (same content).
 */
function cacheReview(
  projectRoot: string,
  review: ReviewFile,
  axisMeta: Record<string, { prompt_hash: string; model_id: string }>,
  justRunAxes: string[],
  sourceRoot?: string,
): void {
  const effectiveRoot = getEffectiveSourceRoot(projectRoot, sourceRoot);
  try {
    const absPath = resolve(effectiveRoot, review.file);
    const fileContent = readFileSync(absPath, 'utf-8');
    writeProjectReview(projectRoot, review, fileContent, axisMeta, justRunAxes);
  } catch (err) {
    getLogger().debug({ file: review.file, err }, 'failed to write project review cache (non-fatal)');
  }
}
