import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { Listr } from 'listr2';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';
import { toOutputName } from '../utils/cache.js';
import { verdictColor } from '../utils/format.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';

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
        const pending = pm.getPendingFiles();

        if (pending.length === 0) {
          console.log('anatoly — review');
          console.log('  No pending files to review.');
          return;
        }

        const total = pending.length;
        const allTasks = loadTasks(projectRoot);
        const taskMap = new Map(allTasks.map((t) => [t.file, t]));

        // Build listr2 task list — one task per file, sequential
        const listrTasks = pending.map((fp, idx) => ({
          title: `[${idx + 1}/${total}] ${fp.file}`,
          task: async (_ctx: unknown, listrTask: { title: string; output: string }) => {
            if (interrupted) {
              listrTask.title = `[${idx + 1}/${total}] ${fp.file} — skipped`;
              return;
            }

            const task = taskMap.get(fp.file);
            if (!task) {
              listrTask.title = `[${idx + 1}/${total}] ${fp.file} — skipped (no task)`;
              return;
            }

            pm.updateFileStatus(fp.file, 'IN_PROGRESS');
            activeAbort = new AbortController();
            const evaluators = getEnabledEvaluators(config);

            try {
              const result = await evaluateFile({
                projectRoot,
                task,
                config,
                evaluators,
                abortController: activeAbort,
                runDir: resolve(projectRoot, '.anatoly'),
              });
              writeReviewOutput(projectRoot, result.review);
              pm.updateFileStatus(fp.file, 'DONE');
              filesReviewed++;

              // Count findings
              for (const s of result.review.symbols) {
                if (s.utility === 'DEAD') totalFindings++;
                if (s.duplication === 'DUPLICATE') totalFindings++;
                if (s.overengineering === 'OVER') totalFindings++;
                if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') totalFindings++;
              }

              const outputName = toOutputName(fp.file);
              listrTask.title = `[${idx + 1}/${total}] ${outputName} — ${verdictColor(result.review.verdict)}`;
            } catch (error) {
              if (interrupted) return;

              const message = error instanceof AnatolyError ? error.message : String(error);
              const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';

              pm.updateFileStatus(fp.file, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
              filesErrored++;

              const label = errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error';
              listrTask.title = `[${idx + 1}/${total}] ${fp.file} — ${chalk.red(label)}`;
              throw error;
            } finally {
              activeAbort = undefined;
            }
          },
          rendererOptions: { persistentOutput: true as const },
        }));

        const runner = new Listr(listrTasks, {
          concurrent: false,
          exitOnError: false,
          renderer: plain ? 'simple' : 'default',
          fallbackRenderer: 'simple',
          rendererOptions: {
            collapseSubtasks: false,
            collapseErrors: false,
            showErrorMessage: false,
          },
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
