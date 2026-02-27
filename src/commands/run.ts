import type { Command } from 'commander';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import picomatch from 'picomatch';
import { Listr } from 'listr2';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, estimateTasksTokens, formatTokenCount, loadTasks, estimateFileSeconds, estimateSequentialSeconds, estimateMinutesWithConcurrency } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript } from '../core/review-writer.js';
import { generateReport, type TriageStats } from '../core/reporter.js';
import { AnatolyError } from '../utils/errors.js';
import { toOutputName } from '../utils/cache.js';
import { indexProject, type RagIndexResult } from '../rag/index.js';
import { EMBEDDING_MODEL } from '../rag/embeddings.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { formatTokenSummary } from '../utils/format.js';
import { getLogger, createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import { pkgVersion } from '../utils/version.js';
import { triageFile, generateSkipReview, type TriageResult } from '../core/triage.js';
import { buildUsageGraph, type UsageGraph } from '../core/usage-graph.js';
import { loadDependencyMeta, type DependencyMeta } from '../core/dependency-meta.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import type { VectorStore } from '../rag/vector-store.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { buildProjectTree } from '../core/project-tree.js';
import { ReviewProgressDisplay, countReviewFindings } from './review-display.js';
import { injectBadge } from '../core/badge.js';

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
  deliberation: boolean;
  /** Accumulated phase durations for run-metrics.json */
  phaseDurations: Record<string, number>;
  /** Total LLM cost accumulated across all review phases */
  totalCostUsd: number;
  /** Error count for error summary */
  errorCount: number;
  /** Errors aggregated by code for end-of-run summary */
  errorsByCode: Record<string, number>;
  /** Number of files where at least one axis evaluator crashed */
  degradedReviews: number;
  /** Per-axis aggregated stats for run-metrics.json */
  axisStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }>;
  /** Per-run file logger (writes to <runDir>/anatoly.ndjson) */
  runLog?: import('../utils/logger.js').Logger;
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
        deliberation: parentOpts.deliberation !== undefined
          ? parentOpts.deliberation as boolean
          : config.llm.deliberation,
        interrupted: false,
        activeAborts: new Set(),
        filesReviewed: 0,
        totalFindings: 0,
        totalFiles: 0,
        reviewCounts: { skipped: 0, evaluated: 0 },
        startTime: Date.now(),
        allTasks: [],
        triageMap: new Map(),
        phaseDurations: {},
        totalCostUsd: 0,
        errorCount: 0,
        errorsByCode: {},
        degradedReviews: 0,
        axisStats: {},
      };

      // Create per-run ndjson log file at debug level
      const runLogPath = join(ctx.runDir, 'anatoly.ndjson');
      ctx.runLog = createFileLogger(runLogPath);
      ctx.runLog.info({ runId, concurrency, projectRoot }, 'run started');

      const onSigint = () => {
        if (ctx.interrupted) {
          flushFileLogger();
          console.log(`\n${chalk.red.bold('force exit')}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          process.exit(1);
        }
        ctx.interrupted = true;
        flushFileLogger();
        for (const ac of ctx.activeAborts) ac.abort();
      };
      process.on('SIGINT', onSigint);

      try {
        await runWithContext({ runId, phase: 'setup' }, async () => {
        const setup = await runSetupPhase(ctx);
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings | ${formatDuration(Date.now() - ctx.startTime)}`);
          return;
        }

        ctx.lockPath = acquireLock(projectRoot);
        await runWithContext({ phase: 'rag-index' }, async () => {
        const ragContext = await runRagPhase(ctx, setup.tasks);
        if (ctx.interrupted) return;

        await runWithContext({ phase: 'review' }, async () => {
        await runReviewPhase(ctx, setup.triageMap, setup.usageGraph, ragContext, setup.depMeta, setup.projectTree);
        });
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote} | ${formatDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        await runWithContext({ phase: 'report' }, async () => {
        const reportData = runReportPhase(ctx);

        // Badge injection — post-report, still under lock
        if (parentOpts.badge !== false && config.badge.enabled) {
          const badgeResult = injectBadge({
            projectRoot,
            verdict: reportData.globalVerdict,
            includeVerdict: (parentOpts.badgeVerdict as boolean | undefined) ?? config.badge.verdict,
            link: config.badge.link,
          });
          if (badgeResult.injected) {
            const verb = badgeResult.updated ? 'updated' : 'added';
            const hint = badgeResult.updated ? '' : ' (disable with --no-badge)';
            console.log(`  badge        ${chalk.green(verb)} in README.md${hint}`);
          }
        }
        });

        if (ctx.lockPath) releaseLock(ctx.lockPath);
        ctx.lockPath = undefined;
        });
        });
      } catch (error) {
        if (ctx.lockPath) releaseLock(ctx.lockPath);
        if (error instanceof AnatolyError) {
          console.error(`anatoly — ${error.formatForDisplay()}`);
        } else {
          console.error(`anatoly — error: ${String(error)}`);
        }
        process.exitCode = 2;
      } finally {
        flushFileLogger();
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
  depMeta?: DependencyMeta;
  projectTree?: string;
}

