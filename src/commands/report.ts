import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { generateReport } from '../core/reporter.js';
import { ProgressManager } from '../core/progress-manager.js';
import { resolveRunDir } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { verdictColor } from '../utils/format.js';
import { isLockActive } from '../utils/lock.js';

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Aggregate review results into a structured Markdown report')
    .option('--run <id>', 'generate report from a specific run (default: latest)')
    .action((cmdOpts: { run?: string }) => {
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

      if (runDir && existsSync(resolve(runDir, 'reviews'))) {
        // Run-scoped mode: read reviews from run directory
        const { reportPath, data, shards } = generateReport(projectRoot, errorFiles, runDir);
        printReportSummary(data, shards, reportPath, resolve(runDir, 'reviews'));
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

        const { reportPath, data, shards } = generateReport(projectRoot, errorFiles);
        printReportSummary(data, shards, reportPath, resolve(projectRoot, '.anatoly', 'reviews'));
        if (shouldOpen) openFile(reportPath);
      }
    });
}

function printReportSummary(
  data: ReturnType<typeof generateReport>['data'],
  shards: ReturnType<typeof generateReport>['shards'],
  reportPath: string,
  reviewsPath: string,
): void {
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
  if (totalDead > 0) console.log(`  Utility:           ${totalDead}  (high: ${dc.high}, medium: ${dc.medium}, low: ${dc.low})`);
  if (totalDup > 0) console.log(`  Duplicates:        ${totalDup}  (high: ${dup.high}, medium: ${dup.medium}, low: ${dup.low})`);
  if (totalOver > 0) console.log(`  Over-engineering:  ${totalOver}  (high: ${ov.high}, medium: ${ov.medium}, low: ${ov.low})`);

  // Tests summary (only count reliable symbols, consistent with other axes)
  const allSymbols = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));
  const testsNone = allSymbols.filter((s) => s.tests === 'NONE').length;
  const testsWeak = allSymbols.filter((s) => s.tests === 'WEAK').length;
  if (testsNone + testsWeak > 0) console.log(`  Tests:             ${testsNone + testsWeak}  (${testsNone} untested, ${testsWeak} weak)`);

  // Best practices summary
  const bpFails = data.reviews.reduce((sum, r) => sum + (r.best_practices?.rules.filter((rule) => rule.status === 'FAIL').length ?? 0), 0);
  const bpWarns = data.reviews.reduce((sum, r) => sum + (r.best_practices?.rules.filter((rule) => rule.status === 'WARN').length ?? 0), 0);
  if (bpFails + bpWarns > 0) console.log(`  Best practices:    ${bpFails + bpWarns}  (${bpFails} fail, ${bpWarns} warn)`);

  console.log(`  Findings:          ${data.findingFiles.length} files`);
  console.log(`  Clean:             ${data.cleanFiles.length}`);
  if (data.errorFiles.length > 0) {
    console.log(`  Errors:            ${data.errorFiles.length}`);
  }
  console.log('');
  const rel = (p: string) => relative(process.cwd(), p) || '.';
  console.log(`Report: ${chalk.cyan(rel(reportPath))}`);
  if (shards.length > 0) {
    const reportDir = dirname(reportPath);
    for (const shard of shards) {
      console.log(`  shard ${shard.index}  ${chalk.cyan(rel(join(reportDir, `report.${shard.index}.md`)))} (${shard.files.length} files)`);
    }
  }
  console.log(`Details: ${chalk.cyan(rel(reviewsPath) + '/')}`);
}
