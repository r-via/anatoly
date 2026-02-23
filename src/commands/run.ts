import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, formatTokenCount, loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { generateReport } from '../core/reporter.js';
import { createRenderer } from '../utils/renderer.js';
import { toOutputName } from '../utils/cache.js';
import { AnatolyError } from '../utils/errors.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const isPlain = parentOpts.plain as boolean | undefined;

      const renderer = createRenderer({
        plain: isPlain,
        version: '0.1.0',
      });

      let lockPath: string | undefined;

      try {
        // Phase 1: SCAN
        const scanResult = await scanProject(projectRoot, config);
        console.log(`anatoly — scan`);
        console.log(`  files     ${scanResult.filesScanned}`);
        console.log('');

        // Phase 2: ESTIMATE
        const estimate = estimateProject(projectRoot);
        console.log('anatoly — estimate');
        console.log(`  files        ${estimate.files}`);
        console.log(`  symbols      ${estimate.symbols}`);
        console.log(`  est. tokens  ${formatTokenCount(estimate.inputTokens)} input / ${formatTokenCount(estimate.outputTokens)} output`);
        console.log(`  est. time    ~${estimate.estimatedMinutes} min (sequential)`);
        console.log('');

        // Phase 3: REVIEW
        lockPath = acquireLock(projectRoot);
        const pm = new ProgressManager(projectRoot);
        const pending = pm.getPendingFiles();

        if (pending.length === 0) {
          console.log('anatoly — review');
          console.log('  No pending files to review.');
          console.log('');
        } else {
          const total = pending.length;
          renderer.start(total);

          for (let i = 0; i < pending.length; i++) {
            const fileProgress = pending[i];
            const filePath = fileProgress.file;
            const allTasks = loadTasks(projectRoot);
            const task = allTasks.find((t) => t.file === filePath);

            if (!task) continue;

            renderer.updateProgress(i + 1, total, filePath);
            pm.updateFileStatus(filePath, 'IN_PROGRESS');

            try {
              const result = await reviewFile(projectRoot, task, config);
              writeReviewOutput(projectRoot, result.review);
              pm.updateFileStatus(filePath, 'DONE');

              // Count findings and update counters
              const outputName = toOutputName(filePath) + '.rev.md';
              let findingsSummary: string | undefined;

              for (const s of result.review.symbols) {
                if (s.utility === 'DEAD') renderer.incrementCounter('dead');
                if (s.duplication === 'DUPLICATE') renderer.incrementCounter('duplicate');
                if (s.overengineering === 'OVER') renderer.incrementCounter('overengineering');
                if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') renderer.incrementCounter('error');
              }

              // Build findings summary for result line
              const dead = result.review.symbols.filter((s) => s.utility === 'DEAD').length;
              const dup = result.review.symbols.filter((s) => s.duplication === 'DUPLICATE').length;
              if (dead > 0) findingsSummary = `DEAD:${dead}`;
              else if (dup > 0) findingsSummary = `DUP:${dup}`;

              renderer.addResult(outputName, result.review.verdict, findingsSummary);
            } catch (error) {
              const message = error instanceof AnatolyError ? error.message : String(error);
              const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
              pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
              renderer.incrementCounter('error');
            }
          }

          renderer.stop();
        }

        releaseLock(lockPath);
        lockPath = undefined;

        // Phase 4: REPORT
        const progressForReport = new ProgressManager(projectRoot);
        const errorFiles: string[] = [];
        const progress = progressForReport.getProgress();
        for (const [, fp] of Object.entries(progress.files)) {
          if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') {
            errorFiles.push(fp.file);
          }
        }

        const { reportPath, data } = generateReport(projectRoot, errorFiles);

        // Compute stats
        const totalFindings = data.findingFiles.length;
        const reviewed = data.totalFiles;
        const clean = data.cleanFiles.length;

        renderer.showCompletion(
          { reviewed, findings: totalFindings, clean },
          {
            report: reportPath,
            reviews: resolve(projectRoot, '.anatoly', 'reviews') + '/',
            logs: resolve(projectRoot, '.anatoly', 'logs') + '/',
          },
        );

        // Exit codes: 0 = clean, 1 = findings, 2 = error
        if (data.globalVerdict === 'CLEAN') {
          process.exitCode = 0;
        } else {
          process.exitCode = 1;
        }
      } catch (error) {
        renderer.stop();
        if (lockPath) {
          releaseLock(lockPath);
        }
        const message = error instanceof AnatolyError ? error.message : String(error);
        console.error(`anatoly — error: ${message}`);
        process.exitCode = 2;
      }
    });
}
