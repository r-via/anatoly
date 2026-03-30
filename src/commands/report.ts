// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, join, basename } from 'node:path';
import { generateReport, loadReviews, axisHealthPercent, REPORT_AXIS_IDS, type AxisReport, type RunStats, type ReportAxisId } from '../core/reporter.js';
import { ProgressManager } from '../core/progress-manager.js';
import { resolveRunDir } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { verdictColor } from '../utils/format.js';
import { isLockActive } from '../utils/lock.js';
import { detectProjectProfile } from '../core/language-detect.js';
import { loadTasks } from '../core/estimator.js';
import { aggregateDocReport } from '../core/doc-report-aggregator.js';
import { loadConfig } from '../utils/config-loader.js';
import { sendNotifications, type NotificationPayload } from '../core/notifications/index.js';

/** Registers the `report` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Aggregate review results into a structured Markdown report')
    .option('--run <id>', 'generate report from a specific run (default: latest)')
    .option('--notify', 'send notification after report generation')
    .option('--debug', 'print the notification payload before sending')
    .action(async (cmdOpts: { run?: string; notify?: boolean; debug?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before generating a report.'));
        process.exitCode = 1;
        return;
      }

      const parentOpts = program.opts();
      const shouldOpen = parentOpts.open as boolean | undefined;

      // Resolve run directory
      const runDir = resolveRunDir(projectRoot, cmdOpts.run);

      // Collect error files from progress (shared by both modes)
      const errorFiles: string[] = [];
      const pm = new ProgressManager(projectRoot);
      const progressPath = resolve(projectRoot, '.anatoly', 'cache', 'progress.json');
      if (existsSync(progressPath)) {
        const progress = pm.getProgress();
        for (const [, fp] of Object.entries(progress.files)) {
          if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') {
            errorFiles.push(fp.file);
          }
        }
      }

      // Try to load run-metrics.json for runStats (used by public_report.md)
      let runStats: RunStats | undefined;
      const metricsPath = runDir ? join(runDir, 'run-metrics.json') : undefined;
      if (metricsPath && existsSync(metricsPath)) {
        try {
          runStats = JSON.parse(readFileSync(metricsPath, 'utf-8')) as RunStats;
        } catch { /* ignore malformed metrics */ }
      }

      // reportsBaseUrl is only set by `anatoly run` when publishing to anatoly-reports
      const reportsBaseUrl = undefined;

      // Re-aggregate doc coverage from current reviews + profile
      let docReferenceSection: string | undefined;
      if (runDir && existsSync(resolve(runDir, 'reviews'))) {
        try {
          const config = loadConfig(projectRoot);
          const reviews = loadReviews(projectRoot, runDir);
          const tasks = loadTasks(projectRoot);
          const profile = detectProjectProfile(projectRoot);
          const result = aggregateDocReport({
            projectRoot,
            projectTypes: profile.types,
            reviews,
            tasks,
            idealPageCount: 0,
            docsPath: config.documentation?.docs_path ?? 'docs',
          });
          docReferenceSection = result.renderedSection;
        } catch {
          // Fallback: load persisted section from previous run
          const docSectionPath = join(runDir, 'doc-reference-section.md');
          if (existsSync(docSectionPath)) {
            docReferenceSection = readFileSync(docSectionPath, 'utf-8');
          }
        }
      }

      let reportData: ReturnType<typeof generateReport>['data'] | undefined;

      if (runDir && existsSync(resolve(runDir, 'reviews'))) {
        // Run-scoped mode: read reviews from run directory
        const { reportPath, data, axisReports } = generateReport(projectRoot, errorFiles, runDir, undefined, runStats, docReferenceSection, reportsBaseUrl);
        reportData = data;
        printReportSummary(data, axisReports, reportPath, resolve(runDir, 'reviews'));
        if (shouldOpen) openFile(reportPath);
      } else {
        // Legacy fallback: read from flat .anatoly/reviews/
        if (existsSync(progressPath)) {
          const summary = pm.getSummary();
          if (summary.DONE === 0 && summary.CACHED === 0) {
            console.log(chalk.yellow('No completed reviews found. Run `anatoly run` first.'));
            return;
          }
        }

        const { reportPath, data, axisReports } = generateReport(projectRoot, errorFiles);
        reportData = data;
        printReportSummary(data, axisReports, reportPath, resolve(projectRoot, '.anatoly', 'reviews'));
        if (shouldOpen) openFile(reportPath);
      }

      // Send notification if --notify flag is set
      if ((cmdOpts.notify || cmdOpts.debug) && reportData) {
        const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

        // Build scorecard with real health percentages (same source as public_report.md)
        const countsKey: Record<ReportAxisId, keyof typeof reportData.counts> = {
          correction: 'correction', utility: 'dead', duplication: 'duplicate',
          overengineering: 'overengineering', tests: 'tests', documentation: 'documentation',
          'best-practices': 'best_practices',
        };
        const axisScorecard = Object.fromEntries(
          REPORT_AXIS_IDS.map((axis) => {
            const c = reportData!.counts[countsKey[axis]];
            const { pct, label } = axisHealthPercent(reportData!, axis);
            return [countsKey[axis], { ...c, healthPct: pct, label }];
          }),
        );

        const payload: NotificationPayload = {
          projectName: config.project.name ?? basename(projectRoot),
          verdict: reportData.globalVerdict,
          totalFiles: reportData.totalFiles,
          evaluated: runStats?.evaluated ?? reportData.totalFiles,
          cached: runStats?.cached ?? 0,
          cleanFiles: reportData.cleanFiles.length,
          findingFiles: reportData.findingFiles.length,
          errorFiles: reportData.errorFiles.length,
          durationMs: runStats?.durationMs ?? 0,
          costUsd: runStats?.costUsd ?? 0,
          totalTokens: runStats ? Object.values(runStats.axisStats).reduce((s, a) => s + a.totalInputTokens + a.totalOutputTokens + a.totalCacheReadTokens + a.totalCacheCreationTokens, 0) : 0,
          axisScorecard,
          reportUrl: config.notifications?.telegram?.report_url ?? undefined,
        };

        if (cmdOpts.debug) {
          console.log(chalk.bold('\n── Notification payload ──\n'));
          console.log(chalk.dim('project:    ') + payload.projectName);
          console.log(chalk.dim('verdict:    ') + payload.verdict);
          console.log(chalk.dim('files:      ') + `${payload.evaluated} evaluated, ${payload.cached} cached, ${payload.totalFiles} total`);
          console.log(chalk.dim('tokens:     ') + payload.totalTokens);
          console.log(chalk.dim('duration:   ') + `${Math.round(payload.durationMs / 60_000)} min`);
          console.log(chalk.dim('cost:       ') + `$${payload.costUsd.toFixed(2)}`);
          console.log(chalk.dim('reportUrl:  ') + (payload.reportUrl ?? '(none)'));
          console.log('');
          console.log(chalk.bold('Axis scorecard:'));
          for (const [axis, c] of Object.entries(payload.axisScorecard)) {
            const parts = [c.high && `${c.high}H`, c.medium && `${c.medium}M`, c.low && `${c.low}L`].filter(Boolean).join(' ');
            console.log(`  ${axis.padEnd(16)} ${String(c.healthPct).padStart(3)}% ${c.label.padEnd(14)} ${parts || '—'}`);
          }
          console.log('');
        }

        if (cmdOpts.notify) {
          try {
            await sendNotifications(config, payload, projectRoot);
            console.log(chalk.green('✓ Notification sent'));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(chalk.yellow(`Notification failed: ${msg}`));
          }
        }
      }
    });
}

