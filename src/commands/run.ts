import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import picomatch from 'picomatch';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, formatTokenCount, loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { generateReport } from '../core/reporter.js';
import { createRenderer, type Renderer } from '../utils/renderer.js';
import { toOutputName } from '../utils/cache.js';
import { AnatolyError } from '../utils/errors.js';
import { indexProject } from '../rag/index.js';
import type { PromptOptions } from '../utils/prompt-builder.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import { pkgVersion } from '../utils/version.js';

interface RunContext {
  projectRoot: string;
  config: Config;
  runId: string;
  runDir: string;
  concurrency: number;
  renderer: Renderer;
  verbose?: boolean;
  fileFilter?: string;
  noCache: boolean;
  enableRag: boolean;
  rebuildRag?: boolean;
  shouldOpen?: boolean;
  interrupted: boolean;
  lockPath?: string;
  activeAborts: Set<AbortController>;
  filesReviewed: number;
  totalFindings: number;
  totalFiles: number;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .option('--run-id <id>', 'custom run ID (alphanumeric, dashes, underscores)')
    .action(async (cmdOpts: { runId?: string }) => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const cliConcurrency = parentOpts.concurrency as number | undefined;
      const concurrency = cliConcurrency ?? config.llm.concurrency;

      if (concurrency < 1 || concurrency > 10 || !Number.isInteger(concurrency)) {
        console.error('error: --concurrency must be between 1 and 10');
        process.exitCode = 2;
        return;
      }

      const runId = cmdOpts.runId ?? generateRunId();
      if (cmdOpts.runId && !isValidRunId(cmdOpts.runId)) {
        console.error(`anatoly — error: invalid --run-id "${cmdOpts.runId}" (use alphanumeric, dashes, underscores)`);
        process.exitCode = 2;
        return;
      }

      const ctx: RunContext = {
        projectRoot,
        config,
        runId,
        runDir: createRunDir(projectRoot, runId),
        concurrency,
        renderer: createRenderer({
          plain: parentOpts.plain as boolean | undefined,
          version: pkgVersion,
          concurrency,
        }),
        verbose: parentOpts.verbose as boolean | undefined,
        fileFilter: parentOpts.file as string | undefined,
        noCache: parentOpts.cache === false,
        enableRag: parentOpts.rag !== false && config.rag.enabled,
        rebuildRag: parentOpts.rebuildRag as boolean | undefined,
        shouldOpen: parentOpts.open as boolean | undefined,
        interrupted: false,
        activeAborts: new Set(),
        filesReviewed: 0,
        totalFindings: 0,
        totalFiles: 0,
      };

      const onSigint = () => {
        if (ctx.interrupted) {
          console.log(`\n${chalk.red.bold('force exit')}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          process.exit(1);
        }
        ctx.interrupted = true;
        for (const ac of ctx.activeAborts) ac.abort();
        ctx.renderer.stop();
        console.log('');
        console.log(`${chalk.yellow.bold('⚠ shutting down…')} press Ctrl+C again to force exit`);
      };
      process.on('SIGINT', onSigint);

      try {
        printBanner(ctx);
        await runScanPhase(ctx);
        const estimate = runEstimatePhase(ctx);
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${estimate.files} files reviewed | 0 findings`);
          return;
        }

        ctx.lockPath = acquireLock(projectRoot);
        const promptOptions = await runRagPhase(ctx);
        if (ctx.interrupted) return;

        await runReviewPhase(ctx, promptOptions);
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote}`);
          releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        releaseLock(ctx.lockPath);
        ctx.lockPath = undefined;
        runReportPhase(ctx);
      } catch (error) {
        ctx.renderer.stop();
        if (ctx.lockPath) releaseLock(ctx.lockPath);
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

function printBanner(ctx: RunContext): void {
  console.log(chalk.bold(`anatoly v${pkgVersion}`));
  console.log(`  model          ${ctx.config.llm.model}`);
  console.log(`  index model    ${ctx.config.llm.index_model}`);
  console.log(`  concurrency    ${ctx.concurrency}`);
  console.log(`  rag            ${ctx.enableRag ? 'on' : 'off'}`);
  console.log(`  cache          ${ctx.noCache ? 'off' : 'on'}`);
  if (ctx.fileFilter) console.log(`  file filter    ${ctx.fileFilter}`);
  console.log(`  run id         ${ctx.runId}`);
  console.log('');
}

async function runScanPhase(ctx: RunContext): Promise<void> {
  const scanResult = await scanProject(ctx.projectRoot, ctx.config);
  console.log(`anatoly — scan`);
  console.log(`  files     ${scanResult.filesScanned}`);
  if (ctx.verbose) {
    console.log(`  new       ${scanResult.filesNew}`);
    console.log(`  cached    ${scanResult.filesCached}`);
  }
  console.log('');
}

function runEstimatePhase(ctx: RunContext): { files: number } {
  const estimate = estimateProject(ctx.projectRoot);
  console.log('anatoly — estimate');
  console.log(`  files        ${estimate.files}`);
  console.log(`  symbols      ${estimate.symbols}`);
  console.log(`  est. tokens  ${formatTokenCount(estimate.inputTokens)} input / ${formatTokenCount(estimate.outputTokens)} output`);
  const timeLabel = ctx.concurrency > 1
    ? `~${Math.ceil(estimate.estimatedMinutes / ctx.concurrency)} min (×${ctx.concurrency})`
    : `~${estimate.estimatedMinutes} min (sequential)`;
  console.log(`  est. time    ${timeLabel}`);
  console.log('');
  return { files: estimate.files };
}

async function runRagPhase(ctx: RunContext): Promise<PromptOptions> {
  let promptOptions: PromptOptions = { ragEnabled: ctx.enableRag };

  if (!ctx.enableRag) return promptOptions;

  const ragTasks = loadTasks(ctx.projectRoot);
  ctx.renderer.start(ragTasks.length);
  ctx.renderer.log('anatoly — rag index (haiku)');

  const ragResult = await indexProject({
    projectRoot: ctx.projectRoot,
    tasks: ragTasks,
    indexModel: ctx.config.llm.index_model,
    rebuild: ctx.rebuildRag,
    concurrency: ctx.concurrency,
    onLog: (msg) => ctx.renderer.log(`  ${msg}`),
    onProgress: (current, total) => ctx.renderer.updateProgress(current, total, 'indexing'),
    isInterrupted: () => ctx.interrupted,
  });

  ctx.renderer.stop();
  console.log(`  cards indexed  ${ragResult.cardsIndexed} new / ${ragResult.totalCards} total`);
  console.log(`  files          ${ragResult.filesIndexed} new / ${ragResult.totalFiles} total`);
  console.log('');

  if (ctx.interrupted) {
    console.log('interrupted — rag indexing incomplete');
    if (ctx.lockPath) { releaseLock(ctx.lockPath); ctx.lockPath = undefined; }
    return promptOptions;
  }

  return { ragEnabled: true, vectorStore: ragResult.vectorStore };
}

async function runReviewPhase(ctx: RunContext, promptOptions: PromptOptions): Promise<void> {
  const pm = new ProgressManager(ctx.projectRoot);

  if (ctx.noCache) {
    const progress = pm.getProgress();
    for (const [, fp] of Object.entries(progress.files)) {
      if (fp.status === 'CACHED') pm.updateFileStatus(fp.file, 'PENDING');
    }
  }

  let pending = pm.getPendingFiles();
  if (ctx.fileFilter) {
    const isMatch = picomatch(ctx.fileFilter);
    pending = pending.filter((fp) => isMatch(fp.file));
  }

  if (pending.length === 0) {
    console.log('anatoly — review');
    console.log('  No pending files to review.');
    console.log('');
    return;
  }

  ctx.totalFiles = pending.length;

  const allTasks = loadTasks(ctx.projectRoot);
  const taskMap = new Map<string, Task>();
  for (const t of allTasks) taskMap.set(t.file, t);

  const reviewItems = pending
    .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file) }))
    .filter((item): item is { filePath: string; task: Task } => item.task !== undefined);

  ctx.renderer.start(ctx.totalFiles);
  let completedCount = 0;

  await runWorkerPool({
    items: reviewItems,
    concurrency: ctx.concurrency,
    isInterrupted: () => ctx.interrupted,
    handler: async (item, workerIndex) => {
      const { filePath, task } = item;
      ctx.renderer.updateWorkerSlot(workerIndex, filePath);
      pm.updateFileStatus(filePath, 'IN_PROGRESS');

      let currentAbort = new AbortController();
      ctx.activeAborts.add(currentAbort);

      try {
        const startTime = Date.now();

        const result = await retryWithBackoff(
          async () => {
            if (currentAbort.signal.aborted) {
              ctx.activeAborts.delete(currentAbort);
              currentAbort = new AbortController();
              ctx.activeAborts.add(currentAbort);
            }
            return reviewFile(ctx.projectRoot, task, ctx.config, promptOptions, currentAbort, ctx.runDir);
          },
          {
            maxRetries: 5,
            baseDelayMs: 5000,
            maxDelayMs: 120_000,
            jitterFactor: 0.2,
            filePath,
            isInterrupted: () => ctx.interrupted,
            onRetry: (attempt, delayMs) => {
              const delaySec = (delayMs / 1000).toFixed(0);
              ctx.renderer.log(`  rate limited — retrying ${filePath} in ${delaySec}s (attempt ${attempt}/5)`);
            },
          },
        );

        const elapsedMs = Date.now() - startTime;
        writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
        pm.updateFileStatus(filePath, 'DONE');
        ctx.filesReviewed++;
        completedCount++;
        ctx.renderer.updateProgress(completedCount, ctx.totalFiles, `reviewing ${filePath}`);

        const outputName = toOutputName(filePath) + '.rev.md';
        let findingsSummary: string | undefined;

        for (const s of result.review.symbols) {
          if (s.utility === 'DEAD') { ctx.renderer.incrementCounter('dead'); ctx.totalFindings++; }
          if (s.duplication === 'DUPLICATE') { ctx.renderer.incrementCounter('duplicate'); ctx.totalFindings++; }
          if (s.overengineering === 'OVER') { ctx.renderer.incrementCounter('overengineering'); ctx.totalFindings++; }
          if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') { ctx.renderer.incrementCounter('error'); ctx.totalFindings++; }
        }

        const dead = result.review.symbols.filter((s) => s.utility === 'DEAD').length;
        const dup = result.review.symbols.filter((s) => s.duplication === 'DUPLICATE').length;
        if (dead > 0) findingsSummary = `DEAD:${dead}`;
        else if (dup > 0) findingsSummary = `DUP:${dup}`;

        ctx.renderer.addResult(outputName, result.review.verdict, findingsSummary);

        if (ctx.verbose) {
          const elapsed = (elapsedMs / 1000).toFixed(1);
          const cost = result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : '-';
          const retryInfo = result.retries > 0 ? ` retries:${result.retries}` : '';
          ctx.renderer.log(`    ${filePath}  ${elapsed}s  ${cost}${retryInfo}`);
        }
      } catch (error) {
        const message = error instanceof AnatolyError ? error.message : String(error);
        const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
        pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
        completedCount++;
        ctx.renderer.updateProgress(completedCount, ctx.totalFiles, `reviewing ${filePath}`);
        ctx.renderer.incrementCounter('error');

        if (error instanceof AnatolyError) {
          ctx.renderer.log(`  [${errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error'}] ${error.formatForDisplay()}`);
        } else {
          ctx.renderer.log(`  [error] error: ${String(error)}`);
        }
      } finally {
        ctx.activeAborts.delete(currentAbort);
        ctx.renderer.clearWorkerSlot(workerIndex);
      }
    },
  });

  await pm.flush();
  ctx.renderer.stop();
}

function runReportPhase(ctx: RunContext): void {
  const pm = new ProgressManager(ctx.projectRoot);
  const errorFiles: string[] = [];
  const progress = pm.getProgress();
  for (const [, fp] of Object.entries(progress.files)) {
    if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') errorFiles.push(fp.file);
  }

  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir);

  if (ctx.config.output?.max_runs) {
    purgeRuns(ctx.projectRoot, ctx.config.output.max_runs!);
  }

  console.log(`  run       ${ctx.runId}`);
  ctx.renderer.showCompletion(
    { reviewed: data.totalFiles, findings: data.findingFiles.length, clean: data.cleanFiles.length },
    { report: reportPath, reviews: resolve(ctx.runDir, 'reviews') + '/', logs: resolve(ctx.runDir, 'logs') + '/' },
  );

  if (ctx.shouldOpen) openFile(reportPath);

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;
}
