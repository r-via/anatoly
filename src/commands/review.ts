import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';
import { createRenderer } from '../utils/renderer.js';
import { toOutputName } from '../utils/cache.js';

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run agentic review on all pending files sequentially')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const plain = parentOpts.plain === true || !process.stdout.isTTY;
      const renderer = createRenderer({ plain, concurrency: 1 });

      // Acquire lock to prevent concurrent instances
      const lockPath = acquireLock(projectRoot);
      let filesReviewed = 0;
      let filesErrored = 0;
      let totalFindings = 0;
      let interrupted = false;

      // Track active AbortController for the current review
      let activeAbort: AbortController | undefined;

      // SIGINT handler: first Ctrl+C → graceful shutdown + abort, second → force exit
      const onSigint = () => {
        if (interrupted) {
          renderer.stop();
          releaseLock(lockPath);
          process.exit(1);
        }
        interrupted = true;
        activeAbort?.abort();
        renderer.log(`${chalk.yellow.bold('⚠ shutting down…')} press Ctrl+C again to force exit`);
      };
      process.on('SIGINT', onSigint);

      try {
        // Auto-scan if no tasks exist
        const tasks = loadTasks(projectRoot);
        if (tasks.length === 0) {
          renderer.log('anatoly — scan (auto)');
          const scanResult = await scanProject(projectRoot, config);
          renderer.log(`  files     ${scanResult.filesScanned}`);
        }

        const pm = new ProgressManager(projectRoot);
        const pending = pm.getPendingFiles();

        if (pending.length === 0) {
          renderer.log('anatoly — review');
          renderer.log('  No pending files to review.');
          return;
        }

        const total = pending.length;
        renderer.start(total);

        for (let i = 0; i < pending.length; i++) {
          if (interrupted) break;

          const filePath = pending[i].file;
          renderer.updateProgress(i, total, `reviewing ${filePath}`);

          // Find the matching task
          const allTasks = loadTasks(projectRoot);
          const task = allTasks.find((t) => t.file === filePath);

          if (!task) {
            renderer.log(`  [skip] no task found for ${filePath}`);
            continue;
          }

          pm.updateFileStatus(filePath, 'IN_PROGRESS');
          activeAbort = new AbortController();

          try {
            const result = await reviewFile(projectRoot, task, config, {}, activeAbort);
            writeReviewOutput(projectRoot, result.review);

            pm.updateFileStatus(filePath, 'DONE');
            filesReviewed++;

            // Count findings
            for (const s of result.review.symbols) {
              if (s.utility === 'DEAD') { renderer.incrementCounter('dead'); totalFindings++; }
              if (s.duplication === 'DUPLICATE') { renderer.incrementCounter('duplicate'); totalFindings++; }
              if (s.overengineering === 'OVER') { renderer.incrementCounter('overengineering'); totalFindings++; }
              if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') { renderer.incrementCounter('error'); totalFindings++; }
            }

            const outputName = toOutputName(filePath);
            renderer.addResult(outputName, result.review.verdict);
            renderer.updateProgress(i + 1, total, `reviewing ${filePath}`);
          } catch (error) {
            // If interrupted, don't count as error — just stop
            if (interrupted) break;

            const message = error instanceof AnatolyError ? error.message : String(error);
            const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';

            pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
            filesErrored++;
            renderer.updateProgress(i + 1, total, `reviewing ${filePath}`);
            renderer.incrementCounter('error');

            if (error instanceof AnatolyError) {
              renderer.log(`  [${errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error'}] ${error.formatForDisplay()}`);
            } else {
              renderer.log(`  [error] error: ${String(error)}`);
            }
          } finally {
            activeAbort = undefined;
          }
        }

        renderer.stop();

        if (interrupted) {
          renderer.log(`interrupted — ${filesReviewed}/${total} files reviewed | ${totalFindings} findings`);
        } else {
          const reviewsDir = resolve(projectRoot, '.anatoly', 'reviews');
          const logsDir = resolve(projectRoot, '.anatoly', 'logs');
          renderer.showCompletion(
            { reviewed: filesReviewed, findings: totalFindings, clean: filesReviewed - filesErrored },
            { report: '', reviews: reviewsDir, logs: logsDir },
          );
        }
      } finally {
        process.removeListener('SIGINT', onSigint);
        releaseLock(lockPath);
      }
    });
}