function printReportSummary(
  data: ReturnType<typeof generateReport>['data'],
  axisReports: AxisReport[],
  reportPath: string,
  reviewsPath: string,
): void {
  console.log(chalk.bold(`\nAnatoly Report — ${data.totalFiles} files reviewed`));
  console.log(`Verdict: ${verdictColor(data.globalVerdict)}`);
  console.log('');

  const cor = data.counts.correction;
  const dc = data.counts.dead;
  const dup = data.counts.duplicate;
  const ov = data.counts.overengineering;
  const tst = data.counts.tests;
  const doc = data.counts.documentation;
  const bp = data.counts.best_practices;

  const totalCorr = cor.high + cor.medium + cor.low;
  const totalDead = dc.high + dc.medium + dc.low;
  const totalDup = dup.high + dup.medium + dup.low;
  const totalOver = ov.high + ov.medium + ov.low;
  const totalTests = tst.high + tst.medium + tst.low;
  const totalDocs = doc.high + doc.medium + doc.low;
  const totalBp = bp.high + bp.medium + bp.low;

  type Row = { label: string; total: number; detail: string };
  const rows: Row[] = [];
  const sev = (c: { high: number; medium: number; low: number }) =>
    [c.high && `${c.high} high`, c.medium && `${c.medium} medium`, c.low && `${c.low} low`].filter(Boolean).join(', ');

  if (totalCorr > 0) rows.push({ label: 'Correction', total: totalCorr, detail: sev(cor) });
  if (totalDead > 0) rows.push({ label: 'Dead code', total: totalDead, detail: sev(dc) });
  if (totalDup > 0) rows.push({ label: 'Duplicates', total: totalDup, detail: sev(dup) });
  if (totalOver > 0) rows.push({ label: 'Over-engineering', total: totalOver, detail: sev(ov) });
  if (totalTests > 0) rows.push({ label: 'Tests', total: totalTests, detail: sev(tst) });
  if (totalBp > 0) rows.push({ label: 'Best practices', total: totalBp, detail: sev(bp) });
  if (totalDocs > 0) rows.push({ label: 'Documentation', total: totalDocs, detail: sev(doc) });

  if (rows.length > 0) {
    const maxLabel = Math.max(...rows.map((r) => r.label.length));
    const maxTotal = Math.max(...rows.map((r) => String(r.total).length));
    for (const r of rows) {
      console.log(`  ${r.label.padEnd(maxLabel)}  ${String(r.total).padStart(maxTotal)}  (${r.detail})`);
    }
    console.log('');
  }

  console.log(`  Findings:  ${data.findingFiles.length} files`);
  console.log(`  Clean:     ${data.cleanFiles.length}`);
  if (data.errorFiles.length > 0) {
    console.log(`  Errors:    ${data.errorFiles.length}`);
  }
  console.log('');
  const rel = (p: string) => relative(process.cwd(), p) || '.';
  console.log(`Report: ${chalk.cyan(rel(reportPath))}`);
  if (axisReports.length > 0) {
    const reportDir = dirname(reportPath);
    const maxAxis = Math.max(...axisReports.map((r) => r.axis.length));
    for (const report of axisReports) {
      console.log(`  ${report.axis.padEnd(maxAxis)}  ${chalk.cyan(rel(join(reportDir, report.axis, 'index.md')))} (${report.files.length} files, ${report.shards.length} shards)`);
    }
  }
  console.log(`Details: ${chalk.cyan(rel(reviewsPath) + '/')}`);
  console.log('');
}

