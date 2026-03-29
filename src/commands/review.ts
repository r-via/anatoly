// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve, relative } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { acquireLock, releaseLock, isLockActive } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript } from '../core/review-writer.js';
import { AnatolyError } from '../utils/errors.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import { loadDependencyMeta } from '../core/dependency-meta.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { countReviewFindings } from '../utils/format.js';
import { Semaphore } from '../core/sdk-semaphore.js';
import { GeminiCircuitBreaker } from '../core/circuit-breaker.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';
import { parseAxesOption, warnDisabledAxes } from '../utils/axes-filter.js';
import { createMiniRun } from '../utils/run-id.js';
import { createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';

/** Registers the `review` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run agentic review on all pending files sequentially')
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
      const plain = parentOpts.plain === true || !process.stdout.isTTY;

      // Parse --axes filter
      const axesFilter = parseAxesOption(cmdOpts.axes);
      if (axesFilter === null) return;

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

      const { runId, runDir, logPath, conversationDir } = createMiniRun(projectRoot, 'review');
      const runLog = createFileLogger(logPath);

      try {
        await runWithContext({ runId, phase: 'review' }, async () => {
        runLog.info({ event: 'phase_start', phase: 'review', runId }, 'review started');
        const startMs = Date.now();

        // Auto-scan if no tasks exist
        const tasks = loadTasks(projectRoot);
        if (tasks.length === 0) {
          console.log('anatoly — scan (auto)');
          const scanResult = await scanProject(projectRoot, config);
          console.log(`  files     ${scanResult.filesScanned} (${scanResult.filesNew} new, ${scanResult.filesCached} cached)`);
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
          runLog.info({ event: 'phase_end', phase: 'review', durationMs: Date.now() - startMs, filesReviewed: 0 }, 'review completed (no pending files)');
          flushFileLogger();
          return;
        }

        const total = pending.length;
        const allTasks = loadTasks(projectRoot);
        const taskMap = new Map(allTasks.map((t) => [t.file, t]));
        const evaluators = getEnabledEvaluators(config, axesFilter);
        if (axesFilter) {
          warnDisabledAxes(axesFilter, evaluators.map((e) => e.id));
        }
        const depMeta = loadDependencyMeta(projectRoot);
        const sdkSemaphore = new Semaphore(config.providers.anthropic.concurrency);
        const geminiSemaphore = config.providers.google
          ? new Semaphore(config.providers.google.concurrency)
          : undefined;
        const circuitBreaker = config.providers.google
          ? new GeminiCircuitBreaker()
          : undefined;
        // Raise max listeners to account for concurrent SDK subprocess exit handlers
        process.setMaxListeners(Math.max(process.getMaxListeners(), config.providers.anthropic.concurrency + 10));
        const axesTotal = evaluators.length;

        // Pipeline display
        const state = new PipelineState();
        state.setSemaphore(sdkSemaphore);
        state.addTask('review', 'Reviewing files');
        state.setPhase('review');
        state.startTask('review', `0/${total}`);
        const renderer = new ScreenRenderer(state, { plain });
        renderer.start();

        let completedCount = 0;

        const updateReviewTask = () => {
          const findingsNote = totalFindings > 0 ? ` | ${totalFindings} findings` : '';
          state.updateTask('review', `${completedCount}/${total}${findingsNote}`);
        };

        try {
        await runWorkerPool({
          items: pending,
          concurrency: 1,
          isInterrupted: () => interrupted,
          handler: async (fp) => {
            const task = taskMap.get(fp.file);
            if (!task) {
              completedCount++;
              updateReviewTask();
              return;
            }

            pm.updateFileStatus(fp.file, 'IN_PROGRESS');
            state.trackFile(fp.file, { axesTotal });

            activeAbort = new AbortController();

            try {
              const result = await evaluateFile({
                projectRoot,
                task,
                config,
                evaluators,
                abortController: activeAbort,
                runDir,
                conversationDir,
                depMeta,
                deliberation: config.agents.enabled,
                semaphore: sdkSemaphore,
                geminiSemaphore,
                circuitBreaker,
                fallbackModel: config.models.quality,
                onAxisComplete: () => {
                  state.markAxisDone(fp.file);
                },
              });
              writeReviewOutput(projectRoot, result.review, runDir);
              writeTranscript(projectRoot, fp.file, result.transcript, runDir);
              pm.updateFileStatus(fp.file, 'DONE', undefined, evaluators.map(e => e.id));
              filesReviewed++;
              totalFindings += countReviewFindings(result.review);
              completedCount++;
            } catch (error) {
              if (interrupted) return;

              const message = error instanceof AnatolyError ? error.message : String(error);
              const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';

              pm.updateFileStatus(fp.file, errorCode === 'SDK_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
              filesErrored++;
              completedCount++;
            } finally {
              activeAbort = undefined;
              state.untrackFile(fp.file);
              updateReviewTask();
            }
          },
        });

        const findingsNote = totalFindings > 0 ? ` | ${totalFindings} findings` : '';
        state.completeTask('review', `${completedCount}/${total}${findingsNote}`);
        } finally {
          renderer.stop();
        }

        const durationMs = Date.now() - startMs;
        runLog.info({
          event: 'phase_end', phase: 'review', durationMs,
          filesReviewed, filesErrored, totalFindings,
        }, 'review completed');
        flushFileLogger();

        if (interrupted) {
          console.log(`interrupted \u2014 ${filesReviewed}/${total} files reviewed | ${totalFindings} findings`);
        } else {
          const rel = (p: string) => relative(process.cwd(), p) || '.';
          const reviewsDir = resolve(projectRoot, '.anatoly', 'reviews');
          const logsDir = resolve(projectRoot, '.anatoly', 'logs');
          console.log('');
          console.log(chalk.bold('Done') + ` \u2014 ${filesReviewed} files | ${totalFindings} findings | ${filesReviewed - filesErrored} clean`);
          console.log('');
          console.log(`  reviews      ${chalk.cyan(rel(reviewsDir) + '/')}`);
          console.log(`  transcripts  ${chalk.cyan(rel(logsDir) + '/')}`);
        }
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
        releaseLock(lockPath);
      }
    });
}
