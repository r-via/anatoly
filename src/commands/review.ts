import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { Listr } from 'listr2';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import { loadDependencyMeta } from '../core/dependency-meta.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { ReviewProgressDisplay, countReviewFindings } from './review-display.js';

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run agentic review on all pending files sequentially')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const plain = parentOpts.plain === true || !process.stdout.isTTY;

      const lockPath = acquireLock(projectRoot);
      let filesReviewed = 0;
      let filesErrored = 0;
      let totalFindings = 0;
      let interrupted = false;

      let activeAbort: AbortController | undefined;

      const onSigint = () => {
        if (interrupted) {
          releaseLock(lockPath);
          process.exit(1);
        }
        interrupted = true;
        activeAbort?.abort();
      };
      process.on('SIGINT', onSigint);

      try {
        // Auto-scan if no tasks exist
        const tasks = loadTasks(projectRoot);
        if (tasks.length === 0) {
          console.log('anatoly — scan (auto)');
          const scanResult = await scanProject(projectRoot, config);
          console.log(`  files     ${scanResult.filesScanned}`);
        }

        const pm = new ProgressManager(projectRoot);

        // Explicit review command always re-reviews all files (no cache)
        const progress = pm.getProgress();
        for (const [, fp] of Object.entries(progress.files)) {
          if (fp.status === 'DONE' || fp.status === 'CACHED') {
            pm.updateFileStatus(fp.file, 'PENDING');
          }
        }

        const pending = pm.getPendingFiles();

        if (pending.length === 0) {
          console.log('anatoly — review');
          console.log('  No pending files to review.');
          return;
        }

        const total = pending.length;
        const allTasks = loadTasks(projectRoot);
        const taskMap = new Map(allTasks.map((t) => [t.file, t]));
        const evaluators = getEnabledEvaluators(config);
        const depMeta = loadDependencyMeta(projectRoot);
        const display = new ReviewProgressDisplay(evaluators.map((e) => e.id));

        const runner = new Listr([{
          title: `review — 0/${total}`,
          task: async (_c: unknown, listrTask: { title: string; output: string }) => {
            let completedCount = 0;

            const updateTitle = () => {
              const findingsNote = totalFindings > 0 ? ` | ${totalFindings} findings` : '';
              listrTask.title = `review — ${completedCount}/${total}${findingsNote}`;
            };

            const spinInterval = setInterval(() => {
              if (display.hasActiveFiles) listrTask.output = display.render();
            }, 80);

            try {
            await runWorkerPool({
              items: pending,
              concurrency: 1,
              isInterrupted: () => interrupted,
              handler: async (fp) => {
                const task = taskMap.get(fp.file);
                if (!task) {
                  completedCount++;
                  updateTitle();
                  return;
                }

                pm.updateFileStatus(fp.file, 'IN_PROGRESS');
                display.trackFile(fp.file);

                activeAbort = new AbortController();

                try {
                  const result = await evaluateFile({
                    projectRoot,
                    task,
                    config,
                    evaluators,
                    abortController: activeAbort,
                    runDir: resolve(projectRoot, '.anatoly'),
                    depMeta,
                    deliberation: config.llm.deliberation,
                    onAxisComplete: (axisId) => {
                      display.markAxisDone(fp.file, axisId);
                    },
                  });
                  writeReviewOutput(projectRoot, result.review);
                  writeTranscript(projectRoot, fp.file, result.transcript);
                  pm.updateFileStatus(fp.file, 'DONE');
                  filesReviewed++;
                  totalFindings += countReviewFindings(result.review);
                  completedCount++;
                } catch (error) {
                  if (interrupted) return;

                  const message = error instanceof AnatolyError ? error.message : String(error);
                  const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';

                  pm.updateFileStatus(fp.file, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
                  filesErrored++;
                  completedCount++;
                } finally {
                  activeAbort = undefined;
                  display.untrackFile(fp.file);
                  updateTitle();
                }
              },
            });
            } finally {
              clearInterval(spinInterval);
            }

            const findingsNote = totalFindings > 0 ? ` | ${totalFindings} findings` : '';
            listrTask.title = `review — ${completedCount}/${total}${findingsNote}`;
          },
          rendererOptions: { outputBar: 1 as number },
        }], {
          renderer: plain ? 'simple' : 'default',
          fallbackRenderer: 'simple',
        });

        await runner.run();

        if (interrupted) {
          console.log(`interrupted — ${filesReviewed}/${total} files reviewed | ${totalFindings} findings`);
        } else {
          const reviewsDir = resolve(projectRoot, '.anatoly', 'reviews');
          const logsDir = resolve(projectRoot, '.anatoly', 'logs');
          console.log('');
          console.log(chalk.bold('review complete') + ` — ${filesReviewed} files | ${totalFindings} findings | ${filesReviewed - filesErrored} clean`);
          console.log('');
          console.log(`  reviews      ${chalk.cyan(reviewsDir)}`);
          console.log(`  transcripts  ${chalk.cyan(logsDir)}`);
        }
      } finally {
        process.removeListener('SIGINT', onSigint);
        releaseLock(lockPath);
      }
    });
}
