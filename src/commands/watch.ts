import type { Command } from 'commander';
import { resolve, relative } from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { watch } from 'chokidar';
import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { parseFile } from '../core/scanner.js';
import { computeFileHash, toOutputName, atomicWriteJson, readProgress } from '../utils/cache.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';
import type { Task } from '../schemas/task.js';
import type { Progress, FileProgress } from '../schemas/progress.js';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch for file changes and incrementally re-scan and re-review')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const anatolyDir = resolve(projectRoot, '.anatoly');
      const tasksDir = resolve(anatolyDir, 'tasks');
      const progressPath = resolve(anatolyDir, 'cache', 'progress.json');

      mkdirSync(tasksDir, { recursive: true });
      mkdirSync(resolve(anatolyDir, 'cache'), { recursive: true });

      console.log(chalk.bold('anatoly — watch'));
      console.log(`  watching ${config.scan.include.join(', ')}`);
      console.log(`  press Ctrl+C to stop`);
      console.log('');

      let processing = false;
      const queue: string[] = [];

      const watcher = watch(config.scan.include, {
        cwd: projectRoot,
        ignored: config.scan.exclude,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });

      const processFile = async (relPath: string) => {
        const absPath = resolve(projectRoot, relPath);
        if (!existsSync(absPath)) return; // File deleted

        try {
          // Re-scan: hash + parse AST
          const hash = computeFileHash(absPath);
          const source = readFileSync(absPath, 'utf-8');
          const symbols = await parseFile(relPath, source);

          const task: Task = {
            version: 1,
            file: relPath,
            hash,
            symbols,
            scanned_at: new Date().toISOString(),
          };

          // Write task file
          const taskFileName = `${toOutputName(relPath)}.task.json`;
          atomicWriteJson(resolve(tasksDir, taskFileName), task);

          // Update progress to PENDING
          const progress: Progress = readProgress(progressPath) ?? {
            version: 1,
            started_at: new Date().toISOString(),
            files: {},
          };

          progress.files[relPath] = {
            file: relPath,
            hash,
            status: 'PENDING',
            updated_at: new Date().toISOString(),
          } satisfies FileProgress;

          atomicWriteJson(progressPath, progress);

          console.log(`  ${chalk.cyan('scanned')} ${relPath}`);

          // Auto-review
          progress.files[relPath].status = 'IN_PROGRESS';
          progress.files[relPath].updated_at = new Date().toISOString();
          atomicWriteJson(progressPath, progress);

          const result = await reviewFile(projectRoot, task, config);
          writeReviewOutput(projectRoot, result.review);

          progress.files[relPath].status = 'DONE';
          progress.files[relPath].updated_at = new Date().toISOString();
          atomicWriteJson(progressPath, progress);

          const retryNote = result.retries > 0 ? ` (${result.retries} retries)` : '';
          console.log(`  ${chalk.green('reviewed')} ${relPath} → ${result.review.verdict}${retryNote}`);
        } catch (error) {
          const message = error instanceof AnatolyError ? error.message : String(error);

          // Update progress to ERROR
          const progress: Progress = readProgress(progressPath) ?? {
            version: 1,
            started_at: new Date().toISOString(),
            files: {},
          };
          progress.files[relPath] = {
            file: relPath,
            hash: '',
            status: 'ERROR',
            updated_at: new Date().toISOString(),
            error: message,
          };
          atomicWriteJson(progressPath, progress);

          console.log(`  ${chalk.red('error')} ${relPath}: ${message}`);
        }
      };

      const processQueue = async () => {
        if (processing) return;
        processing = true;

        while (queue.length > 0) {
          const filePath = queue.shift()!;
          await processFile(filePath);
        }

        processing = false;
      };

      const onFileChange = (filePath: string) => {
        // Normalize to relative path
        const relPath = relative(projectRoot, resolve(projectRoot, filePath));

        // Deduplicate: don't add if already queued
        if (!queue.includes(relPath)) {
          queue.push(relPath);
        }

        processQueue();
      };

      watcher.on('change', onFileChange);
      watcher.on('add', onFileChange);

      // Graceful shutdown
      const onSigint = () => {
        console.log('');
        console.log(chalk.bold('anatoly — watch stopped'));
        watcher.close();
        process.exit(0);
      };
      process.on('SIGINT', onSigint);
    });
}
