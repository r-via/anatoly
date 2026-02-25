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
import { estimateProject, formatTokenCount, loadTasks, estimateFileSeconds, estimateSequentialSeconds, estimateMinutesWithConcurrency } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput } from '../core/review-writer.js';
import { generateReport, type TriageStats } from '../core/reporter.js';
import { AnatolyError } from '../utils/errors.js';
import { indexProject, type RagIndexResult } from '../rag/index.js';
import { EMBEDDING_MODEL } from '../rag/embeddings.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import { pkgVersion } from '../utils/version.js';
import { triageFile, generateSkipReview, type TriageResult } from '../core/triage.js';
import { buildUsageGraph, type UsageGraph } from '../core/usage-graph.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import type { VectorStore } from '../rag/vector-store.js';
import { runWorkerPool } from '../core/worker-pool.js';

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
  reviewCounts: { skipped: number; evaluated: number };
  startTime: number;
  /** All loaded tasks — set during setup phase, used in report phase for time estimation */
  allTasks: Task[];
  /** Triage map — set during setup phase, used in report phase for estimatedTimeSaved */
  triageMap: Map<string, TriageResult>;
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
        reviewCounts: { skipped: 0, evaluated: 0 },
        startTime: Date.now(),
        allTasks: [],
        triageMap: new Map(),
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
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings | ${formatDuration(Date.now() - ctx.startTime)}`);
          return;
        }

        ctx.lockPath = acquireLock(projectRoot);
        const ragContext = await runRagPhase(ctx, setup.tasks);
        if (ctx.interrupted) return;

        await runReviewPhase(ctx, setup.triageMap, setup.usageGraph, ragContext);
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote} | ${formatDuration(Date.now() - ctx.startTime)}`);
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

interface SetupResult {
  files: number;
  tasks: Task[];
  triageMap: Map<string, TriageResult>;
  usageGraph?: UsageGraph;
}

async function runSetupPhase(ctx: RunContext): Promise<SetupResult> {
  console.log(chalk.bold(`anatoly v${pkgVersion}`));

  let estimateFiles = 0;
  const triageMap = new Map<string, TriageResult>();
  let usageGraph: UsageGraph | undefined;
  let allTasks: Task[] = [];

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
        allTasks = loadTasks(ctx.projectRoot);
        const estimate = estimateProject(ctx.projectRoot);
        estimateFiles = estimate.files;

        const minutes = estimateMinutesWithConcurrency(
          estimateSequentialSeconds(allTasks),
          ctx.concurrency,
        );
        const timeLabel = ctx.concurrency > 1
          ? `~${minutes} min (\u00d7${ctx.concurrency})`
          : `~${minutes} min`;

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

        const tiers = { skip: 0, evaluate: 0 };

        for (const task of allTasks) {
          const absPath = resolve(ctx.projectRoot, task.file);
          let source: string;
          try {
            source = readFileSync(absPath, 'utf-8');
          } catch {
            // File unreadable — treat as evaluate
            triageMap.set(task.file, { tier: 'evaluate', reason: 'unreadable' });
            tiers.evaluate++;
            continue;
          }

          const result = triageFile(task, source);
          triageMap.set(task.file, result);
          tiers[result.tier]++;
        }

        const evalTasks = allTasks.filter((t) => triageMap.get(t.file)?.tier === 'evaluate');
        const triageMinutes = estimateMinutesWithConcurrency(
          estimateSequentialSeconds(evalTasks),
          ctx.concurrency,
        );
        const timeLabel = ctx.concurrency > 1
          ? `~${triageMinutes} min (\u00d7${ctx.concurrency})`
          : `~${triageMinutes} min`;

        listrTask.title = `triage \u2014 ${tiers.skip} skip \u00b7 ${tiers.evaluate} evaluate \u00b7 ${timeLabel}`;
      },
    },
    {
      title: 'usage graph',
      task: (_c: unknown, listrTask: { title: string }) => {
        usageGraph = buildUsageGraph(ctx.projectRoot, allTasks);
        listrTask.title = `usage graph \u2014 ${usageGraph.usages.size} edges`;
      },
    },
  ], {
    concurrent: false,
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
  });

  await setupRunner.run();

  ctx.allTasks = allTasks;
  ctx.triageMap = triageMap;

  return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph };
}

