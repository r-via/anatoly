// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import chalk from 'chalk';
import { ProgressManager } from '../core/progress-manager.js';
import { loadReviews, computeGlobalVerdict } from '../core/reporter.js';
import { buildProgressBar, verdictColor } from '../utils/format.js';
import { listRuns, resolveRunDir } from '../utils/run-id.js';
import { listRunStatuses, readRunStatus, isProcessAlive, writeRunStatus, type RunStatus } from '../core/run-status.js';

/* ------------------------------------------------------------------ */
/*  Pure helpers — exported for testing                                */
/* ------------------------------------------------------------------ */

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "45s", "2m 15s", "1h 2m 3s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Build a text table summarising all run statuses.
 * Returns plain text (no chalk) suitable for testing.
 */
export function buildRunTable(statuses: RunStatus[]): string {
  if (statuses.length === 0) return '  No recent reviews found.';

  const lines: string[] = [];
  const header = '  RUN ID                     STATUS    DURATION   BRANCH        COMMIT';
  const sep    = '  ' + '─'.repeat(header.length - 2);
  lines.push(header);
  lines.push(sep);

  for (const s of statuses) {
    const duration = s.completedAt
      ? formatDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())
      : s.status === 'running'
        ? formatDuration(Date.now() - new Date(s.startedAt).getTime())
        : '—';
    const branch = s.branch ?? '—';
    const commit = s.commit ?? '—';

    lines.push(
      `  ${s.runId.padEnd(25)} ${s.status.padEnd(10)}${duration.padEnd(11)}${branch.padEnd(14)}${commit}`,
    );
  }

  return lines.join('\n');
}

/**
 * Build a detailed view for a single run.
 * Returns plain text suitable for testing.
 */