async function runSetupPhase(ctx: RunContext): Promise<SetupResult> {
  const log = getLogger();
  const rl = ctx.runLog;
  console.log(chalk.bold(`anatoly v${pkgVersion}`));

  let estimateFiles = 0;
  const triageMap = new Map<string, TriageResult>();
  let usageGraph: UsageGraph | undefined;
  let depMeta: DependencyMeta | undefined;
  let allTasks: Task[] = [];
  let projectTree: string | undefined;
  let scanFilesScanned = 0;

  const setupRunner = new Listr([
    {
      title: 'config',
      task: (_c: unknown, listrTask: { title: string }) => {
        const parts = [
          shortModelName(ctx.config.llm.model),
          `concurrency ${ctx.concurrency}`,
          `rag ${ctx.enableRag ? 'on' : 'off'}`,
          `cache ${ctx.noCache ? 'off' : 'on'}`,
          ...(ctx.deliberation ? [`deliberation ${shortModelName(ctx.config.llm.deliberation_model)}`] : []),
        ];
        if (ctx.fileFilter) parts.push(`filter ${ctx.fileFilter}`);
        parts.push(`run ${ctx.runId}`);

        listrTask.title = `config \u2014 ${parts.join(' \u00b7 ')}`;
        depMeta = loadDependencyMeta(ctx.projectRoot);
      },
    },
    {
      title: 'scan',
      task: async (_c: unknown, listrTask: { title: string; output: string }) => {
        const scanStart = Date.now();
        log.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
        rl?.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
        const scanResult = await scanProject(ctx.projectRoot, ctx.config);
        const scanDuration = Date.now() - scanStart;
        ctx.phaseDurations.scan = scanDuration;
        scanFilesScanned = scanResult.filesScanned;
        listrTask.title = `scan \u2014 ${scanResult.filesScanned} files`;
        const scanCompleted = { phase: 'scan', runId: ctx.runId, durationMs: scanDuration, filesScanned: scanResult.filesScanned };
        log.info(scanCompleted, 'phase completed');
        rl?.info(scanCompleted, 'phase completed');

        if (ctx.verbose) {
          listrTask.output = `${scanResult.filesNew} new / ${scanResult.filesCached} cached`;
          log.debug({ filesScanned: scanResult.filesScanned, filesNew: scanResult.filesNew, filesCached: scanResult.filesCached }, 'scan complete');
        }
      },
      rendererOptions: { persistentOutput: !!ctx.verbose },
    },
    {
      title: 'estimate',
      task: (_c: unknown, listrTask: { title: string }) => {
        const estStart = Date.now();
        log.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
        rl?.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
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
        ctx.phaseDurations.estimate = Date.now() - estStart;
        const estCompleted = { phase: 'estimate', runId: ctx.runId, durationMs: ctx.phaseDurations.estimate, totalTokens: estimate.inputTokens + estimate.outputTokens };
        log.info(estCompleted, 'phase completed');
        rl?.info(estCompleted, 'phase completed');
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
        const { inputTokens, outputTokens } = estimateTasksTokens(ctx.projectRoot, evalTasks);
        const timeLabel = ctx.concurrency > 1
          ? `~${triageMinutes} min (\u00d7${ctx.concurrency})`
          : `~${triageMinutes} min`;

        listrTask.title = `triage \u2014 ${tiers.skip} skip \u00b7 ${tiers.evaluate} evaluate \u00b7 ${formatTokenCount(inputTokens)} in / ${formatTokenCount(outputTokens)} out \u00b7 ${timeLabel}`;
        const triageSummary = { phase: 'triage', runId: ctx.runId, skip: tiers.skip, evaluate: tiers.evaluate, total: allTasks.length };
        log.info(triageSummary, 'triage summary');
        rl?.info(triageSummary, 'triage summary');
      },
    },
    {
      title: 'usage graph',
      task: (_c: unknown, listrTask: { title: string }) => {
        usageGraph = buildUsageGraph(ctx.projectRoot, allTasks);
        projectTree = buildProjectTree(allTasks.map((t) => t.file));
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

  return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree };
}

interface RagContext {
  vectorStore?: VectorStore;
  ragEnabled: boolean;
}

async function runRagPhase(ctx: RunContext, tasks: Task[]): Promise<RagContext> {
  if (!ctx.enableRag) return { ragEnabled: false };

  const log = getLogger();
  const rl = ctx.runLog;
  const ragStart = Date.now();
  log.info({ phase: 'rag-index', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'rag-index', runId: ctx.runId }, 'phase started');

  let ragResult: RagIndexResult | undefined;

  const embedLabel = EMBEDDING_MODEL;
  const ragRunner = new Listr([{
    title: `RAG index (${embedLabel})`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      ragResult = await indexProject({
        projectRoot: ctx.projectRoot,
        tasks,
        rebuild: ctx.rebuildRag,
        concurrency: ctx.concurrency,
        verbose: ctx.verbose,
        onLog: (msg) => { listrTask.output = msg; },
        onProgress: (current, total) => {
          listrTask.title = `RAG index (${embedLabel}) — ${current}/${total}`;
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
  const ragDuration = Date.now() - ragStart;
  ctx.phaseDurations['rag-index'] = ragDuration;

  if (ctx.interrupted) {
    console.log('interrupted — rag indexing incomplete');
    if (ctx.lockPath) { releaseLock(ctx.lockPath); ctx.lockPath = undefined; }
    return { ragEnabled: false };
  }

  const ragCompleted = {
    phase: 'rag-index', runId: ctx.runId, durationMs: ragDuration,
    cardsGenerated: ragResult?.cardsIndexed ?? 0, cached: (ragResult?.totalCards ?? 0) - (ragResult?.cardsIndexed ?? 0),
  };
  log.info(ragCompleted, 'phase completed');
  rl?.info(ragCompleted, 'phase completed');

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
  depMeta?: DependencyMeta,
  projectTree?: string,
): Promise<void> {
  const log = getLogger();
  const rl = ctx.runLog;
  const reviewStart = Date.now();
  log.info({ phase: 'review', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'review', runId: ctx.runId, concurrency: ctx.concurrency }, 'phase started');

  const pm = new ProgressManager(ctx.projectRoot);

  const progress = pm.getProgress();
  if (ctx.fileFilter) {
    // Explicit --file filter: always re-review matching files (implicit no-cache)
    const isMatch = picomatch(ctx.fileFilter);
    for (const [, fp] of Object.entries(progress.files)) {
      if (isMatch(fp.file) && (fp.status === 'DONE' || fp.status === 'CACHED')) {
        pm.updateFileStatus(fp.file, 'PENDING');
      }
    }
  } else if (ctx.noCache) {
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
  const total = reviewItems.length;
  const display = new ReviewProgressDisplay(evaluators.map((e) => e.id));

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
        if (display.hasActiveFiles) listrTask.output = display.render();
      }, 80);

      try {
      await runWorkerPool({
        items: reviewItems,
        concurrency: ctx.concurrency,
        isInterrupted: () => ctx.interrupted,
        handler: async (item, workerIndex) => {
          const { filePath, task } = item;
          await runWithContext({ file: filePath, worker: workerIndex }, async () => {
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
          display.trackFile(filePath);

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
                // Prepare streaming transcript path
                const logsDir = join(ctx.runDir, 'logs');
                mkdirSync(logsDir, { recursive: true });
                const logPath = join(logsDir, `${toOutputName(filePath)}.log`);

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
                  depMeta,
                  projectTree,
                  deliberation: ctx.deliberation,
                  onAxisComplete: (axisId) => {
                    display.markAxisDone(filePath, axisId);
                  },
                  onTranscriptChunk: (chunk) => {
                    appendFileSync(logPath, chunk);
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
                  if (!ctx.verbose) return;
                  const delaySec = (delayMs / 1000).toFixed(0);
                  display.setRetryMessage(filePath, `retrying in ${delaySec}s (${attempt}/5)`);
                  getLogger().debug({ file: filePath, attempt, delayMs }, 'rate limited, retrying');
                },
              },
            );

            writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
            writeTranscript(ctx.projectRoot, filePath, result.transcript, ctx.runDir);
            pm.updateFileStatus(filePath, 'DONE');
            ctx.filesReviewed++;
            ctx.reviewCounts.evaluated++;
            completedCount++;
            ctx.totalFindings += countReviewFindings(result.review, 60);
            ctx.totalCostUsd += result.costUsd;
            if (result.failedAxes.length > 0) {
              ctx.degradedReviews++;
            }
            for (const at of result.axisTiming) {
              const s = ctx.axisStats[at.axisId] ??= { calls: 0, totalDurationMs: 0, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };
              s.calls++;
              s.totalDurationMs += at.durationMs;
              s.totalCostUsd += at.costUsd;
              s.totalInputTokens += at.inputTokens;
              s.totalOutputTokens += at.outputTokens;
            }
            const reviewFields = {
              file: filePath,
              verdict: result.review.verdict,
              tier: triage?.tier ?? 'evaluate',
              costUsd: result.costUsd,
              durationMs: result.durationMs,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheCreationTokens: result.cacheCreationTokens,
            };
            log.debug(reviewFields, 'file review completed');
            ctx.runLog?.debug(reviewFields, 'file review completed');
          } catch (error) {
            if (ctx.interrupted) return;

            const message = error instanceof AnatolyError ? error.message : String(error);
            const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
            pm.updateFileStatus(filePath, errorCode === 'SDK_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
            ctx.errorCount++;
            ctx.errorsByCode[errorCode] = (ctx.errorsByCode[errorCode] ?? 0) + 1;
            log.error({ file: filePath, code: errorCode, err: error }, 'file review failed');
            ctx.runLog?.error({ file: filePath, code: errorCode, message }, 'file review failed');
            completedCount++;
          } finally {
            ctx.activeAborts.delete(currentAbort);
            display.untrackFile(filePath);
            updateTitle();
          }
          });
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

  const reviewDuration = Date.now() - reviewStart;
  ctx.phaseDurations.review = reviewDuration;
  const reviewCompleted = {
    phase: 'review', runId: ctx.runId, durationMs: reviewDuration,
    filesReviewed: ctx.filesReviewed, findings: ctx.totalFindings, concurrency: ctx.concurrency,
  };
  log.info(reviewCompleted, 'phase completed');
  rl?.info(reviewCompleted, 'phase completed');
}

function runReportPhase(ctx: RunContext): { globalVerdict: import('../schemas/review.js').Verdict } {
  const log = getLogger();
  const rl = ctx.runLog;
  const reportStart = Date.now();
  log.info({ phase: 'report', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'report', runId: ctx.runId }, 'phase started');

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
  console.log(`  log          ${chalk.cyan(resolve(ctx.runDir, 'anatoly.ndjson'))}`);

  if (ctx.shouldOpen) openFile(reportPath);

  const reportDuration = Date.now() - reportStart;
  ctx.phaseDurations.report = reportDuration;
  log.info({ phase: 'report', runId: ctx.runId, durationMs: reportDuration }, 'phase completed');
  rl?.info({ phase: 'report', runId: ctx.runId, durationMs: reportDuration }, 'phase completed');

  // Run summary
  const totalDurationMs = Date.now() - ctx.startTime;
  log.info({
    runId: ctx.runId, totalDurationMs, totalCostUsd: ctx.totalCostUsd,
    filesReviewed: ctx.filesReviewed, findings: ctx.totalFindings,
    cached: ctx.reviewCounts.skipped, skipped: ctx.reviewCounts.skipped,
    errors: ctx.errorCount,
  }, 'run completed');

  // Log error summary by code (if any errors occurred)
  if (ctx.errorCount > 0) {
    log.warn({ errorsByCode: ctx.errorsByCode, total: ctx.errorCount }, 'run error summary');
    rl?.warn({ errorsByCode: ctx.errorsByCode, total: ctx.errorCount }, 'run error summary');
  }

  // Write run summary to per-run log file
  ctx.runLog?.info({
    runId: ctx.runId, totalDurationMs, totalCostUsd: ctx.totalCostUsd,
    filesReviewed: ctx.filesReviewed, findings: ctx.totalFindings,
    errors: ctx.errorCount, errorsByCode: ctx.errorsByCode,
    phaseDurations: ctx.phaseDurations,
  }, 'run completed');

  // Write run-metrics.json
  const metrics = {
    runId: ctx.runId,
    durationMs: totalDurationMs,
    filesReviewed: ctx.filesReviewed,
    findings: ctx.totalFindings,
    errors: ctx.errorCount,
    errorsByCode: ctx.errorsByCode,
    degradedReviews: ctx.degradedReviews,
    costUsd: ctx.totalCostUsd,
    phaseDurations: ctx.phaseDurations,
    axisStats: ctx.axisStats,
  };
  try {
    writeFileSync(join(ctx.runDir, 'run-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  } catch {
    log.warn({ runId: ctx.runId }, 'failed to write run-metrics.json');
  }

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;

  return { globalVerdict: data.globalVerdict };
}