interface RagContext {
  vectorStore?: VectorStore;
  ragEnabled: boolean;
}

async function runRagPhase(ctx: RunContext, tasks: Task[]): Promise<RagContext> {
  if (!ctx.enableRag) return { ragEnabled: false };

  let ragResult: RagIndexResult | undefined;

  const indexModelLabel = shortModelName(ctx.config.llm.index_model);
  const embedLabel = EMBEDDING_MODEL;
  const ragRunner = new Listr([{
    title: `RAG index (${indexModelLabel} · ${embedLabel}) — 0/${tasks.length}`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      ragResult = await indexProject({
        projectRoot: ctx.projectRoot,
        tasks,
        indexModel: ctx.config.llm.index_model,
        rebuild: ctx.rebuildRag,
        concurrency: ctx.concurrency,
        onLog: (msg) => { listrTask.output = msg; },
        onProgress: (current, total) => {
          listrTask.title = `RAG index (${indexModelLabel} · ${embedLabel}) — ${current}/${total}`;
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
    return { ragEnabled: false };
  }

  if (ragResult) {
    return { ragEnabled: true, vectorStore: ragResult.vectorStore };
  }
  return { ragEnabled: false };
}

async function runReviewPhase(
  ctx: RunContext,
  triageMap: Map<string, TriageResult>,
  usageGraph: UsageGraph | undefined,
  ragContext: RagContext,
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

  const evaluators = getEnabledEvaluators(ctx.config);
  const axisIds = evaluators.map((e) => e.id);
  const total = reviewItems.length;

  // Track active files for compact display (only in-flight files visible)
  const activeFiles = new Map<string, { axes: Set<string>; retryMsg?: string }>();

  const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
  let spinFrame = 0;

  const AXIS_LABELS: Record<string, string> = {
    utility: 'utility',
    duplication: 'duplication',
    overengineering: 'overengineering',
    tests: 'tests',
    correction: 'correction',
    best_practices: 'best practices',
  };

  function formatAxes(done: Set<string>): string {
    const frame = SPINNER[spinFrame % SPINNER.length];
    return axisIds.map((id) => {
      const label = AXIS_LABELS[id] ?? id;
      return done.has(id) ? `${chalk.green('[x]')} ${label}` : `[${chalk.yellow(frame)}] ${label}`;
    }).join(' ');
  }

  function emitActiveFiles(listrTask: { output: string }): void {
    spinFrame++;
    const marker = chalk.yellow('\u25cf');
    const files = [...activeFiles.entries()];
    const maxLen = files.length > 0 ? Math.max(...files.map(([f]) => f.length)) : 0;
    const lines: string[] = [];
    for (const [file, state] of files) {
      const padded = file.padEnd(maxLen);
      if (state.retryMsg) {
        lines.push(`${marker} ${padded}  ${state.retryMsg}`);
      } else {
        lines.push(`${marker} ${padded}  ${formatAxes(state.axes)}`);
      }
    }
    listrTask.output = lines.join('\n');
  }

  const reviewRunner = new Listr([{
    title: `review — 0/${total}`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      let completedCount = 0;

      const updateTitle = () => {
        const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
        listrTask.title = `review — ${completedCount}/${total}${findingsNote}`;
      };

      // Animate spinner while files are being processed
      const spinInterval = setInterval(() => {
        if (activeFiles.size > 0) emitActiveFiles(listrTask);
      }, 80);

      try {
      await runWorkerPool({
        items: reviewItems,
        concurrency: ctx.concurrency,
        isInterrupted: () => ctx.interrupted,
        handler: async (item) => {
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
            updateTitle();
            return;
          }

          // Evaluate tier: run all axis evaluators in parallel
          pm.updateFileStatus(filePath, 'IN_PROGRESS');
          activeFiles.set(filePath, { axes: new Set() });

          let currentAbort = new AbortController();
          ctx.activeAborts.add(currentAbort);

          try {
            const result = await retryWithBackoff(
              async () => {
                if (ctx.interrupted) throw new Error('interrupted');
                if (currentAbort.signal.aborted) {
                  ctx.activeAborts.delete(currentAbort);
                  currentAbort = new AbortController();
                  ctx.activeAborts.add(currentAbort);
                }
                return evaluateFile({
                  projectRoot: ctx.projectRoot,
                  task,
                  config: ctx.config,
                  evaluators,
                  abortController: currentAbort,
                  runDir: ctx.runDir,
                  usageGraph,
                  vectorStore: ragContext.vectorStore,
                  ragEnabled: ragContext.ragEnabled,
                  onAxisComplete: (axisId) => {
                    const state = activeFiles.get(filePath);
                    if (state) {
                      state.retryMsg = undefined;
                      state.axes.add(axisId);
                    }
                  },
                });
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
                  const state = activeFiles.get(filePath);
                  if (state) state.retryMsg = `retrying in ${delaySec}s (${attempt}/5)`;
                },
              },
            );

            writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
            pm.updateFileStatus(filePath, 'DONE');
            ctx.filesReviewed++;
            ctx.reviewCounts.evaluated++;
            completedCount++;
            countFindings(ctx, result.review);
          } catch (error) {
            if (ctx.interrupted) return;

            const message = error instanceof AnatolyError ? error.message : String(error);
            const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
            pm.updateFileStatus(filePath, errorCode === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
            completedCount++;
          } finally {
            ctx.activeAborts.delete(currentAbort);
            activeFiles.delete(filePath);
            updateTitle();
          }
        },
      });
      } finally {
        clearInterval(spinInterval);
      }

      const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
      listrTask.title = `review — ${completedCount}/${total}${findingsNote}`;
    },
    rendererOptions: { outputBar: 1 as number },
  }], {
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
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
    const { skipped, evaluated } = ctx.reviewCounts;
    const total = skipped + evaluated;
    // Time saved = weighted seconds of files that were skipped (would have been evaluated)
    let skippedSeconds = 0;
    for (const task of ctx.allTasks) {
      if (ctx.triageMap.get(task.file)?.tier === 'skip') {
        skippedSeconds += estimateFileSeconds(task.symbols.length);
      }
    }
    triageStats = {
      total,
      skip: skipped,
      evaluate: evaluated,
      estimatedTimeSaved: skippedSeconds / 60,
    };
  }

  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir, triageStats);

  if (ctx.config.output?.max_runs) {
    purgeRuns(ctx.projectRoot, ctx.config.output.max_runs!);
  }

  console.log('');

  const { skipped, evaluated } = ctx.reviewCounts;
  const tierSummary = ctx.triageEnabled
    ? ` (${skipped} skipped \u00b7 ${evaluated} evaluated)`
    : '';
  const duration = formatDuration(Date.now() - ctx.startTime);
  console.log(chalk.bold('review complete') + ` — ${data.totalFiles} files | ${data.findingFiles.length} findings | ${data.cleanFiles.length} clean${tierSummary} | ${duration}`);
  console.log('');
  console.log(`  run          ${ctx.runId}`);
  console.log(`  report       ${chalk.cyan(reportPath)}`);
  console.log(`  reviews      ${chalk.cyan(resolve(ctx.runDir, 'reviews') + '/')}`);
  console.log(`  transcripts  ${chalk.cyan(resolve(ctx.runDir, 'logs') + '/')}`);

  if (ctx.shouldOpen) openFile(reportPath);

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;
}
