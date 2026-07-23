// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Report phase (extracted from run.ts in PR 2, doc 11 Strategy B).
 *
 * Move-only: the body below is the verbatim `runReportPhase` from run.ts. The
 * only edits are the unavoidable consequences of relocation:
 *   - `formatDuration(...)` -> `formatRunDuration(...)` (the run.ts-local
 *     helper was relocated to utils/format.ts under a non-clashing name; the
 *     body is byte-identical so behavior is unchanged).
 *   - `countPendingDocConflicts` now imported from doc-conflict-store.
 *   - import paths rewritten for the new module depth.
 * `RunContext` is imported type-only, so there is no runtime dependency on
 * (and no import cycle with) the commands layer.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { writeFileSync } from 'node:fs';
import type { Handoff } from '../handoff.js';
import { relative, basename } from 'node:path';
import chalk from 'chalk';

import { getLogger } from '../../../utils/logger.js';
import { ProgressManager } from '../../run/index.js';
import { estimateFileSeconds } from '../../run/index.js';
import { generateReport, loadReviews, axisHealthPercent, REPORT_AXIS_IDS, toReportAxisId, type TriageStats, type ReportAxisId } from '../../reporting/index.js';
import { getDocsDir } from '../../../schemas/config.js';
import { aggregateDocReport } from '../../documentation/index.js';
import { purgeRuns } from '../../../utils/run-id.js';
import { injectBadge } from '../../reporting/index.js';
import { sendNotifications, type NotificationPayload } from '../../notifications/index.js';
import { formatCompactTokens, formatRunDuration } from '../../../utils/format.js';
import { getActiveSinkTotals, writeCostSummary, writeCostVariance } from '../../../utils/llm-calls-sink.js';
import { runMetricsPath, docReferenceSectionPath, docReportStatsPath, reviewsDir, logsDir, runEventLogPath } from '../../../utils/run-layout.js';
import { getEnabledEvaluators } from '../../evaluation/index.js';
import { resolveAxisModel } from '../../evaluation/index.js';
import { countPendingDocConflicts } from '../../documentation/index.js';
import { openFile } from '../../../utils/open.js';
import { recalibrateFromRuns, saveCalibration } from '../../evaluation/index.js';
import { writeRunStatus, getGitInfo, type RunStatus } from '../../run/index.js';
import { createWorktreeManager } from '../../worktree/index.js';
import type { RunContext } from '../../../commands/run.js';

