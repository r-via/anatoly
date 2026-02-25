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
        const axisIds = evaluators.map((e) => e.id);

        // Track active files for compact display (only in-flight files visible)
        const activeFiles = new Map<string, { axes: Set<string> }>();

        const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
        let spinFrame = 0;

        const AXIS_LABELS: Record<string, string> = {
          utility: 'utility',
          duplication: 'duplication',
          overengineering: 'overengineering',
          tests: 'tests',
          correction: 'correction',
          best_practices: 'best practices',
        };

        function formatAxes(done: Set<string>): string {
          const frame = SPINNER[spinFrame % SPINNER.length];
          return axisIds.map((id) => {
            const label = AXIS_LABELS[id] ?? id;
            return done.has(id) ? `${chalk.green('[x]')} ${label}` : `[${chalk.yellow(frame)}] ${label}`;
          }).join(' ');
        }

        function emitActiveFiles(listrTask: { output: string }): void {
          spinFrame++;
          const marker = chalk.yellow('\u25cf');
          const files = [...activeFiles.entries()];
          const maxLen = files.length > 0 ? Math.max(...files.map(([f]) => f.length)) : 0;
          const lines: string[] = [];
          for (const [file, state] of files) {
            const padded = file.padEnd(maxLen);
            lines.push(`${marker} ${padded}  ${formatAxes(state.axes)}`);
          }
          listrTask.output = lines.join('\n');
        }

        const runner = new Listr([{
          title: `review — 0/${total}`,
          task: async (_c: unknown, listrTask: { title: string; output: string }) => {
            let completedCount = 0;

            const updateTitle = () => {
              const findingsNote = totalFindings > 0 ? ` | ${totalFindings} findings` : '';
              listrTask.title = `review — ${completedCount}/${total}${findingsNote}`;
            };

            const spinInterval = setInterval(() => {
              if (activeFiles.size > 0) emitActiveFiles(listrTask);
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
                activeFiles.set(fp.file, { axes: new Set() });

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
                    onAxisComplete: (axisId) => {
                      const state = activeFiles.get(fp.file);
                      if (state) state.axes.add(axisId);
                    },
                  });
                  writeReviewOutput(projectRoot, result.review);
                  writeTranscript(projectRoot, fp.file, result.transcript);
                  pm.updateFileStatus(fp.file, 'DONE');
                  filesReviewed++;

                  // Count findings
                  for (const s of result.review.symbols) {
                    if (s.utility === 'DEAD') totalFindings++;
                    if (s.duplication === 'DUPLICATE') totalFindings++;
                    if (s.overengineering === 'OVER') totalFindings++;
                    if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') totalFindings++;
                  }

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
                  activeFiles.delete(fp.file);
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
