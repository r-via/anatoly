import type { Command } from 'commander';
import { resolve, relative } from 'node:path';
import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { watch } from 'chokidar';
import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject, parseFile } from '../core/scanner.js';
import { computeFileHash, toOutputName, atomicWriteJson, readProgress } from '../utils/cache.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { generateReport } from '../core/reporter.js';
import { AnatolyError } from '../utils/errors.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import { isGitIgnored } from '../utils/git.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
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

      // Acquire lock to prevent conflicts with concurrent anatoly instances
      const lockPath = acquireLock(projectRoot);

      console.log(chalk.bold('anatoly — watch'));
      console.log(`  watching ${config.scan.include.join(', ')}`);
      console.log(`  press Ctrl+C to stop`);
      console.log('');

      // Initial scan on startup — index all matching files before watching
      const scanResult = await scanProject(projectRoot, config);
      console.log(`  ${chalk.cyan('initial scan')} ${scanResult.filesScanned} files (${scanResult.filesNew} new, ${scanResult.filesCached} cached)`);
      console.log('');

      let processing = false;
      const queue: string[] = [];

      const regenerateReport = () => {
        try {
          const errorFiles: string[] = [];
          const progress = readProgress(progressPath);
          if (progress) {
            for (const [, fp] of Object.entries(progress.files)) {
              if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') {
                errorFiles.push(fp.file);
              }
            }
          }
          generateReport(projectRoot, errorFiles);
        } catch {
          // Report generation is best-effort in watch mode
        }
      };

      const watcher = watch(config.scan.include, {
        cwd: projectRoot,
        ignored: config.scan.exclude,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });

      const processFile = async (relPath: string) => {
        const absPath = resolve(projectRoot, relPath);
        if (!existsSync(absPath)) return; // File deleted — handled by unlink

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

          const evaluators = getEnabledEvaluators(config);
          const result = await evaluateFile({
            projectRoot,
            task,
            config,
            evaluators,
            abortController: new AbortController(),
            runDir: resolve(projectRoot, '.anatoly'),
          });
          writeReviewOutput(projectRoot, result.review);

          progress.files[relPath].status = 'DONE';
          progress.files[relPath].updated_at = new Date().toISOString();
          atomicWriteJson(progressPath, progress);

          console.log(`  ${chalk.green('reviewed')} ${relPath} → ${result.review.verdict}`);

          // Regenerate report after each successful review
          regenerateReport();
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

          if (error instanceof AnatolyError) {
            console.log(`  ${chalk.red('error')} ${relPath}: ${error.formatForDisplay()}`);
          } else {
            console.log(`  ${chalk.red('error')} ${relPath}: ${message}`);
          }
        }
      };

      const handleUnlink = (filePath: string) => {
        const relPath = relative(projectRoot, resolve(projectRoot, filePath));

        // Remove task file
        const taskFileName = `${toOutputName(relPath)}.task.json`;
        const taskPath = resolve(tasksDir, taskFileName);
        try {
          if (existsSync(taskPath)) unlinkSync(taskPath);
        } catch {
          // Already gone
        }

        // Remove review file
        const reviewPath = resolve(anatolyDir, 'reviews', `${toOutputName(relPath)}.rev.json`);
        try {
          if (existsSync(reviewPath)) unlinkSync(reviewPath);
        } catch {
          // Already gone
        }

        // Update progress: remove the file entry
        const progress = readProgress(progressPath);
        if (progress && progress.files[relPath]) {
          delete progress.files[relPath];
          atomicWriteJson(progressPath, progress);
        }

        console.log(`  ${chalk.yellow('deleted')} ${relPath}`);

        // Regenerate report to reflect deletion
        regenerateReport();
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

        // Skip files ignored by .gitignore
        if (isGitIgnored(projectRoot, relPath)) return;

        // Deduplicate: don't add if already queued
        if (!queue.includes(relPath)) {
          queue.push(relPath);
        }

        processQueue();
      };

      watcher.on('change', onFileChange);
      watcher.on('add', onFileChange);
      watcher.on('unlink', handleUnlink);

      // Graceful shutdown — release lock
      const onSigint = () => {
        console.log('');
        console.log(`${chalk.yellow.bold('shutting down')} closing watcher`);
        watcher.close();
        releaseLock(lockPath);
        process.exit(0);
      };
      process.on('SIGINT', onSigint);
    });
}