export function runReportPhase(ctx: RunContext, handoff: Handoff): void {
  const log = getLogger();
  const rl = ctx.runLog;
  const pm = new ProgressManager(ctx.projectRoot);
  // Scope "Files in Error" to failures that occurred during THIS run. The
  // progress store is global (persists across runs), so scanning it unfiltered
  // re-listed files left ERROR/TIMEOUT by an earlier run in every subsequent
  // report — even when the current run never touched them, contradicting the
  // run's own errors:0 summary. getErrorFilesSince keeps only failures whose
  // updated_at falls within this run.
  const errorFiles = pm.getErrorFilesSince(ctx.startTime);

  let triageStats: TriageStats | undefined;
  if (ctx.triageEnabled) {
    const { skipped, cached, evaluated } = ctx.reviewCounts;
    const total = skipped + cached + evaluated;
    // Time saved = weighted seconds of files that were skipped (would have been evaluated)
    let skippedSeconds = 0;
    for (const task of handoff.allTasks) {
      if (handoff.triageMap.get(task.file)?.tier === 'skip') {
        skippedSeconds += estimateFileSeconds(task.symbols.length);
      }
    }
    triageStats = {
      total,
      skip: skipped,
      evaluate: evaluated,
      estimatedTimeSaved: skippedSeconds / 60,
    };
  }

  const runStats: import('../../reporting/index.js').RunStats = {
    runId: ctx.runId,
    durationMs: Date.now() - ctx.startTime,
    costUsd: ctx.totalCostUsd,
    axisStats: ctx.axisStats,
    phaseDurations: ctx.phaseDurations,
    degradedReviews: ctx.degradedReviews,
  };
  // Cached reviews are now copied into the run dir during the review phase handler,
  // so copyCachedReviews is no longer needed here.

  // --- Doc report aggregation ---
  let docReferenceSection: string | undefined;
  if (handoff.docPipelineResult) {
    try {
      const reviews = loadReviews(ctx.projectRoot, ctx.runDir);
      const idealPageCount = handoff.docPipelineResult.generation?.totalPages ?? 0;
      const cacheResult = handoff.docPipelineResult.generation?.cacheResult;
      const newPageSources = handoff.docPipelineResult.generation?.cacheResult.added.map(p => ({
        page: p,
        source: `scaffolded`,
      }));
      handoff.docReportResult = aggregateDocReport({
        projectRoot: ctx.projectRoot,
        projectTypes: handoff.docPipelineResult.scaffold.projectTypes,
        reviews,
        tasks: handoff.allTasks,
        idealPageCount,
        cacheResult,
        newPageSources,
        docsPath: getDocsDir(ctx.config),
      });
      docReferenceSection = handoff.docReportResult.renderedSection;
      log.info({ docScore: handoff.docReportResult.score.overall, docVerdict: handoff.docReportResult.score.verdict, recommendations: handoff.docReportResult.recommendations.length }, 'doc report aggregated');
      rl?.info({ docScore: handoff.docReportResult.score.overall, docVerdict: handoff.docReportResult.score.verdict }, 'doc report aggregated');
    } catch (err) {
      log.warn({ err }, 'doc report aggregation failed');
      rl?.warn({ err }, 'doc report aggregation failed');
    }
  } else if (ctx.profile && handoff.allTasks.length > 0) {
    // Fallback: no doc pipeline ran (e.g. cached run), but we can still
    // aggregate coverage metrics from reviews + profile.
    try {
      const reviews = loadReviews(ctx.projectRoot, ctx.runDir);
      handoff.docReportResult = aggregateDocReport({
        projectRoot: ctx.projectRoot,
        projectTypes: ctx.profile.types,
        reviews,
        tasks: handoff.allTasks,
        idealPageCount: 0,
        docsPath: getDocsDir(ctx.config),
      });
      docReferenceSection = handoff.docReportResult.renderedSection;
      log.info({ docScore: handoff.docReportResult.score.overall }, 'doc report aggregated (from cached reviews)');
    } catch (err) {
      log.warn({ err }, 'doc report aggregation fallback failed');
    }
  }

  // Persist doc reference section + structured stats so `anatoly report` can
  // reload both. The stats are the canonical input for the public report's
  // doc-coverage section (no regex parsing of the rendered markdown).
  if (docReferenceSection && ctx.runDir) {
    writeFileSync(docReferenceSectionPath(ctx.runDir), docReferenceSection);
  }
  if (handoff.docReportResult?.reportStats && ctx.runDir) {
    writeFileSync(docReportStatsPath(ctx.runDir), JSON.stringify(handoff.docReportResult.reportStats, null, 2));
  }

  // Pass the --axes filter (if any) so the report renders skipped axes as
  // "not in this run" instead of "All clear" (which would lie about coverage).
  const axesRequestedForReport = ctx.axesFilter
    ? ctx.axesFilter.map(toReportAxisId)
    : undefined;
  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir, triageStats, runStats, docReferenceSection, undefined, undefined, handoff.docReportResult?.reportStats, axesRequestedForReport);

  if (ctx.config.output?.max_runs) {
    purgeRuns(ctx.projectRoot, ctx.config.output.max_runs!);
  }

  // Badge injection (before summary display)
  let badgeNote = '';
  if (ctx.badge.enabled) {
    const badgeResult = injectBadge({
      projectRoot: ctx.projectRoot,
      verdict: data.globalVerdict,
      includeVerdict: ctx.badge.verdict,
      link: ctx.badge.link,
    });
    if (badgeResult.injected && !badgeResult.updated) {
      badgeNote = ' (badge added in README.md)';
    }
  }

  // Notifications (fire-and-forget, after report generation)
  {
    const notifPayload: NotificationPayload = {
      projectName: ctx.config.project.name ?? basename(ctx.projectRoot),
      verdict: data.globalVerdict,
      totalFiles: data.totalFiles,
      evaluated: ctx.reviewCounts.evaluated,
      cached: ctx.reviewCounts.cached,
      cleanFiles: data.cleanFiles.length,
      findingFiles: data.findingFiles.length,
      errorFiles: data.errorFiles.length,
      durationMs: Date.now() - ctx.startTime,
      costUsd: ctx.totalCostUsd,
      totalTokens: Object.values(ctx.axisStats).reduce((s, a) => s + a.totalInputTokens + a.totalOutputTokens + a.totalCacheReadTokens + a.totalCacheCreationTokens, 0),
      axisScorecard: Object.fromEntries(
        REPORT_AXIS_IDS
          .filter((axis) => {
            const configAxisKey: Record<ReportAxisId, keyof typeof ctx.config.axes> = {
              correction: 'correction', utility: 'utility', duplication: 'duplication',
              overengineering: 'overengineering', tests: 'tests', documentation: 'documentation',
              'best-practices': 'best_practices', flow: 'flow',
            };
            return ctx.config.axes[configAxisKey[axis]]?.enabled !== false;
          })
          .map((axis) => {
            const countsKey: Record<ReportAxisId, keyof typeof data.counts> = {
              correction: 'correction', utility: 'dead', duplication: 'duplicate',
              overengineering: 'overengineering', tests: 'tests', documentation: 'documentation',
              'best-practices': 'best_practices', flow: 'flow',
            };
            const c = data.counts[countsKey[axis]];
            const { pct, label } = axisHealthPercent(data, axis);
            return [countsKey[axis], { ...c, healthPct: pct, label }];
          }),
      ),
      reportUrl: ctx.config.notifications?.telegram?.report_url ?? undefined,
    };
    // Fire-and-forget: errors are caught internally by sendNotifications
    void sendNotifications(ctx.config, notifPayload);
  }

  const { skipped, cached, evaluated } = ctx.reviewCounts;
  const cachedNote = cached > 0 ? `${cached} cached \u00b7 ` : '';
  const tierSummary = ctx.triageEnabled
    ? ` (${cachedNote}${skipped} skipped \u00b7 ${evaluated} evaluated)`
    : cached > 0 ? ` (${cachedNote}${evaluated} evaluated)` : '';
  const duration = formatRunDuration(Date.now() - ctx.startTime);
  const rel = (p: string) => relative(process.cwd(), p) || '.';
  const costStr = `$${ctx.totalCostUsd.toFixed(2)}`;
  const costColor = ctx.totalCostUsd > 5 ? chalk.red.bold : ctx.totalCostUsd > 1 ? chalk.yellow.bold : chalk.green.bold;

  // Token counts come from the per-call sink (totals updated on every
  // recordLlmCall). We render compact (e.g. 58K) and skip them entirely
  // only if the sink is somehow absent \u2014 should never happen for `run`.
  const sinkTotals = getActiveSinkTotals();
  const tokensFragment = sinkTotals
    ? `${formatCompactTokens(sinkTotals.inputTokens)} tokens in / ${formatCompactTokens(sinkTotals.outputTokens)} tokens out`
    : '';

  // The "$0.00 with Claude Code" hint is shown only when the user is on the
  // Claude Code subscription (mode: subscription) AND there were Anthropic
  // calls. Without subscription, the hint loses its meaning (no savings to
  // show), so we drop it.
  const isAnthropicSubscription =
    ctx.config.providers.anthropic?.mode === 'subscription' &&
    ctx.providerStats.anthropic.calls > 0;
  const claudeCodeHint = isAnthropicSubscription
    ? ` \u00b7 ${chalk.green.bold('$0.00')} with Claude Code`
    : '';

  const dollars = `${costColor(costStr)} in API calls`;

  const costLine = tokensFragment
    ? `${chalk.bold('Cost:')} ${tokensFragment} \u00b7 ${dollars}${claudeCodeHint}`
    : `${chalk.bold('Cost:')} ${dollars}${claudeCodeHint}`;

  // Transition pipeline display to summary
  const state = ctx.pipelineState;
  if (state) {
    state.completeTask('report', 'done');
    state.setSummary({
      headline: chalk.bold('Done') + ` \u2014 ${data.totalFiles} files | ${handoff.totalFindings} findings | ${data.cleanFiles.length} clean${tierSummary} | ${duration}${badgeNote}`,
      paths: [
        { key: 'run', value: ctx.runId },
        { key: 'report', value: chalk.cyan(rel(reportPath)) },
        { key: 'reviews', value: chalk.cyan(rel(reviewsDir(ctx.runDir)) + '/') },
        { key: 'transcripts', value: chalk.cyan(rel(logsDir(ctx.runDir)) + '/') },
        { key: 'log', value: chalk.cyan(rel(runEventLogPath(ctx.runDir))) },
      ],
      cost: costLine,
    });
  }

  // Stop renderer — final frame will show summary
  ctx.renderer?.stop();

  // Plain mode: print summary to stdout
  if (ctx.plain || !state) {
    console.log('');
    console.log(chalk.bold('Done') + ` \u2014 ${data.totalFiles} files | ${handoff.totalFindings} findings | ${data.cleanFiles.length} clean${tierSummary} | ${duration}`);
    console.log('');
    console.log(`  run          ${ctx.runId}`);
    console.log(`  report       ${chalk.cyan(rel(reportPath))}`);
    console.log(`  reviews      ${chalk.cyan(rel(reviewsDir(ctx.runDir)) + '/')}`);
    console.log(`  transcripts  ${chalk.cyan(rel(logsDir(ctx.runDir)) + '/')}`);
    console.log(`  log          ${chalk.cyan(rel(runEventLogPath(ctx.runDir)))}`);
    console.log('');
    console.log(`  ${costLine}`);
  }

  // Quick-win suggestion (Story 48.8) — only on successful runs
  if (ctx.quickWin && !ctx.interrupted) {
    console.log('');
    console.log(chalk.dim('  \uD83D\uDCA1 Ran in quick-win mode (3 axes, no docs).'));
    console.log(chalk.dim('  Run `anatoly run` again for the full audit (7 axes + doc analysis).'));
  }

  // Story 55.9: end-of-run reminder about pending doc conflicts (FR17)
  if (!ctx.interrupted) {
    const endPendingConflicts = countPendingDocConflicts(ctx.projectRoot);
    if (endPendingConflicts > 0) {
      console.log('');
      console.log(chalk.yellow(`  ${endPendingConflicts} doc conflicts pending — run \`anatoly docs arbitrate\``));
    }
  }

  // Subscription usage limit hit during a best-effort tail phase: the report
  // was still produced from the completed review, but the skipped phases left
  // the run incomplete. Surface it loudly (not just in the JSON) so the user
  // knows to resume — `anatoly run` will detect the incomplete run and offer it.
  if (ctx.incompletePhases.size > 0) {
    const phases = [...ctx.incompletePhases].join(', ');
    const resetHint = ctx.rateLimitResetAt
      ? ` (resets ${new Date(ctx.rateLimitResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
      : '';
    console.log('');
    console.log(chalk.yellow.bold(`  ⚠ Subscription usage limit hit — ${phases} left incomplete${resetHint}.`));
    console.log(chalk.yellow(`  The report reflects the completed review. Run \`anatoly run\` after the limit resets to resume and finish ${phases}.`));
  }

  if (ctx.shouldOpen) openFile(reportPath);

  // Run summary
  const totalDurationMs = Date.now() - ctx.startTime;
  log.info({
    runId: ctx.runId, totalDurationMs, totalCostUsd: ctx.totalCostUsd,
    filesReviewed: handoff.filesReviewed, findings: handoff.totalFindings,
    cached: ctx.reviewCounts.cached, skipped: ctx.reviewCounts.skipped,
    errors: ctx.errorCount,
  }, 'run completed');

  // Log error summary by code (if any errors occurred)
  if (ctx.errorCount > 0) {
    log.warn({ errorsByCode: ctx.errorsByCode, files: ctx.errorDetails, total: ctx.errorCount }, 'run error summary');
    rl?.warn({ errorsByCode: ctx.errorsByCode, files: ctx.errorDetails, total: ctx.errorCount }, 'run error summary');
  }

  // Write run summary to per-run log file
  ctx.runLog?.info({
    runId: ctx.runId, totalDurationMs, totalCostUsd: ctx.totalCostUsd,
    filesReviewed: handoff.filesReviewed, findings: handoff.totalFindings,
    errors: ctx.errorCount, errorsByCode: ctx.errorsByCode,
    phaseDurations: ctx.phaseDurations,
  }, 'run completed');

  // Derive conversationStats from axisStats (review-phase axis evaluations).
  // RAG + doc-gen LLM costs are aggregated into ctx.totalCostUsd directly.
  const conversationStats = {
    total: 0,
    byPhase: {} as Record<string, number>,
    byModel: {} as Record<string, number>,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };
  for (const [, s] of Object.entries(ctx.axisStats)) {
    conversationStats.total += s.calls;
    conversationStats.totalInputTokens += s.totalInputTokens;
    conversationStats.totalOutputTokens += s.totalOutputTokens;
    conversationStats.totalCostUsd += s.totalCostUsd;
  }
  if (conversationStats.total > 0) {
    conversationStats.byPhase.review = conversationStats.total;
    const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
    for (const e of evaluators) {
      const s = ctx.axisStats[e.id];
      if (s) {
        conversationStats.byModel[resolveAxisModel(e, ctx.config)] = (conversationStats.byModel[resolveAxisModel(e, ctx.config)] ?? 0) + s.calls;
      }
    }
  }

  // Write run-metrics.json
  const metrics = {
    runId: ctx.runId,
    durationMs: totalDurationMs,
    filesReviewed: handoff.filesReviewed,
    evaluated: ctx.reviewCounts.evaluated,
    cached: ctx.reviewCounts.cached,
    findings: handoff.totalFindings,
    errors: ctx.errorCount,
    errorsByCode: ctx.errorsByCode,
    degradedReviews: ctx.degradedReviews,
    costUsd: ctx.totalCostUsd,
    providers: {
      anthropic: { calls: ctx.providerStats.anthropic.calls, costUsd: Math.round(ctx.providerStats.anthropic.costUsd * 100) / 100 },
    },
    phaseDurations: ctx.phaseDurations,
    axisStats: ctx.axisStats,
    phaseStats: ctx.phaseStats,
    timeline: ctx.timeline.sort((a, b) => a.t - b.t),
    conversations: conversationStats,
  };
  try {
    writeFileSync(runMetricsPath(ctx.runDir), JSON.stringify(metrics, null, 2) + '\n');
  } catch {
    log.warn({ runId: ctx.runId }, 'failed to write run-metrics.json');
  }

  // D.4 Cost Plane — emit summary.json + variance.json from the ledger (Story 56.5 FR10)
  try {
    writeCostSummary(ctx.runDir);
    writeCostVariance(ctx.runDir);
  } catch (err) {
    log.warn({ runId: ctx.runId, err }, 'failed to write cost summary/variance');
  }

  // Recalibrate axis timing from all historical runs (including this one)
  try {
    const updatedCalibration = recalibrateFromRuns(ctx.projectRoot);
    saveCalibration(ctx.projectRoot, updatedCalibration);
    log.debug({ calibration: updatedCalibration.axes }, 'calibration updated');
  } catch (err) {
    log.warn({ runId: ctx.runId, err }, 'failed to update calibration');
  }

  // Persist run-status.json — transition to 'done' (Story 53.1).
  // The status stays 'done' (the review completed and a report was produced),
  // but a usage-limit hit in a best-effort tail phase is recorded in
  // `incompletePhases` so `detectResumableRun` offers a resume next time.
  if (ctx.runDir) {
    const gi = ctx.gitInfo ?? getGitInfo(ctx.projectRoot);
    const runStatus: RunStatus = {
      runId: ctx.runId,
      pid: process.pid,
      status: 'done',
      startedAt: new Date(ctx.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      branch: gi.branch,
      commit: gi.commit,
      background: !!process.env.ANATOLY_BACKGROUND_MODE,
      ...(ctx.incompletePhases.size > 0 ? { incompletePhases: [...ctx.incompletePhases] } : {}),
    };
    writeRunStatus(ctx.runDir, runStatus);
  }

  // Cleanup worktree for background runs (fire-and-forget — errors logged only)
  if (process.env.ANATOLY_BACKGROUND_MODE && ctx.sourceRoot) {
    try {
      const wm = createWorktreeManager(ctx.projectRoot);
      void wm.remove(ctx.runId).catch((wtErr) => {
        log.warn({ runId: ctx.runId, err: wtErr }, 'failed to cleanup worktree after background run');
      });
    } catch (wtErr) {
      log.warn({ runId: ctx.runId, err: wtErr }, 'failed to cleanup worktree after background run');
    }
  }

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;

}
