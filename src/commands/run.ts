// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, relative } from 'node:path';
import chalk from 'chalk';
import picomatch from 'picomatch';
import { Listr } from 'listr2';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateTasksTokens, formatTokenCount, loadTasks, estimateFileSeconds, estimateMinutesWithConcurrency } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript } from '../core/review-writer.js';
import { generateReport, type TriageStats } from '../core/reporter.js';
import { AnatolyError } from '../utils/errors.js';
import { toOutputName } from '../utils/cache.js';
import { indexProject, type RagIndexResult, type RagMode } from '../rag/index.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, type ResolvedModels } from '../rag/hardware-detect.js';
import { ensureSidecar, stopSidecar } from '../rag/embed-sidecar.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns } from '../utils/run-id.js';
import { openFile } from '../utils/open.js';
import { getLogger, createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import type { Task } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import { triageFile, generateSkipReview, type TriageResult } from '../core/triage.js';
import { buildUsageGraph, type UsageGraph } from '../core/usage-graph.js';
import { loadDependencyMeta, type DependencyMeta } from '../core/dependency-meta.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import type { VectorStore } from '../rag/vector-store.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { buildProjectTree } from '../core/project-tree.js';
import { buildDocsTree } from '../core/docs-resolver.js';
import { ReviewProgressDisplay, countReviewFindings } from './review-display.js';
import { injectBadge } from '../core/badge.js';
import { parseAxesOption, warnDisabledAxes } from '../utils/axes-filter.js';
import { resolveAxisModel, type AxisId } from '../core/axis-evaluator.js';
import { printBanner } from '../utils/banner.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime, recalibrateFromRuns, saveCalibration } from '../core/calibration.js';

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
  ragMode: 'lite' | 'advanced' | 'auto';
  resolvedRagMode?: RagMode;
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
  dualEmbedding: boolean;
  resolvedModels?: ResolvedModels;
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
  /** CLI axes filter — restricts which axes are evaluated (intersection with config) */
  axesFilter?: AxisId[];
  /** Dry-run mode — show what would happen without executing reviews */
  dryRun: boolean;
  /** Badge config for post-report injection */
  badge: { enabled: boolean; verdict: boolean; link?: string };
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .option('--run-id <id>', 'custom run ID (alphanumeric, dashes, underscores)')
    .option('--axes <list>', 'comma-separated axes: utility,duplication,correction,overengineering,tests,best_practices')
    .option('--no-cache', 'ignore SHA-256 cache, re-review all files')
    .option('--file <glob>', 'restrict scope to matching files')
    .option('--concurrency <n>', 'number of concurrent reviews (1-10)', parseInt)
    .option('--no-rag', 'disable semantic RAG cross-file analysis')
    .option('--rag-lite', 'force lite RAG mode (Jina dual embedding)')
    .option('--rag-advanced', 'force advanced RAG mode (nomic-embed-code sidecar)')
    .option('--rebuild-rag', 'force full RAG re-indexation')
    .option('--code-model <model>', 'embedding model for code vectors (default: auto-detect)')
    .option('--nlp-model <model>', 'embedding model for NLP vectors (default: auto-detect)')
    .option('--no-triage', 'disable triage, review all files with full agent')
    .option('--deliberation', 'enable Opus deliberation pass after axis merge')
    .option('--no-deliberation', 'disable deliberation pass')
    .option('--no-badge', 'skip README badge injection after audit')
    .option('--badge-verdict', 'include audit verdict in README badge')
    .option('--open', 'open report in default app after generation')
    .option('--dry-run', 'simulate the run: scan, estimate, triage, then show what would happen')
    .option('--plain', 'disable log-update, linear sequential output')
    .option('--verbose', 'show detailed operation logs')
    .action(async (cmdOpts: { runId?: string; axes?: string }) => {
      const projectRoot = resolve('.');
      if (!existsSync(resolve(projectRoot, 'package.json'))) {
        console.error(`error: no package.json found in ${projectRoot}`);
        console.error('Are you at the root of your project?');
        process.exitCode = 2;
        return;
      }
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

      // Validate --lite / --advanced mutual exclusivity
      if (parentOpts.ragLite && parentOpts.ragAdvanced) {
        console.error('error: --rag-lite and --rag-advanced are mutually exclusive');
        process.exitCode = 2;
        return;
      }
      const ragMode: 'lite' | 'advanced' | 'auto' = parentOpts.ragLite ? 'lite'
        : parentOpts.ragAdvanced ? 'advanced'
        : 'auto';

      // CLI model overrides take precedence over config
      if (parentOpts.codeModel) config.rag.code_model = parentOpts.codeModel as string;
      if (parentOpts.nlpModel) config.rag.nlp_model = parentOpts.nlpModel as string;

      // Parse --axes filter (fail fast on invalid axis IDs)
      const axesResult = parseAxesOption(cmdOpts.axes);
      if (axesResult === null) return;
      const axesFilter: AxisId[] | undefined = axesResult;

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
        ragMode,
        rebuildRag: parentOpts.rebuildRag as boolean | undefined,
        shouldOpen: parentOpts.open as boolean | undefined,
        triageEnabled: parentOpts.triage !== false,
        deliberation: parentOpts.deliberation !== undefined
          ? parentOpts.deliberation as boolean
          : config.llm.deliberation ?? true,
        dualEmbedding: ragMode !== 'advanced',
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
        axesFilter,
        dryRun: parentOpts.dryRun as boolean ?? false,
        badge: {
          enabled: parentOpts.badge !== false && config.badge.enabled,
          verdict: (parentOpts.badgeVerdict as boolean | undefined) ?? config.badge.verdict,
          link: config.badge.link,
        },
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
        if (ctx.dryRun) return;
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings | ${formatDuration(Date.now() - ctx.startTime)}`);
          return;
        }

        ctx.lockPath = acquireLock(projectRoot);
        await runWithContext({ phase: 'rag-index' }, async () => {
        const ragContext = await runRagPhase(ctx, setup.tasks);
        if (ctx.interrupted) return;

        await runWithContext({ phase: 'review' }, async () => {
        await runReviewPhase(ctx, setup.triageMap, setup.usageGraph, ragContext, setup.depMeta, setup.projectTree, setup.docsTree);
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
        runReportPhase(ctx);
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
        await stopSidecar(); // no-op if already stopped after RAG phase
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

interface SetupTableData {
  project?: { name: string; version: string };
  config: { key: string; value: string }[];
  axes: { key: string; value: string }[];
  pipeline: { phase: string; detail: string }[];
}

function renderSetupTable(data: SetupTableData, plain: boolean): void {
  const checkPrefix = 2; // "✔ " visible chars prepended to pipeline phase
  // keyWidth must fit the longest key, including pipeline phases with their ✔ prefix
  const keyWidth = Math.max(
    ...data.config.map(r => r.key.length),
    ...data.axes.map(r => r.key.length),
    ...data.pipeline.map(r => r.phase.length + checkPrefix),
  );

  const allValues = [
    ...data.config.map(r => r.value),
    ...data.axes.map(r => r.value),
    ...data.pipeline.map(r => r.detail),
  ];
  const valWidth = Math.max(...allValues.map(v => v.length));

  const gap = 4; // spacing between key and value columns
  // inner width = 3 (left pad) + keyWidth + gap + valWidth + 2 (right pad)
  const innerWidth = 3 + keyWidth + gap + valWidth + 2;

  if (plain) {
    if (data.project) {
      console.log(chalk.dim('  Project Info'));
      console.log(`    ${'name'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.name}`);
      console.log(`    ${'version'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.version}`);
    }
    console.log(chalk.dim('  Configuration'));
    for (const r of data.config) console.log(`    ${r.key.padEnd(keyWidth)}${' '.repeat(gap)}${r.value}`);
    console.log(chalk.dim('  Evaluation Axes'));
    for (const r of data.axes) console.log(`    ${r.key.padEnd(keyWidth)}${' '.repeat(gap)}${r.value}`);
    console.log(chalk.dim('  Pipeline Summary'));
    for (const r of data.pipeline) console.log(`    \u2714 ${r.phase.padEnd(keyWidth)}${' '.repeat(gap)}${r.detail}`);
    console.log('');
    return;
  }

  const d = chalk.dim;
  const line = (char: string, n: number) => char.repeat(n);

  const sectionBorder = (label: string, color: (s: string) => string, left: string, right: string) => {
    const labelPart = ` ${label} `;
    const dashes = innerWidth - labelPart.length;
    return d(`  ${left}`) + color(labelPart) + d(`${line('\u2500', dashes)}${right}`);
  };

  const kvRow = (key: string, value: string) =>
    `  ${d('\u2502')}   ${key.padEnd(keyWidth)}${' '.repeat(gap)}${value.padEnd(valWidth)}  ${d('\u2502')}`;

  const checkMark = chalk.green('\u2714');
  // ✔ + space = checkPrefix visible chars; shrink phase pad to compensate
  const pipelineRow = (phase: string, detail: string) =>
    `  ${d('\u2502')}   ${checkMark} ${phase.padEnd(keyWidth - checkPrefix)}${' '.repeat(gap)}${detail.padEnd(valWidth)}  ${d('\u2502')}`;

  const emptyRow = `  ${d('\u2502')}${' '.repeat(innerWidth)}${d('\u2502')}`;

  // project info section
  if (data.project) {
    console.log(sectionBorder('Project Info', chalk.green, '\u250c', '\u2510'));
    console.log(emptyRow);
    console.log(kvRow('name', data.project.name));
    console.log(kvRow('version', data.project.version));
    console.log(emptyRow);

    // config section (connected to project info)
    console.log(sectionBorder('Configuration', chalk.cyan, '\u251c', '\u2524'));
  } else {
    // config section (top of box)
    console.log(sectionBorder('Configuration', chalk.cyan, '\u250c', '\u2510'));
  }
  console.log(emptyRow);
  for (const r of data.config) console.log(kvRow(r.key, r.value));
  console.log(emptyRow);

  // axes section
  console.log(sectionBorder('Evaluation Axes', chalk.magenta, '\u251c', '\u2524'));
  console.log(emptyRow);
  for (const r of data.axes) console.log(kvRow(r.key, r.value));
  console.log(emptyRow);

  // pipeline section
  console.log(sectionBorder('Pipeline Summary', chalk.blue, '\u251c', '\u2524'));
  console.log(emptyRow);
  for (const r of data.pipeline) console.log(pipelineRow(r.phase, r.detail));
  console.log(emptyRow);

  // bottom border
  console.log(d(`  \u2514${line('\u2500', innerWidth)}\u2518`));
  console.log('');
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.dim('  press enter to proceed '), () => {
      rl.close();
      resolve();
    });
  });
}

interface SetupResult {
  files: number;
  tasks: Task[];
  triageMap: Map<string, TriageResult>;
  usageGraph?: UsageGraph;
  depMeta?: DependencyMeta;
  projectTree?: string;
  docsTree?: string | null;
}

async function runSetupPhase(ctx: RunContext): Promise<SetupResult> {
  const log = getLogger();
  const rl = ctx.runLog;
  printBanner();

  let estimateFiles = 0;
  const triageMap = new Map<string, TriageResult>();
  let allTasks: Task[] = [];
  const configRows: { key: string; value: string }[] = [];
  const pipelineRows: { phase: string; detail: string }[] = [];

  // --- Read project info from package.json ---
  let projectInfo: { name: string; version: string } | undefined;
  try {
    const pkg = JSON.parse(readFileSync(resolve(ctx.projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
      projectInfo = { name: pkg.name, version: pkg.version };
    }
  } catch (err) {
    getLogger().debug({ err }, 'failed to read package.json for project info');
  }

  // --- Phase: config ---
  if (ctx.enableRag) {
    const hardware = detectHardware();

    if (ctx.ragMode === 'lite') {
      if (ctx.config.rag.code_model === 'auto') {
        ctx.config.rag.code_model = 'jinaai/jina-embeddings-v2-base-code';
      }
    }

    // Determine the effective RAG mode from CLI flags + hardware + readiness flag.
    // The sidecar is NOT started yet — that happens in runRagPhase.
    const embeddingsReady = readEmbeddingsReadyFlag(ctx.projectRoot);
    const canAdvanced = hardware.hasGpu && embeddingsReady !== null;
    const needsSidecar = ctx.ragMode === 'advanced'
      || (ctx.ragMode === 'auto' && canAdvanced && ctx.config.rag.code_model === 'auto');
    ctx.resolvedRagMode = needsSidecar ? 'advanced' : 'lite';
    ctx.dualEmbedding = ctx.resolvedRagMode === 'lite';

    rl?.info({
      hardware: {
        memoryGB: hardware.totalMemoryGB,
        cpuCores: hardware.cpuCores,
        gpu: hardware.hasGpu ? hardware.gpuType : 'none',
      },
      ragMode: ctx.resolvedRagMode,
    }, 'hardware detection');
  }

  const ragLabel = ctx.enableRag
    ? ctx.resolvedRagMode === 'advanced'
      ? `advanced — nomic-7B`
      : (ctx.dualEmbedding ? `lite — dual (jina + miniLM)` : `lite — jina`)
    : 'off';
  configRows.push(
    { key: 'concurrency', value: String(ctx.concurrency) },
    { key: 'rag', value: ragLabel },
    { key: 'cache', value: ctx.noCache ? 'off' : 'on' },
  );
  if (ctx.fileFilter) configRows.push({ key: 'filter', value: ctx.fileFilter });
  configRows.push({ key: 'run', value: ctx.runId });
  const depMeta = loadDependencyMeta(ctx.projectRoot);

  // --- Build axes rows (resolve model per axis) ---
  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  const axesRows: { key: string; value: string }[] = evaluators.map(e => ({
    key: e.id as string,
    value: shortModelName(resolveAxisModel(e, ctx.config)),
  }));
  if (ctx.deliberation) {
    axesRows.push({ key: 'deliberation', value: shortModelName(ctx.config.llm.deliberation_model) });
  }

  // --- Phase: scan ---
  const scanStart = Date.now();
  log.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
  const scanResult = await scanProject(ctx.projectRoot, ctx.config);
  const scanDuration = Date.now() - scanStart;
  ctx.phaseDurations.scan = scanDuration;
  pipelineRows.push({ phase: 'scan', detail: `${scanResult.filesScanned} files` });
  const scanCompleted = { phase: 'scan', runId: ctx.runId, durationMs: scanDuration, filesScanned: scanResult.filesScanned };
  log.info(scanCompleted, 'phase completed');
  rl?.info(scanCompleted, 'phase completed');
  if (ctx.verbose) {
    log.debug({ filesScanned: scanResult.filesScanned, filesNew: scanResult.filesNew, filesCached: scanResult.filesCached }, 'scan complete');
  }

  // --- Phase: estimate ---
  const estStart = Date.now();
  log.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
  allTasks = loadTasks(ctx.projectRoot);
  const estimateTasks = ctx.fileFilter
    ? allTasks.filter((t) => picomatch(ctx.fileFilter!)(t.file))
    : allTasks;
  const { inputTokens, outputTokens } = estimateTasksTokens(ctx.projectRoot, estimateTasks);
  estimateFiles = estimateTasks.length;
  // Estimate row is pushed after triage so we can include the calibrated ETA
  const estimateTokenLabel = `${estimateTasks.length} files \u00b7 ${formatTokenCount(inputTokens + outputTokens)} tokens`;
  ctx.phaseDurations.estimate = Date.now() - estStart;
  const estCompleted = { phase: 'estimate', runId: ctx.runId, durationMs: ctx.phaseDurations.estimate, totalTokens: inputTokens + outputTokens };
  log.info(estCompleted, 'phase completed');
  rl?.info(estCompleted, 'phase completed');

  // --- Phase: triage ---
  if (!ctx.triageEnabled) {
    pipelineRows.push({ phase: 'triage', detail: 'disabled (--no-triage)' });
  } else {
    const tiers = { skip: 0, evaluate: 0 };
    const triageTasks = ctx.fileFilter
      ? allTasks.filter((t) => picomatch(ctx.fileFilter!)(t.file))
      : allTasks;

    for (const task of triageTasks) {
      const absPath = resolve(ctx.projectRoot, task.file);
      let source: string;
      try {
        source = readFileSync(absPath, 'utf-8');
      } catch {
        triageMap.set(task.file, { tier: 'evaluate', reason: 'unreadable' });
        tiers.evaluate++;
        continue;
      }

      const result = triageFile(task, source);
      triageMap.set(task.file, result);
      tiers[result.tier]++;
    }

    pipelineRows.push({ phase: 'triage', detail: `${tiers.skip} skip \u00b7 ${tiers.evaluate} evaluate` });
    const triageSummary = { phase: 'triage', runId: ctx.runId, skip: tiers.skip, evaluate: tiers.evaluate, total: allTasks.length };
    log.info(triageSummary, 'triage summary');
    rl?.info(triageSummary, 'triage summary');
  }

  // --- Phase: RAG file count ---
  if (ctx.enableRag) {
    const ragFiles = allTasks.filter((t) =>
      t.symbols.some((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    ).length;
    pipelineRows.push({ phase: 'rag', detail: `${ragFiles} files` });
  }

  // --- Phase: usage graph ---
  const usageGraph = buildUsageGraph(ctx.projectRoot, allTasks);
  const projectTree = buildProjectTree(allTasks.map((t) => t.file));
  const docsTree = buildDocsTree(ctx.projectRoot, ctx.config.documentation?.docs_path ?? 'docs');
  pipelineRows.push({ phase: 'usage graph', detail: `${usageGraph.usages.size} edges` });

  // --- Calibrated ETA (merged into the estimate pipeline row) ---
  const calibration = loadCalibration(ctx.projectRoot);
  const activeAxes = evaluators.map(e => e.id);
  const evalFileCount = ctx.triageEnabled
    ? [...triageMap.values()].filter(t => t.tier === 'evaluate').length
    : estimateTasks.length;
  const calibratedMin = estimateCalibratedMinutes(calibration, evalFileCount, activeAxes, ctx.concurrency);
  const hasCal = Object.values(calibration.axes).some(a => a.samples > 0);
  const calLabel = hasCal ? 'calibrated' : 'default';
  pipelineRows.push({ phase: 'estimate', detail: `${estimateTokenLabel} · ${formatCalibratedTime(calibratedMin)} (${calLabel})` });

  // Render setup summary table
  renderSetupTable({ project: projectInfo, config: configRows, axes: axesRows, pipeline: pipelineRows }, ctx.plain);

  // Dry-run: show summary and exit before review
  if (ctx.dryRun) {
    const evalTasks = allTasks.filter((t) => triageMap.get(t.file)?.tier === 'evaluate');
    const { inputTokens, outputTokens } = estimateTasksTokens(ctx.projectRoot, allTasks);
    const seqSeconds = evalTasks.reduce((sum, t) => sum + estimateFileSeconds(t.symbols?.length ?? 0), 0);
    const estMinutes = estimateMinutesWithConcurrency(seqSeconds, ctx.concurrency);

    console.log('');
    console.log(chalk.bold('dry run') + ' — no files were reviewed');
    console.log('');
    console.log(`  files        ${allTasks.length}`);
    console.log(`  evaluate     ${evalTasks.length}`);
    console.log(`  skip         ${allTasks.length - evalTasks.length}`);
    console.log(`  tokens       ${formatTokenCount(inputTokens + outputTokens)}`);
    console.log(`  est. time    ~${estMinutes} min (concurrency ${ctx.concurrency})`);
    console.log('');
    return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree };
  }

  // Wait for confirmation before proceeding to review
  if (process.stdin.isTTY && !ctx.plain && !ctx.interrupted) {
    await waitForEnter();
  }

  ctx.allTasks = allTasks;
  ctx.triageMap = triageMap;

  return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree };
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

  // Spawn sidecar if advanced mode, resolve embedding models, then index
  const needsSidecar = ctx.resolvedRagMode === 'advanced';
  if (needsSidecar) {
    const logFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
    if (!ctx.plain && process.stdout.isTTY) {
      process.stdout.write(chalk.dim('  loading embed sidecar (nomic-embed-code 7B)...'));
      await ensureSidecar(logFn, (sec) => {
        process.stdout.write(`\r\x1b[K${chalk.dim(`  loading embed sidecar (nomic-embed-code 7B)... ${sec}s`)}`);
      });
      process.stdout.write('\r\x1b[K');
    } else {
      await ensureSidecar(logFn);
    }
  }

  // Resolve models now that sidecar may be running
  const hardware = detectHardware();
  const resolveLogFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
  ctx.resolvedModels = await resolveEmbeddingModels(ctx.config.rag, hardware, resolveLogFn);

  if (needsSidecar && ctx.resolvedModels.codeRuntime !== 'sidecar') {
    await stopSidecar();
    console.error('error: --rag-advanced requires the embed sidecar (nomic-embed-code)');
    console.error('  start manually: python scripts/embed-server.py');
    console.error('  or use --lite for Jina ONNX fallback');
    process.exitCode = 2;
    return { ragEnabled: false };
  }

  let ragResult: RagIndexResult | undefined;

  const codeModelShort = shortModelName(ctx.resolvedModels.codeModel);
  const nlpModelShort = shortModelName(ctx.resolvedModels.nlpModel);
  const embedLabel = ctx.dualEmbedding
    ? `${codeModelShort} + ${nlpModelShort}`
    : codeModelShort;
  const ragRunner = new Listr([{
    title: `RAG index (${embedLabel})`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      ragResult = await indexProject({
        projectRoot: ctx.projectRoot,
        tasks,
        rebuild: ctx.rebuildRag,
        concurrency: ctx.concurrency,
        verbose: ctx.verbose,
        dualEmbedding: ctx.dualEmbedding,
        indexModel: ctx.config.llm.index_model,
        resolvedModels: ctx.resolvedModels,
        ragMode: ctx.resolvedRagMode,
        onLog: (msg) => { listrTask.output = msg; },
        onProgress: (current, total) => {
          listrTask.title = `RAG index (${embedLabel}) — ${current}/${total}`;
        },
        isInterrupted: () => ctx.interrupted,
      });

      const dualLabel = ragResult.dualEmbedding ? ' (dual)' : '';
      listrTask.title = `RAG index${dualLabel} — ${ragResult.cardsIndexed} new / ${ragResult.totalCards} cards, ${ragResult.filesIndexed} new / ${ragResult.totalFiles} files`;
    },
    rendererOptions: { outputBar: 1 as const },
  }], {
    renderer: ctx.plain ? 'simple' : 'default',
    fallbackRenderer: 'simple',
  });

  await ragRunner.run();

  // Sidecar is only needed for embedding — free GPU memory immediately
  await stopSidecar();

  const ragDuration = Date.now() - ragStart;
  ctx.phaseDurations['rag-index'] = ragDuration;

  if (ctx.interrupted) {
    await stopSidecar();
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
  docsTree?: string | null,
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

  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  if (ctx.axesFilter) {
    warnDisabledAxes(ctx.axesFilter, evaluators.map((e) => e.id));
  }
  const evaluateTotal = ctx.triageEnabled
    ? reviewItems.filter((item) => triageMap.get(item.filePath)?.tier !== 'skip').length
    : reviewItems.length;
  const display = new ReviewProgressDisplay(evaluators.map((e) => e.id));

  const reviewRunner = new Listr([{
    title: `review — 0/${evaluateTotal}`,
    task: async (_c: unknown, listrTask: { title: string; output: string }) => {
      let completedCount = 0;

      const updateTitle = () => {
        const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
        listrTask.title = `review — ${completedCount}/${evaluateTotal}${findingsNote}`;
      };

      // Animate spinner while files are being processed (skip in plain mode to avoid console spam)
      const spinInterval = ctx.plain
        ? null
        : setInterval(() => {
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
            cacheReview(ctx.projectRoot, skipReview);
            pm.updateFileStatus(filePath, 'DONE');
            ctx.filesReviewed++;
            ctx.reviewCounts.skipped++;
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
                  docsTree,
                  deliberation: ctx.deliberation,
                  codeWeight: ctx.config.rag.code_weight,
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
            cacheReview(ctx.projectRoot, result.review);
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
            const symbolCount = task.symbols?.length ?? 0;
            const reviewFields = {
              file: filePath,
              verdict: result.review.verdict,
              tier: triage?.tier ?? 'evaluate',
              symbolCount,
              costUsd: result.costUsd,
              durationMs: result.durationMs,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheCreationTokens: result.cacheCreationTokens,
              axisTiming: result.axisTiming.map((at) => ({
                axisId: at.axisId,
                durationMs: at.durationMs,
                costUsd: at.costUsd,
                inputTokens: at.inputTokens,
                outputTokens: at.outputTokens,
              })),
            };
            log.debug(reviewFields, 'file review completed');
            ctx.runLog?.info(reviewFields, 'file review completed');
            if (ctx.plain) {
              const findings = countReviewFindings(result.review);
              const verdict = result.review.verdict;
              const dur = (result.durationMs / 1000).toFixed(1);
              const note = findings > 0 ? ` | ${findings} findings` : '';
              listrTask.output = `${filePath} → ${verdict}${note} (${dur}s)`;
            }
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
        if (spinInterval) clearInterval(spinInterval);
      }

      const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
      listrTask.title = `review — ${completedCount}/${evaluateTotal}${findingsNote}`;
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

function runReportPhase(ctx: RunContext): void {
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

  const runStats: import('../core/reporter.js').RunStats = {
    runId: ctx.runId,
    durationMs: Date.now() - ctx.startTime,
    costUsd: ctx.totalCostUsd,
    axisStats: ctx.axisStats,
    phaseDurations: ctx.phaseDurations,
    degradedReviews: ctx.degradedReviews,
  };
  // Copy cached reviews from previous run into current runDir so the report is complete.
  // Files with status CACHED have an unchanged SHA-256 — their .rev.json is still valid.
  copyCachedReviews(ctx.projectRoot, ctx.runDir, pm);

  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir, triageStats, runStats);

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
  const rel = (p: string) => relative(process.cwd(), p) || '.';
  console.log(`  report       ${chalk.cyan(rel(reportPath))}`);
  console.log(`  reviews      ${chalk.cyan(rel(resolve(ctx.runDir, 'reviews')) + '/')}`);
  console.log(`  transcripts  ${chalk.cyan(rel(resolve(ctx.runDir, 'logs')) + '/')}`);
  console.log(`  log          ${chalk.cyan(rel(resolve(ctx.runDir, 'anatoly.ndjson')))}`);
  if (ctx.badge.enabled) {
    const badgeResult = injectBadge({
      projectRoot: ctx.projectRoot,
      verdict: data.globalVerdict,
      includeVerdict: ctx.badge.verdict,
      link: ctx.badge.link,
    });
    if (badgeResult.injected && !badgeResult.updated) {
      console.log(`  badge        ${chalk.green('added')} in README.md (disable with --no-badge)`);
    }
  }
  console.log('');
  const costStr = `$${ctx.totalCostUsd.toFixed(2)}`;
  const costColor = ctx.totalCostUsd > 5 ? chalk.red.bold : ctx.totalCostUsd > 1 ? chalk.yellow.bold : chalk.green.bold;
  console.log(`  ${chalk.bold('Cost:')} ${costColor(costStr)} in API calls · ${chalk.green.bold('$0.00')} with Claude Code`);

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

  // Recalibrate axis timing from all historical runs (including this one)
  try {
    const updatedCalibration = recalibrateFromRuns(ctx.projectRoot);
    saveCalibration(ctx.projectRoot, updatedCalibration);
    log.debug({ calibration: updatedCalibration.axes }, 'calibration updated');
  } catch (err) {
    log.warn({ runId: ctx.runId, err }, 'failed to update calibration');
  }

  process.exitCode = data.globalVerdict === 'CLEAN' ? 0 : 1;

}

/**
 * Copy .rev.json files for CACHED files from the accumulative cache
 * into the current runDir/reviews directory.
 *
 * This ensures the report always reflects the full project state, not just
 * the files that were re-reviewed in this run.
 */
function copyCachedReviews(projectRoot: string, currentRunDir: string, pm: ProgressManager): void {
  const progress = pm.getProgress();
  const cachedFiles = Object.values(progress.files).filter((f) => f.status === 'CACHED');
  if (cachedFiles.length === 0) return;

  const cacheReviewsDir = resolve(projectRoot, '.anatoly', 'cache', 'reviews');
  const currentReviewsDir = join(currentRunDir, 'reviews');

  let copied = 0;
  for (const fp of cachedFiles) {
    const baseName = toOutputName(fp.file);
    const src = join(cacheReviewsDir, `${baseName}.rev.json`);
    const dst = join(currentReviewsDir, `${baseName}.rev.json`);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        copyFileSync(src, dst);
        copied++;
      } catch (err) {
        getLogger().debug({ src, err }, 'failed to copy cached review (non-fatal)');
      }
    }
  }

  if (copied > 0) {
    getLogger().info({ copied }, 'copied cached reviews into current run');
  }
}

/**
 * Persist a .rev.json into the accumulative cache directory.
 * Always overwrites — the latest review is the source of truth.
 */
function cacheReview(projectRoot: string, review: ReviewFile): void {
  const cacheReviewsDir = resolve(projectRoot, '.anatoly', 'cache', 'reviews');
  mkdirSync(cacheReviewsDir, { recursive: true });
  const baseName = toOutputName(review.file);
  const dst = join(cacheReviewsDir, `${baseName}.rev.json`);
  try {
    writeFileSync(dst, JSON.stringify(review, null, 2) + '\n');
  } catch (err) {
    getLogger().debug({ dst, err }, 'failed to cache review (non-fatal)');
  }
}
