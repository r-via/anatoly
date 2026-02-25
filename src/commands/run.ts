import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import picomatch from 'picomatch';
import { Listr } from 'listr2';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, estimateTriagedMinutes, formatTokenCount, loadTasks, SECONDS_PER_TIER } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { reviewFile } from '../core/reviewer.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { generateReport, type TriageStats } from '../core/reporter.js';
import { AnatolyError } from '../utils/errors.js';
import { indexProject, type RagIndexResult } from '../rag/index.js';
import type { PromptOptions } from '../utils/prompt-builder.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import { pkgVersion } from '../utils/version.js';
import { verdictColor } from '../utils/format.js';
import { triageFile, generateSkipReview, type TriageResult } from '../core/triage.js';
import { buildUsageGraph, type UsageGraph } from '../core/usage-graph.js';
import { fastReviewFile } from '../core/fast-reviewer.js';

interface RunContext {
  projectRoot: string;
  config: Config;
  runId: string;
  runDir: string;
  concurrency: number;
  plain: boolean;
  verbose?: boolean;
  fileFilter?: string;
  noCache: boolean;
  enableRag: boolean;
  rebuildRag?: boolean;
  shouldOpen?: boolean;
  triageEnabled: boolean;
  interrupted: boolean;
  lockPath?: string;
  activeAborts: Set<AbortController>;
  filesReviewed: number;
  totalFindings: number;
  totalFiles: number;
  reviewCounts: { skipped: number; fast: number; deep: number };
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

      const plain = (parentOpts.plain as boolean | undefined) ?? !process.stdout.isTTY;

      const ctx: RunContext = {
        projectRoot,
        config,
        runId,
        runDir: createRunDir(projectRoot, runId),
        concurrency,
        plain,
        verbose: parentOpts.verbose as boolean | undefined,
        fileFilter: parentOpts.file as string | undefined,
        noCache: parentOpts.cache === false,
        enableRag: parentOpts.rag !== false && config.rag.enabled,
        rebuildRag: parentOpts.rebuildRag as boolean | undefined,
        shouldOpen: parentOpts.open as boolean | undefined,
        triageEnabled: parentOpts.triage !== false,
        interrupted: false,
        activeAborts: new Set(),
        filesReviewed: 0,
        totalFindings: 0,
        totalFiles: 0,
        reviewCounts: { skipped: 0, fast: 0, deep: 0 },
      };

