// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

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
import { Semaphore } from '../core/sdk-semaphore.js';
import { isGitIgnored } from '../utils/git.js';
import { acquireLock, releaseLock, isLockActive } from '../utils/lock.js';
import type { Task } from '../schemas/task.js';
import type { Progress, FileProgress } from '../schemas/progress.js';
import { parseAxesOption, warnDisabledAxes } from '../utils/axes-filter.js';
import { createMiniRun } from '../utils/run-id.js';
import { createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch for file changes and incrementally re-scan and re-review')
    .option('--axes <list>', 'comma-separated list of axes to evaluate (e.g. correction,tests)')
    .action(async (cmdOpts: { axes?: string }) => {
      const projectRoot = resolve('.');

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before running this command.'));
        process.exitCode = 1;
        return;
      }

      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      // Parse --axes filter
      const axesFilter = parseAxesOption(cmdOpts.axes);
      if (axesFilter === null) return;

      const anatolyDir = resolve(projectRoot, '.anatoly');
      const tasksDir = resolve(anatolyDir, 'tasks');
      const progressPath = resolve(anatolyDir, 'cache', 'progress.json');

      mkdirSync(tasksDir, { recursive: true });
      mkdirSync(resolve(anatolyDir, 'cache'), { recursive: true });

      // Acquire lock to prevent conflicts with concurrent anatoly instances
      const lockPath = acquireLock(projectRoot);

      const { runId, runDir, logPath, conversationDir } = createMiniRun(projectRoot, 'watch');
      const runLog = createFileLogger(logPath);

      console.log(chalk.bold('anatoly — watch'));
      console.log(`  watching ${config.scan.include.join(', ')}`);
      console.log(`  press Ctrl+C to stop`);
      console.log('');

      // Warn once at startup if any requested axes are config-disabled
      const evaluators = getEnabledEvaluators(config, axesFilter ?? undefined);
      const sdkSemaphore = new Semaphore(config.llm.sdk_concurrency);
      // Raise max listeners to account for concurrent SDK subprocess exit handlers
      process.setMaxListeners(Math.max(process.getMaxListeners(), config.llm.sdk_concurrency + 10));
      if (axesFilter) {
        warnDisabledAxes(axesFilter, evaluators.map((e) => e.id));
      }

      // Initial scan on startup — index all matching files before watching
      runLog.info({
        event: 'watch_start', runId,
        patterns: config.scan.include, excludes: config.scan.exclude,
      }, 'watch started');

      const scanResult = await scanProject(projectRoot, config, evaluators.map(e => e.id));
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

        await runWithContext({ runId, file: relPath }, async () => {
        runLog.info({ event: 'file_change', file: relPath, type: 'change' }, 'file changed');

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

          runLog.info({ event: 'file_scan', file: relPath, hash, symbolCount: symbols.length }, 'file scanned');
          console.log(`  ${chalk.cyan('scanned')} ${relPath}`);

          // Auto-review
          progress.files[relPath].status = 'IN_PROGRESS';
          progress.files[relPath].updated_at = new Date().toISOString();
          atomicWriteJson(progressPath, progress);

          runLog.info({ event: 'file_review_start', file: relPath, axes: evaluators.map(e => e.id) }, 'file review started');
          const result = await evaluateFile({
            projectRoot,
            task,
            config,
            evaluators,
            abortController: new AbortController(),
            runDir,
            conversationDir,
            semaphore: sdkSemaphore,
          });
          writeReviewOutput(projectRoot, result.review, runDir);
          runLog.info({ event: 'file_review_end', file: relPath, verdict: result.review.verdict, durationMs: result.durationMs }, 'file review completed');
          flushFileLogger();

          progress.files[relPath].status = 'DONE';
          progress.files[relPath].updated_at = new Date().toISOString();
          atomicWriteJson(progressPath, progress);

          console.log(`  ${chalk.green('reviewed')} ${relPath} → ${result.review.verdict}`);

          // Regenerate report after each successful review
          regenerateReport();
        } catch (error) {
          const message = error instanceof AnatolyError ? error.message : String(error);
          const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
          runLog.info({ event: 'file_review_error', file: relPath, error: errorCode, message }, 'file review error');
          flushFileLogger();

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
        });
      };

      const handleUnlink = (filePath: string) => {
        const relPath = relative(projectRoot, resolve(projectRoot, filePath));
        runLog.info({ event: 'file_delete', file: relPath }, 'file deleted');

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
        runLog.info({ event: 'watch_stop', runId }, 'watch stopped');
        flushFileLogger();
        watcher.close();
        releaseLock(lockPath);
        process.exit(0);
      };
      process.on('SIGINT', onSigint);
    });
}
