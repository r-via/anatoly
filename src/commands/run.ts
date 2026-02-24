import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
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
import { indexProject } from '../rag/index.js';
import type { PromptOptions } from '../utils/prompt-builder.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';

declare const PKG_VERSION: string;
const pkgVersion = typeof PKG_VERSION !== 'undefined' ? PKG_VERSION : '0.0.0-dev';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .option('--run-id <id>', 'custom run ID (alphanumeric, dashes, underscores)')
    .action(async (cmdOpts: { runId?: string }) => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const isPlain = parentOpts.plain as boolean | undefined;
      const fileFilter = parentOpts.file as string | undefined;
      const noCache = parentOpts.cache === false;
      const enableRag = parentOpts.rag !== false && config.rag.enabled;
      const rebuildRag = parentOpts.rebuildRag as boolean | undefined;
      const shouldOpen = parentOpts.open as boolean | undefined;
      const verbose = parentOpts.verbose as boolean | undefined;

      // Resolve concurrency: CLI flag > config > default 4
      const cliConcurrency = parentOpts.concurrency as number | undefined;
      const concurrency = cliConcurrency ?? config.llm.concurrency;

      // Validate concurrency range
      if (concurrency < 1 || concurrency > 10 || !Number.isInteger(concurrency)) {
        console.error('error: --concurrency must be between 1 and 10');
        process.exitCode = 2;
        return;
      }

      // Resolve run ID and create run-scoped output directory
      const runId = cmdOpts.runId ?? generateRunId();
      if (cmdOpts.runId && !isValidRunId(cmdOpts.runId)) {
        console.error(`anatoly — error: invalid --run-id "${cmdOpts.runId}" (use alphanumeric, dashes, underscores)`);
        process.exitCode = 2;
        return;
      }
      const runDir = createRunDir(projectRoot, runId);

      const renderer = createRenderer({
        plain: isPlain,
        version: pkgVersion,
      });

      let lockPath: string | undefined;
      let interrupted = false;
      let filesReviewed = 0;
      let totalFindings = 0;
      let totalFiles = 0;

      // Track all active AbortControllers for concurrent reviews
      const activeAborts = new Set<AbortController>();

      // SIGINT handler: first Ctrl+C → graceful shutdown, second → force exit
      const onSigint = () => {
        if (interrupted) {
          console.log(`\n${chalk.red.bold('force exit')}`);
          if (lockPath) releaseLock(lockPath);
          process.exit(1);
        }
        interrupted = true;
        // Abort all in-flight reviews
        for (const ac of activeAborts) {
          ac.abort();
        }
        renderer.stop();
        console.log('');
        console.log(`${chalk.yellow.bold('⚠ shutting down…')} press Ctrl+C again to force exit`);
      };
      process.on('SIGINT', onSigint);

      try {
        // Display launch parameters
        console.log(chalk.bold(`anatoly v${pkgVersion}`));
        console.log(`  model          ${config.llm.model}`);
        console.log(`  index model    ${config.llm.index_model}`);
        console.log(`  concurrency    ${concurrency}`);
        console.log(`  rag            ${enableRag ? 'on' : 'off'}`);
        console.log(`  cache          ${noCache ? 'off' : 'on'}`);
        if (fileFilter) console.log(`  file filter    ${fileFilter}`);
        console.log(`  run id         ${runId}`);
        console.log('');

        // Phase 1: SCAN
        const scanResult = await scanProject(projectRoot, config);
        console.log(`anatoly — scan`);
        console.log(`  files     ${scanResult.filesScanned}`);
        if (verbose) {
          console.log(`  new       ${scanResult.filesNew}`);
          console.log(`  cached    ${scanResult.filesCached}`);
        }
        console.log('');

        // Phase 2: ESTIMATE
        const estimate = estimateProject(projectRoot);
        console.log('anatoly — estimate');
        console.log(`  files        ${estimate.files}`);
        console.log(`  symbols      ${estimate.symbols}`);
        console.log(`  est. tokens  ${formatTokenCount(estimate.inputTokens)} input / ${formatTokenCount(estimate.outputTokens)} output`);
        const timeLabel = concurrency > 1
          ? `~${Math.ceil(estimate.estimatedMinutes / concurrency)} min (×${concurrency})`
          : `~${estimate.estimatedMinutes} min (sequential)`;
        console.log(`  est. time    ${timeLabel}`);
        console.log('');

        if (interrupted) {
          console.log(`interrupted — 0/${estimate.files} files reviewed | 0 findings`);
          return;
        }

        // Phase 3: RAG INDEX (Haiku)
        lockPath = acquireLock(projectRoot);
        const pm = new ProgressManager(projectRoot);

        let promptOptions: PromptOptions = { ragEnabled: enableRag };

        if (enableRag) {
          console.log('anatoly — rag index (haiku)');
          const ragResult = await indexProject({
            projectRoot,
            tasks: loadTasks(projectRoot),
            indexModel: config.llm.index_model,
            rebuild: rebuildRag,
            onLog: (msg) => console.log(`  ${msg}`),
            isInterrupted: () => interrupted,
          });

          console.log(`  cards indexed  ${ragResult.cardsIndexed} new / ${ragResult.totalCards} total`);
          console.log(`  files          ${ragResult.filesIndexed} new / ${ragResult.totalFiles} total`);
          console.log('');

          if (interrupted) {
            console.log('interrupted — rag indexing incomplete');
            releaseLock(lockPath);
            lockPath = undefined;
            return;
          }

          promptOptions = { ragEnabled: true, vectorStore: ragResult.vectorStore };
        }

        // --no-cache: reset CACHED files to PENDING
        if (noCache) {
          const progress = pm.getProgress();
          for (const [, fp] of Object.entries(progress.files)) {
            if (fp.status === 'CACHED') {
              pm.updateFileStatus(fp.file, 'PENDING');
            }
          }
        }

        let pending = pm.getPendingFiles();

        // --file <glob>: filter pending files by glob pattern
        if (fileFilter) {
          pending = pending.filter((fp) => matchGlob(fp.file, fileFilter));
        }

        if (pending.length === 0) {
          console.log('anatoly — review');
          console.log('  No pending files to review.');
          console.log('');
        } else {
          totalFiles = pending.length;

          // Pre-load all tasks once for the review phase
          const allTasks = loadTasks(projectRoot);
          const taskMap = new Map<string, Task>();
          for (const t of allTasks) {
            taskMap.set(t.file, t);
          }

          // Build the list of reviewable items (files with matching tasks)
          const reviewItems = pending
            .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file) }))
            .filter((item): item is { filePath: string; task: Task } => item.task !== undefined);

          renderer.start(totalFiles);

          let completedCount = 0;

          await runWorkerPool({
            items: reviewItems,
            concurrency,
            isInterrupted: () => interrupted,
            handler: async (item, workerIndex) => {
              const { filePath, task } = item;

              renderer.updateWorkerSlot(workerIndex, filePath);
              renderer.updateProgress(completedCount + 1, totalFiles, filePath);
              pm.updateFileStatus(filePath, 'IN_PROGRESS');

              let currentAbort = new AbortController();
              activeAborts.add(currentAbort);

              try {
                const startTime = Date.now();

                const result = await retryWithBackoff(
                  async () => {
                    // Create a fresh AbortController for each retry attempt
                    if (currentAbort.signal.aborted) {
                      activeAborts.delete(currentAbort);
                      currentAbort = new AbortController();
                      activeAborts.add(currentAbort);
                    }
                    return reviewFile(projectRoot, task, config, promptOptions, currentAbort, runDir);
                  },
                  {
                    maxRetries: 5,
                    baseDelayMs: 5000,
                    maxDelayMs: 120_000,
                    jitterFactor: 0.2,
                    filePath,
                    isInterrupted: () => interrupted,
                    onRetry: (attempt, delayMs) => {
                      const delaySec = (delayMs / 1000).toFixed(0);
                      console.log(`  rate limited — retrying ${filePath} in ${delaySec}s (attempt ${attempt}/5)`);
                    },
                  },
                );

                const elapsedMs = Date.now() - startTime;

                writeReviewOutput(projectRoot, result.review, runDir);
                pm.updateFileStatus(filePath, 'DONE');
                filesReviewed++;
                completedCount++;

                // Count findings and update counters
                const outputName = toOutputName(filePath) + '.rev.md';
                let findingsSummary: string | undefined;

                for (const s of result.review.symbols) {
                  if (s.utility === 'DEAD') { renderer.incrementCounter('dead'); totalFindings++; }
                  if (s.duplication === 'DUPLICATE') { renderer.incrementCounter('duplicate'); totalFindings++; }
                  if (s.overengineering === 'OVER') { renderer.incrementCounter('overengineering'); totalFindings++; }
                  if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') { renderer.incrementCounter('error'); totalFindings++; }
                }

                // Build findings summary for result line
                const dead = result.review.symbols.filter((s) => s.utility === 'DEAD').length;
                const dup = result.review.symbols.filter((s) => s.duplication === 'DUPLICATE').length;
                if (dead > 0) findingsSummary = `DEAD:${dead}`;
                else if (dup > 0) findingsSummary = `DUP:${dup}`;

                renderer.addResult(outputName, result.review.verdict, findingsSummary);

                // Verbose output: cost, time, retries per file
                if (verbose) {
                  const elapsed = (elapsedMs / 1000).toFixed(1);
                  const cost = result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : '-';
                  const retryInfo = result.retries > 0 ? ` retries:${result.retries}` : '';
                  console.log(`    ${filePath}  ${elapsed}s  ${cost}${retryInfo}`);
                }
              } catch (error) {
                const message = error instanceof AnatolyError ? error.message : String(error);
                const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
                pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
                completedCount++;
                renderer.incrementCounter('error');

                if (error instanceof AnatolyError) {
                  console.log(`  [${errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error'}] ${error.formatForDisplay()}`);
                } else {
                  console.log(`  [error] error: ${String(error)}`);
                }
              } finally {
                activeAborts.delete(currentAbort);
                renderer.clearWorkerSlot(workerIndex);
              }
            },
          });

          // Flush any pending ProgressManager writes before stopping
          await pm.flush();
          renderer.stop();
        }

        // Handle interrupt after review loop
        if (interrupted) {
          const inFlight = activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${filesReviewed}/${totalFiles} files reviewed | ${totalFindings} findings${inFlightNote}`);
          releaseLock(lockPath);
          lockPath = undefined;
          return;
        }

        releaseLock(lockPath);
        lockPath = undefined;

        // Phase 5: REPORT
        const progressForReport = new ProgressManager(projectRoot);
        const errorFiles: string[] = [];
        const progress = progressForReport.getProgress();
        for (const [, fp] of Object.entries(progress.files)) {
          if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') {
            errorFiles.push(fp.file);
          }
        }

        const { reportPath, data } = generateReport(projectRoot, errorFiles, runDir);

        // Purge old runs if max_runs is configured
        if (config.output?.max_runs) {
          purgeRuns(projectRoot, config.output.max_runs);
        }

        // Compute stats
        const reportFindings = data.findingFiles.length;
        const reviewed = data.totalFiles;
        const clean = data.cleanFiles.length;

        console.log(`  run       ${runId}`);
        renderer.showCompletion(
          { reviewed, findings: reportFindings, clean },
          {
            report: reportPath,
            reviews: resolve(runDir, 'reviews') + '/',
            logs: resolve(runDir, 'logs') + '/',
          },
        );

        // Open report if --open flag is set
        if (shouldOpen) {
          openFile(reportPath);
        }

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
        if (error instanceof AnatolyError) {
          console.error(`anatoly — ${error.formatForDisplay()}`);
        } else {
          console.error(`anatoly — error: ${String(error)}`);
        }
        process.exitCode = 2;
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    });
}

/**
 * Simple glob matching for --file filter.
 * Supports * (any chars except /), ** (any chars including /), ? (single char).
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip trailing slash after **
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      regex += '(';
      i++;
    } else if (c === '}') {
      regex += ')';
      i++;
    } else if (c === ',') {
      regex += '|';
      i++;
    } else if ('.+^$|()[]\\'.includes(c)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`).test(filePath);
}
