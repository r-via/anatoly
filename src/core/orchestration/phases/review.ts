// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Review phase (extracted from run.ts in PR 7, doc 11 Strategy B).
 *
 * The hot path, deliberately extracted last and against the most-exercised
 * regression net. Move-only: the block below is the verbatim run.ts tail
 * (runReviewPhase + its four review-only helpers filterReviewAxes,
 * loadCachedReview, computeAxesPromptHash, cacheReview, with their JSDocs).
 * Forced edits only: `export` on runReviewPhase (the spine calls it; the
 * four helpers are cluster-private, unexported, verbatim) and the inline
 * dynamic-import path `import('../schemas/review.js')` rebased to
 * `import('../../../schemas/review.js')` for the new module depth.
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
import { withTimeout } from '../../../utils/with-timeout.js';
import type { Task } from '../../../schemas/task.js';
import type { ReviewFile } from '../../../schemas/review.js';
import { generateSkipReview, evaluatorAxesForSkip } from '../../evaluation/index.js';
import { getEnabledEvaluators } from '../../evaluation/index.js';
import { evaluateFile } from '../../evaluation/index.js';
import { runWorkerPool } from '../../platform/index.js';
import { countReviewFindings } from '../../../utils/format.js';
import { warnDisabledAxes } from '../../../utils/axes-filter.js';
import { resolveAxisModel, type AxisId } from '../../evaluation/index.js';
import { getEffectiveSourceRoot } from '../../worktree/index.js';
import { writeProjectReview, loadProjectReview, loadProjectReviewRaw, loadLegacyPathBasedReview } from '../../run/index.js';
import { mergeRefreshedReview, computeMergedAxesCoverage } from '../../run/review-merge.js';
import { computePromptHash } from '../../../utils/cache-meta.js';
import { resolveSystemPrompt } from '../../platform/index.js';
import { recordAgentCosts } from '../cost.js';
import { requestFatalStop } from '../run-control.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { OrchestrationEventName } from '../events.js';
import type { RunContext } from '../../../commands/run.js';

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
  const openProviders = ctx.router
    ? [...ctx.router.breakers.entries()].filter(([, b]) => b.isOpen()).map(([id]) => id)
    : [];
  if (openProviders.length > 0) {
    requestFatalStop(ctx, circuitOpenError(openProviders.join(', ')));
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

  handoff.totalFiles = pending.length + cachedFiles.length;
  // Story 53.5 FR6: announce total file count so `anatoly attach` can render
  // the progress bar denominator (pending + cached).
  rl?.info({ event: ('estimate_total' satisfies OrchestrationEventName), phase: 'review', total: handoff.totalFiles, pending: pending.length, cached: cachedFiles.length }, 'estimate total');

  const allTasks = loadTasks(getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot));
  const taskMap = new Map<string, Task>();
  for (const t of allTasks) taskMap.set(t.file, t);

  const reviewItems: Array<{ filePath: string; task: Task; cached: boolean }> = [
    // Cached files first — instant, no API call
    ...cachedFiles
      .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file), cached: true }))
      .filter((item): item is { filePath: string; task: Task; cached: boolean } => item.task !== undefined),
    // Pending files — actual evaluation
    ...pending
      .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file), cached: false }))
      .filter((item): item is { filePath: string; task: Task; cached: boolean } => item.task !== undefined),
  ];

  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  if (ctx.axesFilter) {
    warnDisabledAxes(ctx.axesFilter, evaluators.map((e) => e.id));
  }
  const axisIds = evaluators.map((e) => e.id);
  const reviewModelId = evaluators.map((e) => resolveAxisModel(e, ctx.config)).sort().join('+');
  const reviewPromptHash = computeAxesPromptHash(axisIds, reviewModelId);
  // A file counts toward evaluateTotal when at least one axis evaluator
  // actually runs on it. Skip-tier files with a partial-axes policy
  // (e.g. trivial files keeping correction/duplication/utility via
  // evaluatorAxesForSkip) DO trigger completedCount++ in the handler,
  // so they must be included here — otherwise completedCount can exceed
  // evaluateTotal and produce displays like "13/12".
  const evaluateTotal = reviewItems.filter((item) => {
    if (item.cached) return false;
    if (!ctx.triageEnabled) return true;
    const triage = triageMap.get(item.filePath);
    if (triage?.tier !== 'skip') return true;
    // Skip-tier file: include only if the partial-axes policy keeps at
    // least one axis running for this skip reason.
    const partialAxes = evaluatorAxesForSkip(triage.reason);
    return evaluators.some((e) => partialAxes.has(e.id));
  }).length;
  const state = ctx.pipelineState!;
  const axesTotal = evaluators.length;
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

      // Handle cached files: load existing review, count findings, display [CACHED]
      if (cached) {
        const cachedReview = loadCachedReview(ctx.projectRoot, filePath, evaluators.map((e) => e.id), reviewPromptHash, ctx.sourceRoot);
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
        // doc 15: the file was DONE/CACHED in progress.json but no review is
        // retrievable for the current axes/prompt-hash (stale cross-run
        // progress, axis-coverage mismatch, or a wiped cache). The pre-doc-15
        // code `return`ed here SILENTLY: the file was audited by nobody and
        // produced zero signal — the exact root cause of `src/wild.ts`
        // vanishing from every slot-engine bench (INV-WILD a structural
        // miss). Make the escape impossible: emit a first-class typed event
        // and fall through to a full evaluation so the file IS reviewed.
        rl?.warn({ event: ('file_cache_miss' satisfies OrchestrationEventName), phase: 'review', file: filePath }, 'expected-cached review missing — re-evaluating (no silent drop)');
        if (ctx.plain) ctx.renderer?.logPlain(`[review] [CACHE-MISS] ${filePath} → re-evaluating (no cached review for current axes)`);
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
      const partialAxesOnSkip = isSkipTier
        ? evaluatorAxesForSkip(triage.reason)
        : null;
      const fileEvaluators = partialAxesOnSkip
        ? evaluators.filter((e) => partialAxesOnSkip.has(e.id))
        : evaluators;

      // Pure-skip path: triage decided no axis should run on this file.
      // Generate a synthetic review; the usage graph still resolves the
      // utility verdict per symbol so unused type/constant exports
      // surface as DEAD instead of blanket USED.
      if (isSkipTier && fileEvaluators.length === 0) {
        pm.updateFileStatus(filePath, 'IN_PROGRESS');
        const skipReview = generateSkipReview(task, triage.reason, ctx.axesFilter, usageGraph);
        writeReviewOutput(ctx.projectRoot, skipReview, ctx.runDir);
        if (!ctx.noCache) cacheReview(ctx.projectRoot, skipReview, reviewPromptHash, reviewModelId, axisIds, ctx.sourceRoot);
        pm.updateFileStatus(filePath, 'DONE', undefined, evaluators.map(e => e.id));
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
      let timedOut = false;
      // Axes that started but did not complete (still in flight or crashed).
      // Captured for SDK_TIMEOUT / generic-failure error details so the
      // end-of-run summary can name the suspect axes (the per-file timeout
      // wraps the multi-axis fan-out, otherwise that signal is lost).
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
            isInterrupted: () => ctx.interrupted || timedOut,
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
        // Wall-clock budget per file: the agentic axes have no SDK-level
        // timeout, so a single stuck file would otherwise hang the review
        // worker pool indefinitely. `currentAbort` is read live (it may be
        // re-created across retries), so the abort always hits the active call.
        const result = await withTimeout(runEval, {
          timeoutMs: ctx.config.runtime.timeout_per_file * 1000,
          label: `review ${filePath}`,
          onTimeout: () => {
            timedOut = true;
            currentAbort.abort();
          },
        });

        // Selective refresh: when (--cache-refresh + --axes filter) only
        // some axes ran, but the on-disk cache may still hold valid verdicts
        // for the others (same file content). Merge the fresh partial
        // result with the cached entry so the run dir AND the cache reflect
        // full coverage; otherwise --axes utility --cache-refresh would
        // shrink the cache to utility-only and force every future run to
        // re-evaluate everything to recover.
        let outputReview = result.review;
        let coverageAxes: string[] = fileEvaluators.map((e) => e.id);
        if (ctx.cacheRefresh && ctx.axesFilter && ctx.axesFilter.length > 0) {
          try {
            const absPath = resolve(getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot), filePath);
            const cacheSource = loadProjectReviewRaw(
              ctx.projectRoot,
              filePath,
              readFileSync(absPath, 'utf-8'),
            );
            if (cacheSource.review) {
              outputReview = mergeRefreshedReview(cacheSource.review, result.review, ctx.axesFilter);
              coverageAxes = computeMergedAxesCoverage(outputReview, ctx.axesFilter, cacheSource.axes);
              if (cacheSource.cachedPromptHash && cacheSource.cachedPromptHash !== reviewPromptHash) {
                // Prompts have drifted between the cached run and now (different
                // bundle hash). We still trust the cached verdicts for the
                // non-refreshed axes — that is the selective-refresh contract —
                // but the user should know so they can choose to force a full
                // `--cache-refresh` after a tool upgrade.
                getLogger().warn(
                  { file: filePath, cached: cacheSource.cachedPromptHash, current: reviewPromptHash },
                  'selective-refresh: cached prompt hash drifted; non-refreshed axes may be stale (run `--cache-refresh` without --axes to fully refresh)',
                );
              }
            } else {
              // No usable cache source. Log at warn (not debug) so a broken
              // merge does not silently downgrade coverage. Common causes:
              // file content changed since last cache, no prior run at all,
              // index entry missing.
              getLogger().warn(
                { file: filePath, reason: cacheSource.axes.length === 0 ? 'no-index-entry-or-content-drift' : 'cache-blob-missing' },
                'selective-refresh: no cache source to merge — partial review will be written instead of full coverage',
              );
            }
          } catch (err) {
            getLogger().warn({ file: filePath, err }, 'selective-refresh merge failed; falling back to partial review');
          }
        }
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
          if (!ctx.noCache) cacheReview(ctx.projectRoot, outputReview, reviewPromptHash, reviewModelId, coverageAxes, ctx.sourceRoot);
          pm.updateFileStatus(filePath, 'DONE', undefined, succeededAxes);
          handoff.filesReviewed++;
          ctx.reviewCounts.evaluated++;
          ctx.freshFiles.add(filePath);
          completedCount++;
          handoff.totalFindings += countReviewFindings(result.review, 60);
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
 * Load a single cached review from the project-local content-addressable store.
 * Returns the parsed ReviewFile or undefined if not found / malformed.
 *
 * Both `enabledAxes` and `promptHash` are required: the cache key depends on
 * both, and callers that want to bypass cache should simply not call this.
 *
 * Falls back to the pre-Story-52.4 path-based cache layout when the new store
 * has no entry, so projects upgrading from an older anatoly version don't
 * lose every cached review at once. The legacy fallback is read-only and
 * will be removed in a future release.
 *
 * Filters out stale data for axes that are no longer enabled in the current config.
 */
function loadCachedReview(projectRoot: string, filePath: string, enabledAxes: AxisId[], promptHash: string, sourceRoot?: string): ReviewFile | undefined {
  const effectiveRoot = getEffectiveSourceRoot(projectRoot, sourceRoot);
  const absPath = resolve(effectiveRoot, filePath);

  let fileContent: string;
  try {
    fileContent = readFileSync(absPath, 'utf-8');
  } catch (err) {
    getLogger().debug({ file: filePath, err }, 'cache lookup skipped: source file unreadable');
    return undefined;
  }

  // Current content-addressable cache (post-Story-52.4)
  const cached = loadProjectReview(projectRoot, filePath, fileContent, promptHash, enabledAxes);
  if (cached) return filterReviewAxes(cached, enabledAxes);

  // Transitional: legacy path-based cache. Warns once per process on first hit.
  const legacy = loadLegacyPathBasedReview(projectRoot, filePath);
  if (legacy) return filterReviewAxes(legacy, enabledAxes);

  return undefined;
}

/**
 * Compute a combined prompt hash for all enabled axis system prompts.
 * Used as the `prompt_hash` in shared review cache `_meta` headers.
 */
function computeAxesPromptHash(axisIds: string[], modelId: string): string {
  const sortedAxes = [...axisIds].sort();
  const systemPrompts = sortedAxes.map((id) => {
    try { return resolveSystemPrompt(id); } catch { return id; }
  }).join('\0');
  return computePromptHash({
    schemaVersion: 1,
    modelId,
    systemPrompt: systemPrompts,
    userTemplate: '', // User template varies per file — we use content hash for that
  });
}

/**
 * Persist a review to the project-local content-addressable store.
 * Failures are silently swallowed (non-fatal, logged at debug level).
 *
 * @param projectRoot Absolute path to the project root.
 * @param review Parsed review file to cache.
 */
function cacheReview(
  projectRoot: string,
  review: ReviewFile,
  promptHash: string,
  modelId: string,
  axes: string[],
  sourceRoot?: string,
): void {
  const effectiveRoot = getEffectiveSourceRoot(projectRoot, sourceRoot);
  try {
    const absPath = resolve(effectiveRoot, review.file);
    const fileContent = readFileSync(absPath, 'utf-8');
    writeProjectReview(projectRoot, review, fileContent, promptHash, modelId, axes);
  } catch (err) {
    getLogger().debug({ file: review.file, err }, 'failed to write project review cache (non-fatal)');
  }
}