export function buildRunDetail(status: RunStatus, runDir: string): string {
  const lines: string[] = [];
  const duration = status.completedAt
    ? formatDuration(new Date(status.completedAt).getTime() - new Date(status.startedAt).getTime())
    : status.status === 'running'
      ? formatDuration(Date.now() - new Date(status.startedAt).getTime())
      : '—';

  lines.push(`  run         ${status.runId}`);
  lines.push(`  status      ${status.status}`);
  lines.push(`  pid         ${status.pid}`);
  lines.push(`  background  ${status.background}`);
  lines.push(`  started     ${status.startedAt}`);
  if (status.completedAt) lines.push(`  completed   ${status.completedAt}`);
  lines.push(`  duration    ${duration}`);
  if (status.branch) lines.push(`  branch      ${status.branch}`);
  if (status.commit) lines.push(`  commit      ${status.commit}`);
  if (status.error) lines.push(`  error       ${status.error}`);

  // Report path hint
  const reportPath = resolve(runDir, 'report.md');
  if (existsSync(reportPath)) {
    lines.push(`  report      ${reportPath}`);
  } else {
    lines.push(`  report      (not yet generated)`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  CLI registration                                                  */
/* ------------------------------------------------------------------ */

/** Registers the `status` CLI sub-command on the given Commander program. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status [runId]')
    .description('Show current audit progress, background runs, and findings summary')
    .action((runId?: string) => {
      const projectRoot = process.cwd();

      // --- Detailed view for a specific run ---
      if (runId) {
        const runDir = resolveRunDir(projectRoot, runId);
        if (!runDir) {
          console.log(chalk.bold('anatoly — status'));
          console.log(`  Run "${runId}" not found.`);
          return;
        }
        const status = readRunStatus(runDir);
        if (!status) {
          console.log(chalk.bold('anatoly — status'));
          console.log(`  No status information for run "${runId}".`);
          return;
        }

        // Detect crashed process
        if (status.status === 'running' && !isProcessAlive(status.pid)) {
          status.status = 'crashed';
          status.completedAt = new Date().toISOString();
          writeRunStatus(runDir, status);
          console.log(chalk.yellow(`  warning: run "${runId}" PID ${status.pid} is no longer alive — marked as crashed`));
        }

        console.log(chalk.bold('anatoly — status'));
        console.log('');
        console.log(buildRunDetail(status, runDir));
        return;
      }

      // --- Overview: background runs section ---
      const allStatuses = listRunStatuses(projectRoot);

      // Detect crashed runs and auto-correct
      for (const s of allStatuses) {
        if (s.status === 'running' && !isProcessAlive(s.pid)) {
          s.status = 'crashed';
          s.completedAt = new Date().toISOString();
          const dir = resolveRunDir(projectRoot, s.runId);
          if (dir) writeRunStatus(dir, s);
        }
      }

      // If there are background runs, show them first
      if (allStatuses.length > 0) {
        console.log(chalk.bold('anatoly — status'));
        console.log('');
        console.log(chalk.bold('  Runs'));
        console.log(buildRunTable(allStatuses));
        console.log('');
      }

      // --- Existing audit progress section ---
      const progressPath = resolve(projectRoot, '.anatoly', 'progress.json');

      if (!existsSync(progressPath) && allStatuses.length === 0) {
        console.log(chalk.bold('anatoly — status'));
        console.log('  No audit in progress. Run `anatoly scan` or `anatoly run` first.');
        return;
      }

      if (!existsSync(progressPath)) {
        // We already printed the runs table above, nothing more to add
        return;
      }

      if (allStatuses.length === 0) {
        console.log(chalk.bold('anatoly — status'));
        console.log('');
      }

      const pm = new ProgressManager(projectRoot);
      const summary = pm.getSummary();
      const total = pm.totalFiles();
      const completed = summary.DONE + summary.CACHED;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      // Visual progress bar
      const bar = buildProgressBar(completed, total, 30);
      console.log(`  progress    ${bar} ${pct}% (${completed}/${total})`);
      console.log('');

      console.log(`  total       ${total}`);
      console.log(`  pending     ${summary.PENDING}`);
      if (summary.IN_PROGRESS > 0) console.log(`  in_progress ${summary.IN_PROGRESS}`);
      console.log(`  done        ${summary.DONE}`);
      console.log(`  cached      ${summary.CACHED}`);
      if (summary.ERROR > 0) console.log(`  error       ${chalk.red(String(summary.ERROR))}`);
      if (summary.TIMEOUT > 0) console.log(`  timeout     ${chalk.yellow(String(summary.TIMEOUT))}`);
      console.log('');

      // Load reviews for findings summary — try run-scoped first, then legacy
      const latestRunDir = resolveRunDir(projectRoot);
      const reviews = latestRunDir
        ? loadReviews(projectRoot, latestRunDir)
        : loadReviews(projectRoot);

      if (reviews.length > 0) {
        const globalVerdict = computeGlobalVerdict(reviews);
        let deadCount = 0;
        let dupCount = 0;
        let overCount = 0;
        let errCount = 0;

        for (const review of reviews) {
          for (const s of review.symbols) {
            if (s.utility === 'DEAD') deadCount++;
            if (s.duplication === 'DUPLICATE') dupCount++;
            if (s.overengineering === 'OVER') overCount++;
            if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') errCount++;
          }
        }

        const totalFindings = deadCount + dupCount + overCount + errCount;
        console.log(`  verdict     ${verdictColor(globalVerdict)}`);
        console.log(`  findings    ${totalFindings}`);
        if (deadCount > 0) console.log(`    dead      ${deadCount}`);
        if (dupCount > 0) console.log(`    dup       ${dupCount}`);
        if (overCount > 0) console.log(`    over      ${overCount}`);
        if (errCount > 0) console.log(`    errors    ${errCount}`);
        console.log('');
      }

      // Show latest run info
      const runs = listRuns(projectRoot);
      if (runs.length > 0) {
        const latest = runs[runs.length - 1];
        console.log(`  latest run  ${chalk.dim(latest)}`);
      }

      // Show report/reviews paths
      const rel = (p: string) => relative(process.cwd(), p) || '.';
      if (latestRunDir) {
        const reportInRun = resolve(latestRunDir, 'report.md');
        if (existsSync(reportInRun)) {
          console.log(`  report      ${chalk.cyan(rel(reportInRun))}`);
        }
        console.log(`  reviews     ${chalk.cyan(rel(resolve(latestRunDir, 'reviews')) + '/')}`);
      } else {
        const reportPath = resolve(projectRoot, '.anatoly', 'report.md');
        if (existsSync(reportPath)) {
          console.log(`  report      ${chalk.cyan(rel(reportPath))}`);
        }
        console.log(`  reviews     ${chalk.cyan(rel(resolve(projectRoot, '.anatoly', 'reviews')) + '/')}`);
      }
    });
}
