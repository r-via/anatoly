import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateReport } from '../core/reporter.js';
import { ProgressManager } from '../core/progress-manager.js';

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Aggregate review results into a structured Markdown report')
    .action(() => {
      const projectRoot = process.cwd();

      const progressPath = resolve(projectRoot, '.anatoly', 'progress.json');
      const errorFiles: string[] = [];
      if (existsSync(progressPath)) {
        const pm = new ProgressManager(projectRoot);
        const summary = pm.getSummary();
        const progress = pm.getProgress();
        for (const [, fp] of Object.entries(progress.files)) {
          if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') {
            errorFiles.push(fp.file);
          }
        }
        if (summary.DONE === 0 && summary.CACHED === 0) {
          console.log(chalk.yellow('No completed reviews found. Run `anatoly review` first.'));
          return;
        }
      }

      const { reportPath, data } = generateReport(projectRoot, errorFiles);

      console.log(chalk.bold(`\nAnatoly Report — ${data.totalFiles} files reviewed`));
      console.log(`Verdict: ${verdictColor(data.globalVerdict)}`);
      console.log('');

      const dc = data.counts.dead;
      const dup = data.counts.duplicate;
      const ov = data.counts.overengineering;
      const cor = data.counts.correction;
      const totalDead = dc.high + dc.medium + dc.low;
      const totalDup = dup.high + dup.medium + dup.low;
      const totalOver = ov.high + ov.medium + ov.low;
      const totalCorr = cor.high + cor.medium + cor.low;

      if (totalCorr > 0) console.log(`  Correction errors: ${totalCorr}  (high: ${cor.high}, medium: ${cor.medium}, low: ${cor.low})`);
      if (totalDead > 0) console.log(`  Dead code:         ${totalDead}  (high: ${dc.high}, medium: ${dc.medium}, low: ${dc.low})`);
      if (totalDup > 0) console.log(`  Duplicates:        ${totalDup}  (high: ${dup.high}, medium: ${dup.medium}, low: ${dup.low})`);
      if (totalOver > 0) console.log(`  Over-engineering:  ${totalOver}  (high: ${ov.high}, medium: ${ov.medium}, low: ${ov.low})`);
      console.log(`  Clean:             ${data.cleanFiles.length}`);
      if (data.errorFiles.length > 0) {
        console.log(`  Errors:            ${data.errorFiles.length}`);
      }
      console.log('');
      console.log(`Report: ${chalk.cyan(reportPath)}`);
      console.log(`Details: ${chalk.cyan(resolve(projectRoot, '.anatoly', 'reviews') + '/')}`);
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