      const onSigint = () => {
        if (ctx.interrupted) {
          console.log(`\n${chalk.red.bold('force exit')}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          process.exit(1);
        }
        ctx.interrupted = true;
        for (const ac of ctx.activeAborts) ac.abort();
      };
      process.on('SIGINT', onSigint);

      try {
        const setup = await runSetupPhase(ctx);
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings`);
          return;
        }

        ctx.lockPath = acquireLock(projectRoot);
        const promptOptions = await runRagPhase(ctx);
        if (ctx.interrupted) return;

        // Inject usage graph into prompt options
        if (setup.usageGraph) {
          promptOptions.usageGraph = setup.usageGraph;
        }

        await runReviewPhase(ctx, promptOptions, setup.triageMap);
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

function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

interface SetupResult {
  files: number;
  triageMap: Map<string, TriageResult>;
  usageGraph?: UsageGraph;
}

async function runSetupPhase(ctx: RunContext): Promise<SetupResult> {
  console.log(chalk.bold(`anatoly v${pkgVersion}`));

  let estimateFiles = 0;
  const triageMap = new Map<string, TriageResult>();
  let usageGraph: UsageGraph | undefined;

  const setupRunner = new Listr([
    {
      title: 'config',
      task: (_c: unknown, listrTask: { title: string }) => {
        const parts = [
          shortModelName(ctx.config.llm.model),
          `concurrency ${ctx.concurrency}`,
          `rag ${ctx.enableRag ? 'on' : 'off'}`,
          `cache ${ctx.noCache ? 'off' : 'on'}`,
        ];
        if (ctx.fileFilter) parts.push(`filter ${ctx.fileFilter}`);
        parts.push(`run ${ctx.runId}`);

        listrTask.title = `config \u2014 ${parts.join(' \u00b7 ')}`;
      },
    },
    {
      title: 'scan',
      task: async (_c: unknown, listrTask: { title: string; output: string }) => {
        const scanResult = await scanProject(ctx.projectRoot, ctx.config);
        listrTask.title = `scan \u2014 ${scanResult.filesScanned} files`;

        if (ctx.verbose) {
          listrTask.output = `${scanResult.filesNew} new / ${scanResult.filesCached} cached`;
        }
      },
      rendererOptions: { persistentOutput: !!ctx.verbose },
    },
    {
      title: 'estimate',
      task: (_c: unknown, listrTask: { title: string }) => {
        const estimate = estimateProject(ctx.projectRoot);
        estimateFiles = estimate.files;

        const timeLabel = ctx.concurrency > 1
          ? `~${Math.ceil(estimate.estimatedMinutes / ctx.concurrency)} min (\u00d7${ctx.concurrency})`
          : `~${estimate.estimatedMinutes} min (sequential)`;

        listrTask.title = `estimate \u2014 ${estimate.files} files \u00b7 ${estimate.symbols} symbols \u00b7 ${formatTokenCount(estimate.inputTokens)} in / ${formatTokenCount(estimate.outputTokens)} out \u00b7 ${timeLabel}`;
      },
    },
    {
      title: 'triage',
      task: (_c: unknown, listrTask: { title: string }) => {
        if (!ctx.triageEnabled) {
          listrTask.title = 'triage \u2014 disabled (--no-triage)';
          return;
        }

        const tasks = loadTasks(ctx.projectRoot);
        const tiers = { skip: 0, fast: 0, deep: 0 };

        for (const task of tasks) {
          const absPath = resolve(ctx.projectRoot, task.file);
          let source: string;
          try {
            source = readFileSync(absPath, 'utf-8');
          } catch {
            // File unreadable — treat as deep
            triageMap.set(task.file, { tier: 'deep', reason: 'unreadable' });
            tiers.deep++;
            continue;
          }

          const result = triageFile(task, source);
          triageMap.set(task.file, result);
          tiers[result.tier]++;
        }

        const triageMinutes = estimateTriagedMinutes(tiers);
        const timeLabel = ctx.concurrency > 1
          ? `~${Math.ceil(triageMinutes / ctx.concurrency)} min (\u00d7${ctx.concurrency})`
          : `~${triageMinutes} min`;

        listrTask.title = `triage \u2014 ${tiers.skip} skip \u00b7 ${tiers.fast} fast \u00b7 ${tiers.deep} deep \u00b7 ${timeLabel}`;
      },
    },
    {
      title: 'usage graph',
      task: (_c: unknown, listrTask: { title: string }) => {
        const tasks = loadTasks(ctx.projectRoot);
        usageGraph = buildUsageGraph(ctx.projectRoot, tasks);
        listrTask.title = `usage graph \u2014 ${usageGraph.usages.size} edges`;
      },
    },
  ], {
    concurrent: false,
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
  });

  await setupRunner.run();

  return { files: estimateFiles, triageMap, usageGraph };
}

async function runRagPhase(ctx: RunContext): Promise<PromptOptions> {
  const promptOptions: PromptOptions = { ragEnabled: ctx.enableRag };

  if (!ctx.enableRag) return promptOptions;

  const ragTasks = loadTasks(ctx.projectRoot);
  let ragResult: RagIndexResult | undefined;

  const indexModelLabel = shortModelName(ctx.config.llm.index_model);
  const ragRunner = new Listr([{
    title: `RAG index (${indexModelLabel}) — 0/${ragTasks.length}`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      ragResult = await indexProject({
        projectRoot: ctx.projectRoot,
        tasks: ragTasks,
        indexModel: ctx.config.llm.index_model,
        rebuild: ctx.rebuildRag,
        concurrency: ctx.concurrency,
        onLog: (msg) => { listrTask.output = msg; },
        onProgress: (current, total) => {
          listrTask.title = `RAG index (${indexModelLabel}) — ${current}/${total}`;
        },
        isInterrupted: () => ctx.interrupted,
      });

      listrTask.title = `RAG index — ${ragResult.cardsIndexed} new / ${ragResult.totalCards} cards, ${ragResult.filesIndexed} new / ${ragResult.totalFiles} files`;
    },
    rendererOptions: { outputBar: 1 as const },
  }], {
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
  });

  await ragRunner.run();

  if (ctx.interrupted) {
    console.log('interrupted — rag indexing incomplete');
    if (ctx.lockPath) { releaseLock(ctx.lockPath); ctx.lockPath = undefined; }
    return promptOptions;
  }

  if (ragResult) {
    return { ragEnabled: true, vectorStore: ragResult.vectorStore };
  }
  return promptOptions;
}

async function runReviewPhase(
  ctx: RunContext,
  promptOptions: PromptOptions,
  triageMap: Map<string, TriageResult>,
): Promise<void> {
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

  // Shared atomic counter for completed files
  let completedCount = 0;

  // Build listr2 task list — one task per file
  const fileTasks = reviewItems.map((item, idx) => ({
    title: `[${idx + 1}/${ctx.totalFiles}] ${item.filePath}`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      if (ctx.interrupted) {
        listrTask.title = `[${idx + 1}/${ctx.totalFiles}] ${item.filePath} — skipped`;
        return;
      }

      const { filePath, task } = item;
      const triage = triageMap.get(filePath);

      // Handle skip-tier files: generate synthetic review, no API call
      if (ctx.triageEnabled && triage?.tier === 'skip') {
        pm.updateFileStatus(filePath, 'IN_PROGRESS');
        const skipReview = generateSkipReview(task, triage.reason);
        writeReviewOutput(ctx.projectRoot, skipReview, ctx.runDir);
        pm.updateFileStatus(filePath, 'DONE');
        ctx.filesReviewed++;
        ctx.reviewCounts.skipped++;
        completedCount++;
        listrTask.title = `[${completedCount}/${ctx.totalFiles}] ${filePath} — ${chalk.green('CLEAN')} ${chalk.dim('(skipped)')}`;
        return;
      }

      // Fast-tier: single-turn review, promote to deep on failure
      const isFastTier = ctx.triageEnabled && triage?.tier === 'fast';

      pm.updateFileStatus(filePath, 'IN_PROGRESS');

      let currentAbort = new AbortController();
      ctx.activeAborts.add(currentAbort);

      try {
        const startTime = Date.now();

        // Try fast review first for fast-tier files
        if (isFastTier) {
          const fastOutcome = await retryWithBackoff(
            async () => {
              if (ctx.interrupted) throw new Error('interrupted');
              if (currentAbort.signal.aborted) {
                ctx.activeAborts.delete(currentAbort);
                currentAbort = new AbortController();
                ctx.activeAborts.add(currentAbort);
              }
              return fastReviewFile(ctx.projectRoot, task, ctx.config, promptOptions, currentAbort, ctx.runDir);
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
                listrTask.output = `rate limited — retrying in ${delaySec}s (attempt ${attempt}/5)`;
              },
            },
          );

          if (!fastOutcome.promoted) {
            // Fast review succeeded
            const elapsedMs = Date.now() - startTime;
            writeReviewOutput(ctx.projectRoot, fastOutcome.review, ctx.runDir);
            pm.updateFileStatus(filePath, 'DONE');
            ctx.filesReviewed++;
            ctx.reviewCounts.fast++;
            completedCount++;

            countFindings(ctx, fastOutcome.review);
            listrTask.title = `[${completedCount}/${ctx.totalFiles}] ${filePath} — ${verdictColor(fastOutcome.review.verdict)} ${chalk.dim('(fast)')}`;

            if (ctx.verbose) {
              const elapsed = (elapsedMs / 1000).toFixed(1);
              const cost = fastOutcome.costUsd > 0 ? `$${fastOutcome.costUsd.toFixed(4)}` : '-';
              const retryInfo = fastOutcome.retries > 0 ? ` retries:${fastOutcome.retries}` : '';
              listrTask.output = `${elapsed}s  ${cost}${retryInfo}  fast`;
            }
            return;
          }

          // Fast review failed — promote to deep, continue in same slot
          if (ctx.verbose) {
            listrTask.output = `fast review failed (${fastOutcome.reason}) — promoting to deep`;
          }
        }

        // Deep review (also handles promoted fast files)
        const maxRetries = 5;
        const result = await retryWithBackoff(
          async () => {
            if (ctx.interrupted) throw new Error('interrupted');
            if (currentAbort.signal.aborted) {
              ctx.activeAborts.delete(currentAbort);
              currentAbort = new AbortController();
              ctx.activeAborts.add(currentAbort);
            }
            return reviewFile(ctx.projectRoot, task, ctx.config, promptOptions, currentAbort, ctx.runDir);
          },
          {
            maxRetries,
            baseDelayMs: 5000,
            maxDelayMs: 120_000,
            jitterFactor: 0.2,
            filePath,
            isInterrupted: () => ctx.interrupted,
            onRetry: (attempt, delayMs) => {
              const delaySec = (delayMs / 1000).toFixed(0);
              listrTask.output = `rate limited — retrying in ${delaySec}s (attempt ${attempt}/${maxRetries})`;
            },
          },
        );

        const elapsedMs = Date.now() - startTime;
        writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
        pm.updateFileStatus(filePath, 'DONE');
        ctx.filesReviewed++;
        ctx.reviewCounts.deep++;
        completedCount++;

        countFindings(ctx, result.review);
        listrTask.title = `[${completedCount}/${ctx.totalFiles}] ${filePath} — ${verdictColor(result.review.verdict)}`;

        if (ctx.verbose) {
          const elapsed = (elapsedMs / 1000).toFixed(1);
          const cost = result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : '-';
          const retryInfo = result.retries > 0 ? ` retries:${result.retries}` : '';
          listrTask.output = `${elapsed}s  ${cost}${retryInfo}`;
        }
      } catch (error) {
        if (ctx.interrupted) return;

        const message = error instanceof AnatolyError ? error.message : String(error);
        const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
        pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
        completedCount++;

        const label = errorCode === 'LLM_TIMEOUT' ? 'timeout' : 'error';
        listrTask.title = `[${completedCount}/${ctx.totalFiles}] ${filePath} — ${chalk.red(label)}`;
        throw error;
      } finally {
        ctx.activeAborts.delete(currentAbort);
      }
    },
    rendererOptions: { persistentOutput: ctx.verbose as boolean | undefined },
  }));

  const reviewRunner = new Listr(fileTasks, {
    concurrent: ctx.concurrency,
    exitOnError: false,
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
    rendererOptions: {
      collapseSubtasks: false,
      collapseErrors: false,
      showErrorMessage: false,
    },
  });

  await reviewRunner.run();
  await pm.flush();
}

