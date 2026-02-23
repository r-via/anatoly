import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ProgressManager } from '../core/progress-manager.js';
import { loadReviews, computeGlobalVerdict } from '../core/reporter.js';

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

      console.log(chalk.bold('anatoly — status'));
      console.log('');
      console.log(`  total       ${total}`);
      console.log(`  pending     ${summary.PENDING}`);
      console.log(`  in_progress ${summary.IN_PROGRESS}`);
      console.log(`  done        ${summary.DONE}`);
      console.log(`  cached      ${summary.CACHED}`);
      console.log(`  error       ${summary.ERROR}`);
      console.log(`  timeout     ${summary.TIMEOUT}`);
      console.log('');

      // Load reviews for findings summary
      const reviews = loadReviews(projectRoot);
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

      const reportPath = resolve(projectRoot, '.anatoly', 'report.md');
      if (existsSync(reportPath)) {
        console.log(`  report      ${chalk.cyan(reportPath)}`);
      }
      console.log(`  reviews     ${chalk.cyan(resolve(projectRoot, '.anatoly', 'reviews') + '/')}`);
    });
}

function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'CLEAN':
      return chalk.green(verdict);
    case 'NEEDS_REFACTOR':
      return chalk.yellow(verdict);
    case 'CRITICAL':
      return chalk.red(verdict);
    default:
      return verdict;
  }
}
