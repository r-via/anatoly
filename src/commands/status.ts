import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ProgressManager } from '../core/progress-manager.js';
import { loadReviews, computeGlobalVerdict } from '../core/reporter.js';
import { buildProgressBar, verdictColor } from '../utils/renderer.js';
import { listRuns, resolveRunDir } from '../utils/run-id.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current audit progress and findings summary')
    .action(() => {
      const projectRoot = process.cwd();
      const progressPath = resolve(projectRoot, '.anatoly', 'progress.json');

      if (!existsSync(progressPath)) {
        console.log('anatoly — status');
        console.log('  No audit in progress. Run `anatoly scan` or `anatoly run` first.');
        return;
      }

      const pm = new ProgressManager(projectRoot);
      const summary = pm.getSummary();
      const total = pm.totalFiles();
      const completed = summary.DONE + summary.CACHED;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      console.log(chalk.bold('anatoly — status'));
      console.log('');

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
      if (latestRunDir) {
        const reportInRun = resolve(latestRunDir, 'report.md');
        if (existsSync(reportInRun)) {
          console.log(`  report      ${chalk.cyan(reportInRun)}`);
        }
        console.log(`  reviews     ${chalk.cyan(resolve(latestRunDir, 'reviews') + '/')}`);
      } else {
        const reportPath = resolve(projectRoot, '.anatoly', 'report.md');
        if (existsSync(reportPath)) {
          console.log(`  report      ${chalk.cyan(reportPath)}`);
        }
        console.log(`  reviews     ${chalk.cyan(resolve(projectRoot, '.anatoly', 'reviews') + '/')}`);
      }
    });
}