function countFindings(ctx: RunContext, review: import('../schemas/review.js').ReviewFile): void {
  for (const s of review.symbols) {
    if (s.utility === 'DEAD') ctx.totalFindings++;
    if (s.duplication === 'DUPLICATE') ctx.totalFindings++;
    if (s.overengineering === 'OVER') ctx.totalFindings++;
    if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') ctx.totalFindings++;
  }
}

function runReportPhase(ctx: RunContext): void {
  const pm = new ProgressManager(ctx.projectRoot);
  const errorFiles: string[] = [];
  const progress = pm.getProgress();
  for (const [, fp] of Object.entries(progress.files)) {
    if (fp.status === 'ERROR' || fp.status === 'TIMEOUT') errorFiles.push(fp.file);
  }

  let triageStats: TriageStats | undefined;
  if (ctx.triageEnabled) {
    const { skipped, fast, deep } = ctx.reviewCounts;
    const total = skipped + fast + deep;
    const allDeepSeconds = total * SECONDS_PER_TIER.deep;
    const actualSeconds =
      skipped * SECONDS_PER_TIER.skip +
      fast * SECONDS_PER_TIER.fast +
      deep * SECONDS_PER_TIER.deep;
    triageStats = {
      total,
      skip: skipped,
      fast,
      deep,
      estimatedTimeSaved: (allDeepSeconds - actualSeconds) / 60,
    };
  }

  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir, triageStats);

  if (ctx.config.output?.max_runs) {
    purgeRuns(ctx.projectRoot, ctx.config.output.max_runs!);
  }

  console.log('');

  const { skipped, fast, deep } = ctx.reviewCounts;
  const tierSummary = ctx.triageEnabled
    ? ` (${skipped} skipped \u00b7 ${fast} fast \u00b7 ${deep} deep)`
    : '';
  console.log(chalk.bold('review complete') + ` — ${data.totalFiles} files | ${data.findingFiles.length} findings | ${data.cleanFiles.length} clean${tierSummary}`);
  console.log('');
  console.log(`  run          ${ctx.runId}`);
  console.log(`  report       ${chalk.cyan(reportPath)}`);
  console.log(`  reviews      ${chalk.cyan(resolve(ctx.runDir, 'reviews') + '/')}`);
  console.log(`  transcripts  ${chalk.cyan(resolve(ctx.runDir, 'logs') + '/')}`);

  if (ctx.shouldOpen) openFile(reportPath);

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;
}
