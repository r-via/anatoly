import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run agentic review on all pending files sequentially')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      // Acquire lock to prevent concurrent instances
      const lockPath = acquireLock(projectRoot);
      let filesReviewed = 0;
      let filesErrored = 0;
      let interrupted = false;

      // SIGINT handler for graceful shutdown
      const onSigint = () => {
        interrupted = true;
      };
      process.on('SIGINT', onSigint);

      try {
        // Auto-scan if no tasks exist
        const tasks = loadTasks(projectRoot);
        if (tasks.length === 0) {
          console.log('anatoly — scan (auto)');
          const scanResult = await scanProject(projectRoot, config);
          console.log(`  files     ${scanResult.filesScanned}`);
          console.log('');
        }

        const pm = new ProgressManager(projectRoot);
        const pending = pm.getPendingFiles();

        if (pending.length === 0) {
          console.log('anatoly — review');
          console.log('  No pending files to review.');
          return;
        }

        const total = pending.length;
        console.log('anatoly — review');
        console.log(`  pending   ${total}`);
        console.log(`  total     ${pm.totalFiles()}`);
        console.log('');

        for (const fileProgress of pending) {
          if (interrupted) break;

          const filePath = fileProgress.file;
          console.log(`  reviewing ${filePath}...`);

          // Find the matching task
          const allTasks = loadTasks(projectRoot);
          const task = allTasks.find((t) => t.file === filePath);

          if (!task) {
            console.log(`  [skip] no task found for ${filePath}`);
            continue;
          }

          pm.updateFileStatus(filePath, 'IN_PROGRESS');

          try {
            const result = await reviewFile(projectRoot, task, config);
            const { jsonPath, mdPath } = writeReviewOutput(projectRoot, result.review);

            pm.updateFileStatus(filePath, 'DONE');
            filesReviewed++;

            const retryNote = result.retries > 0 ? ` (${result.retries} retries)` : '';
            console.log(`  [done] ${filePath} → ${result.review.verdict}${retryNote}`);
            console.log(`         ${jsonPath}`);
            console.log(`         ${mdPath}`);
          } catch (error) {
            const message = error instanceof AnatolyError ? error.message : String(error);
            const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';

            pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
            filesErrored++;

            console.log(`  [${errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error'}] ${filePath}: ${message}`);
          }
        }

        if (interrupted) {
          console.log('');
          console.log(`interrupted — ${filesReviewed}/${total} files reviewed`);
        } else {
          console.log('');
          console.log('anatoly — review complete');
          console.log(`  reviewed  ${filesReviewed}`);
          console.log(`  errors    ${filesErrored}`);

          const summary = pm.getSummary();
          console.log(`  done      ${summary.DONE}`);
          console.log(`  cached    ${summary.CACHED}`);
        }
      } finally {
        process.removeListener('SIGINT', onSigint);
        releaseLock(lockPath);
      }
    });
}
