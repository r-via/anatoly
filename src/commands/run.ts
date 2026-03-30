// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, createWriteStream, rmSync, cpSync, lstatSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, relative, basename } from 'node:path';
import chalk from 'chalk';
import picomatch from 'picomatch';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { scanProject } from '../core/scanner.js';
import { estimateTasksTokens, formatTokenCount, loadTasks, estimateFileSeconds } from '../core/estimator.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime, recalibrateFromRuns, saveCalibration } from '../core/calibration.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript, renderReviewMarkdown } from '../core/review-writer.js';
import { generateReport, loadReviews, axisHealthPercent, REPORT_AXIS_IDS, type TriageStats, type ReportAxisId } from '../core/reporter.js';
import { sendNotifications, type NotificationPayload } from '../core/notifications/index.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { toOutputName } from '../utils/cache.js';
import { indexProject, type RagIndexResult, type RagMode, smartChunkAndCache, indexDocSections, countChangedDocs } from '../rag/index.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, determineBackend, type ResolvedModels, type EmbeddingBackend } from '../rag/hardware-detect.js';
import { startGgufContainers, stopGgufContainers } from '../rag/docker-gguf.js';
import { stopTeiContainers } from '../rag/docker-tei.js';
import { generateRunId, isValidRunId, createRunDir, purgeRuns, listRuns } from '../utils/run-id.js';
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
import { countReviewFindings } from '../utils/format.js';
import { loadUserInstructions } from '../utils/user-instructions.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';
import { injectBadge } from '../core/badge.js';
import { runDocScaffold, runDocGeneration, type DocPipelineResult } from '../core/doc-pipeline.js';
import { aggregateDocReport, type DocReportResult } from '../core/doc-report-aggregator.js';
import { parseAxesOption, warnDisabledAxes } from '../utils/axes-filter.js';
import { checkGeminiAuth } from '../utils/gemini-auth.js';
import { saveDeliberationMemory, recordReclassification } from '../core/correction-memory.js';
import { resolveAxisModel, resolveCodeSummaryModel, resolveDeliberationModel, runSingleTurnQuery, buildProviderStats, type AxisId } from '../core/axis-evaluator.js';
import { TransportRouter, findModelForProvider } from '../core/transports/index.js';
import { AnthropicTransport } from '../core/transports/anthropic-transport.js';
import { GeminiTransport } from '../core/transports/gemini-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import { DeliberationResponseSchema, type DeliberationResponse } from '../core/deliberation.js';
import { extractJson } from '../utils/extract-json.js';
import { printBanner } from '../utils/banner.js';
import { renderSetupTable, shortModelName, type SetupTableData } from '../cli/setup-table.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine, type ProjectProfile } from '../core/language-detect.js';
import { autoFixStructuralIssues, executeDocPrompts, reviewDocStructure, runDocCoherenceReview, type DocExecutor } from '../core/doc-llm-executor.js';
import { needsBootstrap } from '../core/doc-bootstrap.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runRefinementPhase, type RefinementResult } from '../core/refinement/phase.js';

/**
 * Mutable context bag threaded through every phase of a single `run` command
 * invocation. Populated incrementally during setup and consumed by review,
 * report, and doc-generation phases.
 */
interface RunContext {
  /** Absolute path to the project being audited */
  projectRoot: string;
  /** Parsed anatoly configuration (anatoly.config.json) */
  config: Config;
  /** Unique identifier for this run (timestamp-based or user-supplied) */
  runId: string;
  /** Absolute path to the run output directory (.anatoly/runs/<runId>) */
  runDir: string;
  /** Maximum number of files to review in parallel */
  concurrency: number;
  /** Disable colour/ANSI output */
  plain: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Glob pattern to restrict reviewed files */
  fileFilter?: string;
  /** Skip review cache — re-evaluate all files */
  noCache: boolean;
  /** Whether RAG indexing is enabled */
  enableRag: boolean;
  /** User-requested RAG mode from CLI */
  ragMode: 'lite' | 'advanced' | 'auto';
  /** Actual RAG mode resolved after hardware detection */
  resolvedRagMode?: RagMode;
  /** Force full RAG index rebuild */
  rebuildRag?: boolean;
  /** Open the report in the browser after completion */
  shouldOpen?: boolean;
  /** Whether triage skip-tier logic is active */
  triageEnabled: boolean;
  /** Set to true on SIGINT to request graceful shutdown */
  interrupted: boolean;
  /** Path to the run lock file (prevents concurrent runs) */
  lockPath?: string;
  /** Active AbortControllers for in-flight SDK calls (aborted on SIGINT) */
  activeAborts: Set<AbortController>;
  /** Running count of files successfully reviewed */
  filesReviewed: number;
  /** Running total of findings across all reviewed files */
  totalFindings: number;
  /** Total number of files discovered during scanning */
  totalFiles: number;
  /** Count of skipped (cached) vs evaluated files */
  reviewCounts: { skipped: number; evaluated: number };
  /** Epoch timestamp when the run started */
  startTime: number;
  /** All loaded tasks — set during setup phase, used in report phase for time estimation */
  allTasks: Task[];
  /** Triage map — set during setup phase, used in report phase for estimatedTimeSaved */
  triageMap: Map<string, TriageResult>;
  /** Whether multi-axis deliberation is enabled */
  deliberation: boolean;
  /** Resolved model IDs for each axis (set after calibration) */
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
  axisStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
  /** Per-provider call counts and cost (Story 39.2) */
  providerStats: { anthropic: { calls: number; costUsd: number }; gemini: { calls: number; costUsd: number } };
  /** Timeline of key events for run-metrics.json (phase + file level) */
  timeline: Array<{ t: number; event: string; [k: string]: unknown }>;
  /** Per-run file logger (writes to <runDir>/anatoly.ndjson) */
  runLog?: import('../utils/logger.js').Logger;
  /** CLI axes filter — restricts which axes are evaluated (intersection with config) */
  axesFilter?: AxisId[];
  /** Dry-run mode — show what would happen without executing reviews */
  dryRun: boolean;
  /** Badge config for post-report injection */
  badge: { enabled: boolean; verdict: boolean; link?: string };
  /** Pipeline display state — created after setup, shared across rag/review/report */
  pipelineState?: PipelineState;
  /** Screen renderer — created after setup */
  renderer?: ScreenRenderer;
  /** Whether this is a first run requiring bootstrap doc phase */
  isFirstRun: boolean;
  /** Unified project profile — set during setup, used by doc pipeline */
  profile?: ProjectProfile;
  /** Doc pipeline result — set after doc scaffold + generation phases */
  docPipelineResult?: DocPipelineResult;
  /** Doc report result — set during report phase */
  docReportResult?: DocReportResult;
  /** True when docs/ and .anatoly/docs/ were identical at RAG indexing time */
  docsIdentical: boolean;
  /** Mode-aware transport router for LLM call routing */
  router?: TransportRouter;
  /** User instructions from ANATOLY.md — loaded once per run */
  userInstructions?: import('../utils/user-instructions.js').UserInstructions;
}

/**
 * Registers the `run` CLI sub-command on the given Commander program.
 *
 * The `run` command executes the full audit pipeline: scan, estimate, triage,
 * review (parallel axis evaluation), and report generation, with optional RAG
 * indexing and doc-generation phases. Handles SIGINT graceful shutdown and
 * interactive re-run prompting.
 *
 * @param program The root Commander instance to attach the command to.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .option('--run-id <id>', 'custom run ID (alphanumeric, dashes, underscores)')
    .option('--axes <list>', 'comma-separated axes: utility,duplication,correction,overengineering,tests,best_practices')
    .option('--no-cache', 'ignore SHA-256 cache, re-review all files')
    .option('--file <glob>', 'restrict scope to matching files')
    .option('--concurrency <n>', 'number of concurrent reviews (1-10)', parseInt)
    .option('--sdk-concurrency <n>', 'max concurrent SDK calls (1-20)', parseInt)
    .option('--no-rag', 'disable semantic RAG cross-file analysis')
    .option('--rag-lite', 'force lite RAG mode (Jina dual embedding)')
    .option('--rag-advanced', 'force advanced RAG mode (GGUF Docker GPU)')
    .option('--rebuild-rag', 'force full RAG re-indexation')
    .option('--code-model <model>', 'embedding model for code vectors (default: auto-detect)')
    .option('--nlp-model <model>', 'embedding model for NLP vectors (default: auto-detect)')
    .option('--no-triage', 'disable triage, review all files with full agent')
    .option('--deliberation', 'enable Opus deliberation pass after axis merge')
    .option('--no-deliberation', 'disable deliberation pass')
    .option('--no-badge', 'skip README badge injection after audit')
    .option('--badge-verdict', 'include audit verdict in README badge')
    .option('--open', 'open report in default app after generation')
    .option('--flush-memory', 'clear deliberation memory before running (fresh start)')
    .option('--dry-run', 'simulate the run: scan, estimate, triage, then show what would happen')
    .option('--plain', 'disable log-update, linear sequential output')
    .option('--verbose', 'show detailed operation logs')
    .action(async (cmdOpts: { runId?: string; axes?: string; flushMemory?: boolean }) => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const cliConcurrency = parentOpts.concurrency as number | undefined;
      const concurrency = cliConcurrency ?? config.runtime.concurrency;

      if (concurrency < 1 || concurrency > 10 || !Number.isInteger(concurrency)) {
        console.error('error: --concurrency must be between 1 and 10');
        process.exitCode = 2;
        return;
      }

      const cliSdkConcurrency = parentOpts.sdkConcurrency as number | undefined;
      if (cliSdkConcurrency !== undefined) {
        if (cliSdkConcurrency < 1 || cliSdkConcurrency > 20 || !Number.isInteger(cliSdkConcurrency)) {
          console.error('error: --sdk-concurrency must be between 1 and 20');
          process.exitCode = 2;
          return;
        }
        if (config.providers.anthropic) {
          config.providers.anthropic.concurrency = cliSdkConcurrency;
        }
      }

      const runId = cmdOpts.runId ?? generateRunId();
      if (cmdOpts.runId && !isValidRunId(cmdOpts.runId)) {
        console.error(`anatoly — error: invalid --run-id "${cmdOpts.runId}" (use alphanumeric, dashes, underscores)`);
        process.exitCode = 2;
        return;
      }

      // Warn about empty (phantom) runs
      const runsDir = resolve(projectRoot, '.anatoly', 'runs');
      const existingRuns = listRuns(projectRoot);
      const emptyRunCount = existingRuns.filter((id) => {
        try { return readdirSync(join(runsDir, id, 'reviews')).length === 0; } catch { return true; }
      }).length;
      if (emptyRunCount > 0) {
        console.log(chalk.dim(`${emptyRunCount} empty audit(s) in .anatoly/runs/ — run ${chalk.bold('anatoly audit remove --empty')} to clean up`));
        console.log('');
      }

      const dryRun = parentOpts.dryRun as boolean ?? false;
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

      // Flush deliberation memory if requested
      if (cmdOpts.flushMemory) {
        saveDeliberationMemory(projectRoot, { version: 2, false_positives: [] });
        console.log(chalk.dim('deliberation memory flushed'));
      }

      // Validate Google provider auth — fail fast if misconfigured
      if (config.providers.google) {
        const google = config.providers.google;
        if (google.mode === 'subscription') {
          const googleModel = findModelForProvider(config, 'google') ?? 'google/gemini-2.5-flash';
          const authOk = await checkGeminiAuth(projectRoot, googleModel);
          if (!authOk) {
            throw new AnatolyError(
              'Google provider configured (subscription) but auth failed.',
              ERROR_CODES.PROVIDER_AUTH_FAILED,
              false,
              'run `gemini auth login` first',
            );
          }
        } else if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
          throw new AnatolyError(
            'Google provider configured (api) but neither GOOGLE_GENERATIVE_AI_API_KEY nor GOOGLE_API_KEY is set.',
            ERROR_CODES.PROVIDER_AUTH_FAILED,
            false,
            'set GOOGLE_GENERATIVE_AI_API_KEY in your environment',
          );
        }
      }

      // Build mode-aware transport router
      const googleEnabled = !!config.providers.google;
      const _nativeTransports: Record<string, import('../core/transports/index.js').LlmTransport> = {
        anthropic: new AnthropicTransport(),
      };
      if (googleEnabled) {
        const _geminiModel = findModelForProvider(config, 'google') ?? 'google/gemini-2.5-flash';
        _nativeTransports.google = new GeminiTransport(projectRoot, _geminiModel);
      }
      const _providerModes: Record<string, import('../core/transports/index.js').ProviderModeConfig> = {};
      for (const [id, prov] of Object.entries(config.providers)) {
        if (prov) _providerModes[id] = { mode: prov.mode, single_turn: prov.single_turn, agents: prov.agents };
      }
      const _router = new TransportRouter({
        nativeTransports: _nativeTransports,
        vercelSdkTransport: new VercelSdkTransport(config),
        providerModes: _providerModes,
      });

      const _userInstructions = loadUserInstructions(projectRoot);

      const ctx: RunContext = {
        projectRoot,
        config,
        runId,
        runDir: dryRun ? '' : createRunDir(projectRoot, runId),
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
          : config.agents.enabled,
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
        providerStats: { anthropic: { calls: 0, costUsd: 0 }, gemini: { calls: 0, costUsd: 0 } },
        timeline: [],
        axesFilter,
        dryRun,
        badge: {
          enabled: parentOpts.badge !== false && config.badge.enabled,
          verdict: (parentOpts.badgeVerdict as boolean | undefined) ?? config.badge.verdict,
          link: config.badge.link,
        },
        isFirstRun: false,
        docsIdentical: false,
        router: _router,
        userInstructions: _userInstructions.hasInstructions ? _userInstructions : undefined,
      };

      // Raise max listeners to account for concurrent SDK subprocess exit handlers
      // and gemini-cli-core Config instances that each add a model-changed listener
      const maxConcurrency = Math.max(config.providers.anthropic?.concurrency ?? 24, config.providers.google?.concurrency ?? 0);
      process.setMaxListeners(Math.max(process.getMaxListeners(), maxConcurrency + 10));
      try {
        const { coreEvents } = await import('@google/gemini-cli-core');
        coreEvents.setMaxListeners(Math.max(coreEvents.getMaxListeners(), maxConcurrency + 10));
      } catch { /* gemini-cli-core not installed — no-op */ }

      // Create per-run ndjson log file at debug level (skip in dry-run)
      if (!ctx.dryRun) {
        const runLogPath = join(ctx.runDir, 'anatoly.ndjson');
        ctx.runLog = createFileLogger(runLogPath);
        ctx.runLog.info({ runId, concurrency, projectRoot }, 'run started');

        // Dump run configuration for traceability
        const runConfig = {
          runId,
          timestamp: new Date().toISOString(),
          projectRoot,
          concurrency,
          ragMode: ctx.ragMode,
          enableRag: ctx.enableRag,
          noCache: ctx.noCache,
          rebuildRag: ctx.rebuildRag,
          deliberation: ctx.deliberation,
          dryRun: ctx.dryRun,
          axesFilter: ctx.axesFilter ?? null,
          fileFilter: ctx.fileFilter ?? null,
          badge: ctx.badge,
          config: {
            providers: ctx.config.providers,
            models: ctx.config.models,
            agents: ctx.config.agents,
            runtime: ctx.config.runtime,
            axes: ctx.config.axes,
            rag: ctx.config.rag,
            scan: ctx.config.scan,
          },
        };
        writeFileSync(join(ctx.runDir, 'run-config.json'), JSON.stringify(runConfig, null, 2));
      }

      const onSigint = async () => {
        if (ctx.interrupted) {
          try { await stopGgufContainers(); } catch { /* best-effort */ }
          try { await stopTeiContainers(); } catch { /* best-effort */ }
          flushFileLogger();
          console.log(`\n${chalk.red.bold('force exit')}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          process.exit(1);
        }
        ctx.interrupted = true;
        ctx.renderer?.stop();
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

        // Detect first run — Story 29.21
        ctx.isFirstRun = needsBootstrap(ctx.projectRoot);

        // Initialize pipeline display
        const pipelineState = new PipelineState();
        if (ctx.router) {
          pipelineState.setRouter(ctx.router);
        }
        if (ctx.isFirstRun) {
          pipelineState.addTask('bootstrap-doc', 'First run');
        }
        if (ctx.enableRag) {
          pipelineState.addTask('rag-code', 'Embedding code');
          pipelineState.addTask('rag-nlp', 'LLM summaries & embedding');
          pipelineState.addTask('rag-doc-project', 'Chunking & embedding project docs');
          pipelineState.addTask('rag-doc-internal', 'Chunking & embedding internal docs');
        }
        pipelineState.addTask('review', 'Reviewing files');
        if (ctx.deliberation) {
          pipelineState.addTask('refinement', 'Refinement — auto-resolve & verify');
        }
        pipelineState.addTask('internal-docs', 'Updating internal docs');
        pipelineState.addTask('report', 'Generating report');
        ctx.pipelineState = pipelineState;

        const renderer = new ScreenRenderer(pipelineState, { plain: ctx.plain });
        ctx.renderer = renderer;
        renderer.start();

        ctx.lockPath = acquireLock(projectRoot);

        // --- Phase: bootstrap doc (first run only) — Story 29.21 ---
        if (ctx.isFirstRun && !ctx.interrupted) {
          await runWithContext({ phase: 'bootstrap-doc' }, async () => {
            await runDocBootstrap(ctx, setup.tasks);
          });
        }

        await runWithContext({ phase: 'rag-index' }, async () => {
        const ragContext = await runRagPhase(ctx, setup.tasks);
        if (ctx.interrupted) return;

        // --- Phase: review (pass 1) ---
        await runWithContext({ phase: 'review' }, async () => {
        await runReviewPhase(ctx, setup.triageMap, setup.usageGraph, ragContext, setup.depMeta, setup.projectTree, setup.docsTree, setup.internalDocsTree, setup.internalDocsDir);
        });
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote} | ${formatDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        // --- Phase: refinement (tier 1 → tier 2 → tier 3) — Story 41.5 ---
        if (ctx.deliberation && ctx.filesReviewed > 0 && !ctx.interrupted) {
          await runWithContext({ phase: 'refinement' }, async () => {
            const refinementStart = Date.now();
            ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'refinement' });
            ctx.pipelineState?.setPhase('refinement');
            ctx.pipelineState?.startTask('refinement', 'Tier 1 — auto-resolve');

            const refinementResult = await runRefinementPhase({
              projectRoot: ctx.projectRoot,
              runDir: ctx.runDir,
              config: ctx.config,
              usageGraph: setup.usageGraph,
              fileContents: new Map(), // Tier 1 reads files on demand
              preResolvedRag: new Map(), // RAG results are per-file, not cached globally
              abortController: (() => { const ac = new AbortController(); ctx.activeAborts.add(ac); return ac; })(),
              deliberation: ctx.deliberation,
              plain: ctx.plain,
              loadReviewsFn: (pr, rd) => loadReviews(pr, rd),
              writeReviewFn: (review) => writeReviewOutput(ctx.projectRoot, review, ctx.runDir),
              queryFn: async (params) => {
                const start = Date.now();
                const shardId = `tier3-shard-${Date.now()}`;
                const slot = await ctx.router?.acquireSlot(params.model);
                let success = false;
                try {
                  const q = query({
                    prompt: params.userMessage,
                    options: {
                      systemPrompt: params.systemPrompt,
                      model: params.model,
                      cwd: params.projectRoot,
                      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
                      permissionMode: 'bypassPermissions' as const,
                      allowDangerouslySkipPermissions: true,
                      abortController: params.abortController,
                    },
                  });

                  let resultText = '';
                  let costUsd = 0;
                  let inputTokens = 0;
                  let outputTokens = 0;
                  let cacheReadTokens = 0;
                  let cacheCreationTokens = 0;

                  for await (const message of q) {
                    if (message.type === 'result') {
                      if (message.subtype === 'success') {
                        resultText = (message as { result: string }).result;
                        costUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
                      } else {
                        const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
                        throw new Error(`Tier 3 SDK error [${message.subtype}]: ${errMsg}`);
                      }
                    }
                    if (message.type === 'usage') {
                      const u = (message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
                      if (u) {
                        inputTokens += u.input_tokens ?? 0;
                        outputTokens += u.output_tokens ?? 0;
                        cacheReadTokens += u.cache_read_input_tokens ?? 0;
                        cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
                      }
                    }
                  }

                  // Extract JSON from the agentic response
                  const jsonStr = extractJson(resultText);
                  if (!jsonStr) {
                    throw new Error('Tier 3: no valid JSON found in agentic response');
                  }
                  const parsed = DeliberationResponseSchema.parse(JSON.parse(jsonStr));

                  // Dump tier 3 conversation transcript
                  try {
                    const convDir = join(ctx.runDir, 'conversations');
                    mkdirSync(convDir, { recursive: true });
                    const durationMs = Date.now() - start;
                    const log = [
                      `# Tier 3 Investigation — ${shardId}`,
                      '',
                      `| Field | Value |`,
                      `|-------|-------|`,
                      `| Model | ${params.model} |`,
                      `| Duration | ${(durationMs / 1000).toFixed(1)}s |`,
                      `| Cost | $${costUsd.toFixed(4)} |`,
                      `| Input tokens | ${inputTokens} |`,
                      `| Output tokens | ${outputTokens} |`,
                      `| Timestamp | ${new Date().toISOString()} |`,
                      '',
                      '## System',
                      '',
                      params.systemPrompt,
                      '',
                      '## User',
                      '',
                      params.userMessage,
                      '',
                      '## Agent Response',
                      '',
                      resultText,
                    ].join('\n');
                    writeFileSync(join(convDir, `${shardId}.md`), log);
                  } catch {
                    // non-critical
                  }

                  success = true;
                  return {
                    data: parsed,
                    costUsd,
                    durationMs: Date.now() - start,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheCreationTokens,
                    transcript: resultText,
                  };
                } finally {
                  slot?.release({ success });
                }
              },
              recordFn: (pr, entry) => recordReclassification(pr, entry),
              onProgress: (event, detail) => {
                const state = ctx.pipelineState;
                if (!state) return;
                switch (event) {
                  case 'tier1-done':
                    state.updateTask('refinement', `Tier 1 done (${detail})`);
                    state.relabelTask('refinement', 'Tier 2 — coherence');
                    break;
                  case 'tier2-done':
                    state.updateTask('refinement', `Tier 2 done (${detail})`);
                    state.relabelTask('refinement', 'Tier 3 — investigation');
                    break;
                  case 'tier3-shard':
                    state.updateTask('refinement', `Tier 3 — ${detail}`);
                    break;
                  case 'tier3-done':
                    state.completeTask('refinement', `Done — ${detail}`);
                    break;
                }
                // Plain mode sequential logging (use logPlain to bypass console.log suppression)
                if (ctx.plain && event === 'tier3-shard') {
                  ctx.renderer?.logPlain(`[refinement]   ${detail}`);
                }
                if (ctx.plain && event.endsWith('-done')) {
                  const tier = event.replace('-done', '');
                  ctx.renderer?.logPlain(`[refinement] \u2714 ${tier} — ${detail}`);
                }
              },
            });

            const refinementDuration = Date.now() - refinementStart;
            ctx.phaseDurations.refinement = refinementDuration;
            ctx.totalCostUsd += refinementResult.totalCostUsd;
            ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'refinement', durationMs: refinementDuration });

            // Update findings counter to reflect post-refinement net
            const totalResolved = refinementResult.tier1Stats.resolved
              + refinementResult.tier2Stats.resolved
              + refinementResult.tier3Stats.reclassified;
            ctx.totalFindings = Math.max(0, ctx.totalFindings - totalResolved);

            // Count tier 3 Claude SDK calls in provider stats
            if (refinementResult.tier3Stats.investigated > 0) {
              ctx.providerStats.anthropic.calls += refinementResult.tier3Stats.investigated;
              ctx.providerStats.anthropic.costUsd += refinementResult.totalCostUsd;
            }

            getLogger().info({
              phase: 'refinement',
              tier1Resolved: refinementResult.tier1Stats.resolved,
              tier2Resolved: refinementResult.tier2Stats.resolved,
              tier2Escalated: refinementResult.tier2Stats.escalated,
              tier3Investigated: refinementResult.tier3Stats.investigated,
              tier3Reclassified: refinementResult.tier3Stats.reclassified,
              totalResolved,
              costUsd: refinementResult.totalCostUsd,
              durationMs: refinementDuration,
            }, 'refinement phase complete');
          });
        } else if (!ctx.interrupted && ctx.filesReviewed > 0) {
          ctx.pipelineState?.completeTask('refinement', 'skipped — deliberation disabled');
        }

        // --- Phase: update internal docs — Story 29.21 ---
        // Skip when no files were reviewed (nothing changed → docs are still current)
        if (!ctx.interrupted && ctx.filesReviewed > 0) {
          await runWithContext({ phase: 'internal-docs' }, async () => {
            await runDocUpdate(ctx, setup.tasks);
          });

          // Re-index doc sections that changed after the doc-update pipeline.
          // Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate
          // chunk cache → restart embedding containers → re-embed + upsert → stop.
          if (ctx.enableRag && ctx.resolvedRagMode && ragContext.vectorStore) {
            await reindexDocsAfterUpdate(ctx, ragContext.vectorStore);
          }
        } else if (!ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'skipped — no files reviewed');
        }

        // --- Phase: sync project docs (dedup mode only) ---
        if (!ctx.interrupted && ctx.docsIdentical) {
          ctx.pipelineState?.insertTaskBefore('report', 'sync-project-docs', 'Synchronising project docs');
          syncProjectDocsFromInternal(ctx);
        }

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
        ctx.renderer?.stop();
        await stopGgufContainers(); // no-op if no containers running
        await stopTeiContainers(); // no-op if no containers running
        flushFileLogger();
        process.removeListener('SIGINT', onSigint);
      }
    });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.dim('  press enter to proceed '), () => {
      rl.close();
      // Clear entire screen, move cursor to top, reprint the MOTD banner
      process.stdout.write('\x1b[2J\x1b[H');
      console.log('');
      printBanner('The weight is good !');
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
  internalDocsTree?: string | null;
  internalDocsDir?: string;
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
  let projectInfo: { name: string; version: string; languages?: string; frameworks?: string } | undefined;
  try {
    const pkg = JSON.parse(readFileSync(resolve(ctx.projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
      projectInfo = { name: pkg.name, version: pkg.version };
    }
  } catch (err) {
    getLogger().debug({ err }, 'failed to read package.json for project info');
  }

  // Detect languages & frameworks for project info display
  const profile = detectProjectProfile(ctx.projectRoot);
  ctx.profile = profile;
  const langLine = formatLanguageLine(profile.languages.languages);
  const fwLine = formatFrameworkLine(profile.frameworks);
  if (!projectInfo && (langLine || fwLine)) {
    projectInfo = { name: basename(ctx.projectRoot), version: '\u2014' };
  }
  if (projectInfo) {
    if (langLine) projectInfo.languages = langLine;
    if (fwLine) projectInfo.frameworks = fwLine;
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
    // Embedding containers are NOT started yet — that happens in runRagPhase.
    const embeddingsReady = readEmbeddingsReadyFlag(ctx.projectRoot);
    const canAdvanced = hardware.hasGpu && embeddingsReady !== null;
    const needsSidecar = ctx.ragMode === 'advanced'
      || (ctx.ragMode === 'auto' && canAdvanced && ctx.config.rag.code_model === 'auto');
    ctx.resolvedRagMode = needsSidecar ? 'advanced' : 'lite';

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
    ? ctx.resolvedRagMode === 'advanced' ? 'advanced' : 'lite'
    : 'off';
  configRows.push(
    { key: 'concurrency', value: `${ctx.concurrency} files · ${ctx.config.providers.google ? `${ctx.config.providers.anthropic?.concurrency ?? 24} Claude + ${ctx.config.providers.google.concurrency} Gemini slots` : `${ctx.config.providers.anthropic?.concurrency ?? 24} Claude slots`}` },
    { key: 'rag', value: ragLabel },
    { key: 'cache', value: ctx.noCache ? 'off' : 'on' },
  );
  if (ctx.fileFilter) configRows.push({ key: 'filter', value: ctx.fileFilter });
  configRows.push({ key: 'run', value: ctx.runId });
  const depMeta = loadDependencyMeta(ctx.projectRoot);

  // --- Build models rows (left: axes, right: embeddings/chunking/summarization) ---
  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  const modelsLeft: { key: string; value: string }[] = evaluators.map(e => ({
    key: e.id as string,
    value: shortModelName(resolveAxisModel(e, ctx.config)),
  }));
  if (ctx.deliberation) {
    modelsLeft.push({ key: 'deliberation', value: shortModelName(resolveDeliberationModel(ctx.config)) });
  }
  const modelsRight: { key: string; value: string }[] = [];
  if (ctx.enableRag) {
    if (ctx.resolvedRagMode === 'advanced') {
      modelsRight.push({ key: 'embeddings/code', value: 'nomic-embed-code Q5_K_M' });
      modelsRight.push({ key: 'embeddings/nlp', value: 'Qwen3-8B Q5_K_M' });
    } else {
      modelsRight.push({ key: 'embeddings/code', value: 'jina-v2 768d' });
      modelsRight.push({ key: 'embeddings/nlp', value: 'MiniLM-L6 384d' });
    }
    modelsRight.push({ key: 'chunking', value: 'smartChunkDoc (no LLM)' });
    modelsRight.push({ key: 'summarization', value: shortModelName(resolveCodeSummaryModel(ctx.config)) });
  }

  // --- Phase: scan ---
  const scanStart = Date.now();
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'scan' });
  log.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'scan', runId: ctx.runId }, 'phase started');
  const scanResult = await scanProject(ctx.projectRoot, ctx.config, evaluators.map(e => e.id));
  const scanDuration = Date.now() - scanStart;
  ctx.phaseDurations.scan = scanDuration;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'scan', durationMs: scanDuration });
  pipelineRows.push({ phase: 'source files', detail: `${scanResult.filesScanned} files (${scanResult.filesNew} new, ${scanResult.filesCached} cached)` });
  let docScanProject: ReturnType<typeof countChangedDocs> = null;
  let docScanInternal: ReturnType<typeof countChangedDocs> = null;
  if (ctx.enableRag) {
    const ragSuffix = ctx.resolvedRagMode ?? 'lite';
    const docsPath = ctx.config.documentation?.docs_path ?? 'docs';
    docScanProject = countChangedDocs(ctx.projectRoot, docsPath, ragSuffix);
    docScanInternal = countChangedDocs(ctx.projectRoot, join('.anatoly', 'docs'), `${ragSuffix}-internal`);
  }
  const scanCompleted = { phase: 'scan', runId: ctx.runId, durationMs: scanDuration, filesScanned: scanResult.filesScanned };
  log.info(scanCompleted, 'phase completed');
  rl?.info(scanCompleted, 'phase completed');
  if (ctx.verbose) {
    log.debug({ filesScanned: scanResult.filesScanned, filesNew: scanResult.filesNew, filesCached: scanResult.filesCached }, 'scan complete');
  }

  // --- Phase: estimate ---
  const estStart = Date.now();
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'estimate' });
  log.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'estimate', runId: ctx.runId }, 'phase started');
  allTasks = loadTasks(ctx.projectRoot);
  const estimateTasks = ctx.fileFilter
    ? allTasks.filter((t) => picomatch(ctx.fileFilter!)(t.file))
    : allTasks;
  const { inputTokens, outputTokens } = estimateTasksTokens(ctx.projectRoot, estimateTasks);
  estimateFiles = estimateTasks.length;
  // estimateTokenLabel is built after triage so it reflects evalFileCount
  ctx.phaseDurations.estimate = Date.now() - estStart;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'estimate', durationMs: ctx.phaseDurations.estimate });
  const estCompleted = { phase: 'estimate', runId: ctx.runId, durationMs: ctx.phaseDurations.estimate, totalTokens: inputTokens + outputTokens };
  log.info(estCompleted, 'phase completed');
  rl?.info(estCompleted, 'phase completed');

  // --- Phase: triage ---
  if (!ctx.triageEnabled) {
    pipelineRows.push({ phase: 'triage', detail: 'disabled (--no-triage)' });
  } else {
    const triageStart = Date.now();
    ctx.timeline.push({ t: triageStart - ctx.startTime, event: 'phase_start', phase: 'triage' });
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
      rl?.info({ event: 'file_triage', phase: 'triage', file: task.file, tier: result.tier, reason: result.reason }, 'file triaged');
    }

    const triageDuration = Date.now() - triageStart;
    ctx.phaseDurations.triage = triageDuration;
    ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'triage', durationMs: triageDuration, skip: tiers.skip, evaluate: tiers.evaluate });
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
  const internalDocsDir = resolve(ctx.projectRoot, '.anatoly', 'docs');
  const internalDocsTree = buildDocsTree(ctx.projectRoot, join('.anatoly', 'docs'));
  pipelineRows.push({ phase: 'usage graph', detail: `${usageGraph.usages.size} edges` });

  // --- Phase: internal docs status (Story 29.21 — scaffold moved to post-review) ---
  const bootstrapNeeded = needsBootstrap(ctx.projectRoot);
  if (bootstrapNeeded) {
    pipelineRows.push({ phase: 'internal docs', detail: 'first run (bootstrap)' });
  } else if (docScanInternal) {
    pipelineRows.push({ phase: 'internal docs', detail: `${docScanInternal.changed} changed, ${docScanInternal.cached} cached` });
    if (docScanProject) {
      pipelineRows.push({ phase: 'project docs', detail: `${docScanProject.changed} changed, ${docScanProject.cached} cached` });
    } else {
      pipelineRows.push({ phase: 'project docs', detail: 'deduplicated from internal' });
    }
  } else {
    pipelineRows.push({ phase: 'internal docs', detail: '.anatoly/docs/ ready' });
  }

  // --- Calibrated ETA (merged into the estimate pipeline row) ---
  const calibration = loadCalibration(ctx.projectRoot);
  const activeAxes = evaluators.map(e => e.id);
  const evalFileCount = ctx.triageEnabled
    ? [...triageMap.values()].filter(t => t.tier === 'evaluate').length
    : estimateTasks.length;
  const calibratedMin = estimateCalibratedMinutes(calibration, evalFileCount, activeAxes, ctx.concurrency, 0.75, { rag: ctx.enableRag, deliberation: ctx.deliberation });
  const hasCal = Object.values(calibration.axes).some(a => a.samples > 0);
  const calLabel = hasCal ? 'calibrated' : 'default';
  const estimateTokenLabel = `${evalFileCount} files · ${formatTokenCount(inputTokens + outputTokens)} tokens`;
  pipelineRows.push({ phase: 'estimate', detail: `${estimateTokenLabel} · ${formatCalibratedTime(calibratedMin)} (${calLabel})` });

  // Render setup summary table
  renderSetupTable({ project: projectInfo, config: configRows, models: modelsLeft, modelsRight, pipeline: pipelineRows }, ctx.plain);

  // Dry-run: show summary and exit before review
  if (ctx.dryRun) {
    const evalTasks = allTasks.filter((t) => triageMap.get(t.file)?.tier === 'evaluate');
    const { inputTokens, outputTokens } = estimateTasksTokens(ctx.projectRoot, allTasks);
    const estMinutes = estimateCalibratedMinutes(calibration, evalTasks.length, activeAxes, ctx.concurrency, 0.75, { rag: ctx.enableRag, deliberation: ctx.deliberation });

    console.log('');
    console.log(chalk.bold('dry run') + ' — no files were reviewed');
    console.log('');
    console.log(`  files        ${allTasks.length}`);
    console.log(`  evaluate     ${evalTasks.length}`);
    console.log(`  skip         ${allTasks.length - evalTasks.length}`);
    console.log(`  tokens       ${formatTokenCount(inputTokens + outputTokens)}`);
    console.log(`  est. time    ${formatCalibratedTime(estMinutes)} (concurrency ${ctx.concurrency})`);
    console.log('');
    return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree, internalDocsTree, internalDocsDir };
  }

  // Wait for confirmation before proceeding to review
  if (process.stdin.isTTY && !ctx.plain && !ctx.interrupted) {
    await waitForEnter();
  }

  ctx.allTasks = allTasks;
  ctx.triageMap = triageMap;

  return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree, internalDocsTree, internalDocsDir };
}

interface RagContext {
  vectorStore?: VectorStore;
  ragEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Doc generation (LLM) — Story 29.17
// ---------------------------------------------------------------------------

async function runDocLlmPhase(ctx: RunContext, taskId = 'doc-gen'): Promise<void> {
  const genResult = ctx.docPipelineResult?.generation;
  if (!genResult || genResult.prompts.length === 0) return;

  const log = getLogger();
  const outputDir = ctx.docPipelineResult!.scaffold.outputDir;
  const total = genResult.prompts.length;
  const ac = new AbortController();
  ctx.activeAborts.add(ac);

  const startDetail = taskId === 'bootstrap-doc' ? 'Creating internal documentation...' : `0/${total}`;
  ctx.pipelineState?.startTask(taskId, startDetail);

  let completed = 0;
  const executor: DocExecutor = ({ system, user, model }) => {
    return retryWithBackoff(
      async () => {
        const q = query({
          prompt: user,
          options: {
            systemPrompt: system,
            model,
            cwd: ctx.projectRoot,
            allowedTools: ['Read'],
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            maxTurns: 200,
            abortController: ac,
          },
        });

        let resultText = '';
        let costUsd = 0;
        let rateLimitResetsAt: number | undefined;

        for await (const message of q) {
          // Detect tier-level rate limit event
          if (message.type === 'rate_limit_event') {
            const info = (message as Record<string, unknown>).rate_limit_info as
              { status?: string; resetsAt?: number } | undefined;
            if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
              rateLimitResetsAt = info.resetsAt * 1000;
            }
          }

          if (message.type === 'result') {
            if (message.subtype === 'success') {
              resultText = (message as { result: string }).result;
              costUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
            } else {
              const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
              if (rateLimitResetsAt) {
                const { RateLimitStandbyError } = await import('../utils/rate-limiter.js');
                throw new RateLimitStandbyError(rateLimitResetsAt);
              }
              throw new Error(`SDK error [${message.subtype}]: ${errMsg}`);
            }
          }
        }

        return { text: resultText, costUsd };
      },
      {
        maxRetries: 3,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        jitterFactor: 0.2,
        filePath: 'doc-gen',
        isInterrupted: () => ctx.interrupted,
        onRetry: (attempt, delayMs) => {
          log.warn({ attempt, delayMs }, 'doc generation retrying');
        },
      },
    );
  };

  try {
    const result = await executeDocPrompts({
      prompts: genResult.prompts,
      outputDir,
      projectRoot: ctx.projectRoot,
      router: ctx.router,
      executor,
      logDir: join(ctx.runDir, 'conversations'),
      onPageComplete: (pagePath) => {
        completed++;
        ctx.pipelineState?.updateTask(taskId, `${completed}/${total} pages updated`);
        ctx.renderer?.logPlain(`[${taskId}] ${completed}/${total} ${pagePath}`);
      },
      onPageError: (pagePath, err) => {
        log.warn({ pagePath, err: err.message }, 'doc generation failed for page');
      },
    });

    // Aggregate doc generation LLM costs
    ctx.totalCostUsd += result.totalCostUsd;

    log.info({ pagesWritten: result.pagesWritten, pagesFailed: result.pagesFailed, costUsd: result.totalCostUsd }, 'doc generation complete');

    // Structure lint — deterministic preamble/fence cleanup
    const docsPath = ctx.config.documentation?.docs_path ?? 'docs';
    if (result.pagesWritten > 0 && !ctx.interrupted) {
      ctx.pipelineState?.updateTask(taskId, 'linting docs…');
      ctx.renderer?.logPlain(`[${taskId}] linting doc structure…`);
      try {
        const lintLogDir = resolve(ctx.projectRoot, '.anatoly', 'runs', ctx.runId, 'structure-review');
        const lintResult = reviewDocStructure(outputDir, ctx.projectRoot, docsPath, undefined, { logDir: lintLogDir });
        log.info({ filesFixed: lintResult.filesFixed, issues: lintResult.issues.length }, 'doc structure lint complete');
        ctx.renderer?.logPlain(`[${taskId}] structure lint: ${lintResult.issues.length} issues, ${lintResult.filesFixed} auto-fixed`);

        // Auto-fix structural issues (numbering, index) before coherence review
        const unfixed = lintResult.issues.filter(i => !i.fixed);
        if (unfixed.length > 0) {
          ctx.pipelineState?.updateTask(taskId, 'fixing doc structure…');
          ctx.renderer?.logPlain(`[${taskId}] fixing ${unfixed.length} structural issues…`);
          const fixResult = autoFixStructuralIssues(outputDir, unfixed);
          log.info({
            renames: fixResult.renames.length,
            indexAdded: fixResult.indexEntriesAdded.length,
            orphansRemoved: fixResult.indexOrphansRemoved.length,
            linksUpdated: fixResult.linksUpdated,
          }, 'doc auto-fix complete');
        }
      } catch (lintErr) {
        log.warn({ err: lintErr }, 'doc structure lint/auto-fix failed — continuing');
      }
    }

    // Coherence review — only on first run (bootstrap). Use `anatoly docs coherence` for on-demand.
    if (result.pagesWritten > 0 && !ctx.interrupted && taskId === 'bootstrap-doc') {
      ctx.pipelineState?.updateTask(taskId, 'coherence review (Sonnet)…');
      ctx.renderer?.logPlain(`[${taskId}] coherence review (Sonnet) — reviewing ${result.pagesWritten} pages…`);
      try {
        const coherenceLogDir = resolve(ctx.projectRoot, '.anatoly', 'runs', ctx.runId, 'coherence-review');
        const coherenceResult = await runDocCoherenceReview({
          outputDir,
          projectRoot: ctx.projectRoot,
          docsPath,
          abortController: ac,
          logDir: coherenceLogDir,
          router: ctx.router,
          callbacks: {
            onToolUse: (_tool, filePath) => {
              const name = filePath.split('/').pop() ?? filePath;
              ctx.pipelineState?.updateTask(taskId, `reviewing ${name}…`);
            },
          },
        });
        ctx.totalCostUsd += coherenceResult.costUsd;
        log.info({
          issuesBefore: coherenceResult.linterIssuesBefore,
          issuesAfter: coherenceResult.linterIssuesAfter,
          costUsd: coherenceResult.costUsd,
        }, 'doc coherence review complete');
        ctx.renderer?.logPlain(`[${taskId}] coherence review done — ${coherenceResult.linterIssuesBefore} issues before, ${coherenceResult.linterIssuesAfter} after ($${coherenceResult.costUsd.toFixed(4)})`);
      } catch (coherenceErr) {
        log.warn({ err: coherenceErr }, 'doc coherence review failed — continuing');
        ctx.renderer?.logPlain(`[${taskId}] coherence review failed — continuing`);
      }
    }

    const detail = result.pagesFailed > 0
      ? `${result.pagesWritten}/${total} written · ${result.pagesFailed} failed`
      : `${result.pagesWritten}/${total} pages`;
    ctx.pipelineState?.completeTask(taskId, detail);
  } finally {
    ctx.activeAborts.delete(ac);
  }
}

/**
 * Bootstrap internal docs: scaffold structure + generate all pages.
 * Only runs on first run (no .anatoly/docs/ yet). Story 29.21.
 * Errors are caught and logged as warnings (non-fatal).
 *
 * @param ctx Run context providing projectRoot, config, and SDK semaphore.
 * @param tasks Scanned task list for doc-generator context.
 */
async function runDocBootstrap(ctx: RunContext, tasks: Task[]): Promise<void> {
  const taskId = 'bootstrap-doc';
  const log = getLogger();
  const rl = ctx.runLog;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: taskId });

  try {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolve(ctx.projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch { /* no package.json — non-JS project */ }
    const docsPath = ctx.config.documentation?.docs_path ?? 'docs';

    // Scaffold + generate (first time)
    ctx.renderer?.logPlain(`[${taskId}] scaffolding & generating internal documentation...`);
    if (!ctx.profile) throw new Error('project profile not detected — cannot run doc pipeline');
    const scaffoldResult = runDocScaffold(ctx.projectRoot, pkg, tasks, docsPath, ctx.profile);
    const genResult = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, pkg);
    ctx.docPipelineResult = { scaffold: scaffoldResult, generation: genResult };

    log.info({
      phase: taskId,
      pagesCreated: scaffoldResult.scaffoldResult.pagesCreated.length,
      prompts: genResult.prompts.length,
      fresh: genResult.cacheResult.fresh.length,
    }, `${taskId} scaffold complete`);
    rl?.info({
      phase: taskId,
      pagesCreated: scaffoldResult.scaffoldResult.pagesCreated.length,
      prompts: genResult.prompts.length,
    }, `${taskId} scaffold complete`);

    if (genResult.prompts.length > 0 && !ctx.interrupted) {
      await runDocLlmPhase(ctx, taskId);
    } else {
      ctx.pipelineState?.completeTask(taskId, 'all cached');
    }
  } catch (err) {
    log.warn({ err }, `${taskId} failed — continuing`);
    rl?.warn({ err }, `${taskId} failed`);
  }
}

/**
 * Update internal docs: regenerate only pages whose source code changed.
 * No scaffold — uses existing structure. Runs every run post-review. Story 29.21.
 * Falls back gracefully when no prompts are generated.
 *
 * @param ctx Run context providing projectRoot, config, and SDK semaphore.
 * @param tasks Scanned task list for doc-generator context.
 */
async function runDocUpdate(ctx: RunContext, tasks: Task[]): Promise<void> {
  const taskId = 'internal-docs';
  const log = getLogger();
  const rl = ctx.runLog;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: taskId });
  const start = Date.now();

  try {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolve(ctx.projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch { /* no package.json — non-JS project */ }
    const docsPath = ctx.config.documentation?.docs_path ?? 'docs';

    // Scaffold only for new modules (idempotent, skips existing pages)
    if (!ctx.profile) throw new Error('project profile not detected — cannot run doc pipeline');
    const scaffoldResult = runDocScaffold(ctx.projectRoot, pkg, tasks, docsPath, ctx.profile);
    const newPages = scaffoldResult.scaffoldResult.pagesCreated.length;

    // Scope doc updates to modules whose source files were actually reviewed.
    // Files with tier 'evaluate' in the triageMap are the ones that changed.
    const changedFiles = new Set<string>();
    for (const [file, triage] of ctx.triageMap) {
      if (triage.tier === 'evaluate') changedFiles.add(file);
    }

    // Generate only stale/new pages whose modules were touched (cache-aware)
    const genResult = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, pkg, changedFiles);
    ctx.docPipelineResult = { scaffold: scaffoldResult, generation: genResult };

    const deferredNote = genResult.pagesDeferred > 0 ? `, ${genResult.pagesDeferred} deferred` : '';
    ctx.renderer?.logPlain(`[${taskId}] ${newPages > 0 ? `${newPages} new pages, ` : ''}${genResult.prompts.length} to update, ${genResult.cacheResult.fresh.length} cached${deferredNote}`);

    log.info({
      phase: taskId,
      newPages,
      prompts: genResult.prompts.length,
      fresh: genResult.cacheResult.fresh.length,
      deferred: genResult.pagesDeferred,
    }, `${taskId} ready`);

    if (genResult.prompts.length > 0 && !ctx.interrupted) {
      await runDocLlmPhase(ctx, taskId);
    } else {
      ctx.pipelineState?.completeTask(taskId, 'all cached');
    }
  } catch (err) {
    log.warn({ err }, `${taskId} failed — continuing`);
    rl?.warn({ err }, `${taskId} failed`);
    ctx.pipelineState?.completeTask(taskId, 'failed');
  }

  const duration = Date.now() - start;
  ctx.phaseDurations[taskId] = duration;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: taskId, durationMs: duration });
}

/**
 * Copy .anatoly/docs/ → docs/ when in dedup mode, keeping project docs in sync.
 */
function syncProjectDocsFromInternal(ctx: RunContext): void {
  const taskId = 'sync-project-docs';
  const log = getLogger();
  ctx.pipelineState?.startTask(taskId, 'copying…');

  try {
    const docsPath = ctx.config.documentation?.docs_path ?? 'docs';
    const absInternal = resolve(ctx.projectRoot, '.anatoly', 'docs');
    const absProject = resolve(ctx.projectRoot, docsPath);

    if (!existsSync(absInternal)) {
      ctx.pipelineState?.completeTask(taskId, 'no internal docs');
      return;
    }

    // Guard against symlinks (rmSync on a symlink target would destroy the source)
    if (existsSync(absProject)) {
      try {
        if (lstatSync(absProject).isSymbolicLink()) {
          log.info('sync skipped — docs/ is a symlink');
          ctx.pipelineState?.completeTask(taskId, 'skipped (symlink)');
          return;
        }
      } catch { /* lstat failed — proceed normally */ }
      rmSync(absProject, { recursive: true, force: true });
    }
    cpSync(absInternal, absProject, { recursive: true });

    // Remove internal-only artifacts from the copy
    const cachePath = join(absProject, '.cache.json');
    if (existsSync(cachePath)) rmSync(cachePath);

    log.info({ phase: taskId }, `synced .anatoly/docs/ → ${docsPath}/`);
    ctx.pipelineState?.completeTask(taskId, 'synced');
  } catch (err) {
    log.warn({ err }, `${taskId} failed — continuing`);
    ctx.pipelineState?.completeTask(taskId, 'failed');
  }
}

/**
 * Re-index doc sections after the doc-update pipeline has modified `.anatoly/docs/`.
 *
 * 1. Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate chunk cache.
 * 2. For advanced mode, briefly restart GGUF containers for NLP embedding.
 * 3. Call `indexDocSections` which finds chunk-cache hits → skips Haiku → only embeds + upserts.
 * 4. Stop containers.
 */
async function reindexDocsAfterUpdate(ctx: RunContext, vectorStore: VectorStore): Promise<void> {
  const log = getLogger();
  const cacheSuffix = ctx.resolvedRagMode!; // 'lite' or 'advanced'
  const internalDocsDir = join('.anatoly', 'docs');
  const docsDir = ctx.config.documentation?.docs_path ?? 'docs';

  // Phase 1: smart-chunk changed files into chunk cache (pure computation, no LLM)
  const intChunked = smartChunkAndCache(ctx.projectRoot, internalDocsDir, `${cacheSuffix}-internal`);
  // Skip project docs when dedup mode — syncProjectDocsFromInternal will overwrite them
  // and the alias in the vector store already maps internal → project.
  const projChunked = ctx.docsIdentical ? 0 : smartChunkAndCache(ctx.projectRoot, docsDir, cacheSuffix);

  if (intChunked + projChunked === 0) return; // nothing changed

  ctx.renderer?.logPlain(`[rag] smart-chunked ${intChunked} internal${projChunked > 0 ? ` + ${projChunked} project` : ''} doc files`);

  // Phase 2: restart embedding containers if advanced mode
  const logFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
  let containersStarted = false;
  if (ctx.resolvedRagMode === 'advanced') {
    containersStarted = await startGgufContainers(ctx.projectRoot, logFn);
    if (!containersStarted) {
      log.warn('GGUF containers failed to restart for doc re-indexing — docs will be re-indexed on next run');
      return;
    }
    ctx.renderer?.logPlain('[rag] GGUF containers restarted for doc re-indexing');
  }

  // Phase 3: re-index changed docs (chunk cache hit → no Haiku, just embed + upsert)
  try {
    const onLog = (msg: string) => {
      ctx.runLog?.debug({ phase: 'rag-doc-reindex' }, msg);
      ctx.renderer?.logPlain(`[rag] ${msg}`);
    };

    if (intChunked > 0) {
      const intResult = await indexDocSections({
        projectRoot: ctx.projectRoot,
        vectorStore,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        chunkModel: ctx.config.models.fast,
        onLog,
        isInterrupted: () => ctx.interrupted,
        conversationDir: join(ctx.runDir, 'conversations'),
        router: ctx.router,
        docSource: 'internal',
      });
      onLog(`doc re-index (internal): ${intResult.sections} sections, $${intResult.costUsd.toFixed(4)}`);
    }

    if (projChunked > 0) {
      const projResult = await indexDocSections({
        projectRoot: ctx.projectRoot,
        vectorStore,
        docsDir,
        cacheSuffix,
        chunkModel: ctx.config.models.fast,
        onLog,
        isInterrupted: () => ctx.interrupted,
        conversationDir: join(ctx.runDir, 'conversations'),
        router: ctx.router,
        docSource: 'project',
      });
      onLog(`doc re-index (project): ${projResult.sections} sections, $${projResult.costUsd.toFixed(4)}`);
    }
  } finally {
    // Phase 4: stop containers
    if (containersStarted) {
      await stopGgufContainers(logFn);
      ctx.renderer?.logPlain('[rag] GGUF containers stopped after doc re-indexing');
    }
  }
}

async function runRagPhase(ctx: RunContext, tasks: Task[]): Promise<RagContext> {
  if (!ctx.enableRag) return { ragEnabled: false };

  const log = getLogger();
  const rl = ctx.runLog;
  const ragStart = Date.now();
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'rag-index' });
  log.info({ phase: 'rag-index', runId: ctx.runId }, 'phase started');
  rl?.info({ phase: 'rag-index', runId: ctx.runId }, 'phase started');

  // Detect hardware and determine backend BEFORE starting any embedding server
  const hardware = detectHardware();
  const readyFlag = readEmbeddingsReadyFlag(ctx.projectRoot);
  const logFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
  let effectiveBackend: EmbeddingBackend = determineBackend(readyFlag, hardware);

  // Start the appropriate embedding backend based on detected tier
  if (effectiveBackend === 'advanced-gguf' && ctx.resolvedRagMode === 'advanced') {
    const ggufMsg = 'starting GGUF Docker containers';
    let started = false;
    if (!ctx.plain && process.stdout.isTTY) {
      process.stdout.write(chalk.dim(`  ${ggufMsg}...`));
      started = await startGgufContainers(ctx.projectRoot, logFn, (sec) => {
        process.stdout.write(`\r\x1b[K${chalk.dim(`  ${ggufMsg}... ${sec}s`)}`);
      });
      process.stdout.write('\r\x1b[K');
    } else {
      log.info(ggufMsg);
      started = await startGgufContainers(ctx.projectRoot, logFn);
    }
    if (!started) {
      if (ctx.rebuildRag) {
        log.warn('GGUF containers failed — falling back to ONNX lite (rebuild mode: full re-index)');
        effectiveBackend = 'lite';
      } else {
        throw new Error(
          'Docker is unavailable but this project was set up with advanced-gguf embeddings. '
          + 'Falling back to lite mode would produce incompatible embedding dimensions and corrupt the vector store. '
          + 'Please either:\n'
          + '  1. Start Docker and retry, or\n'
          + '  2. Run with --rebuild-rag to re-index everything in lite mode',
        );
      }
    }
  }

  // Resolve models with the effective backend (handles GGUF/ONNX routing)
  const effectiveFlag = readyFlag
    ? { ...readyFlag, backend: effectiveBackend }
    : { device: 'cpu', backend: effectiveBackend } as import('../rag/hardware-detect.js').EmbeddingsReadyFlag;
  ctx.resolvedModels = await resolveEmbeddingModels(ctx.config.rag, hardware, logFn, effectiveFlag);

  // Update task labels with resolved model names
  const state = ctx.pipelineState!;
  const codeModel = shortModelName(ctx.resolvedModels.codeModel);
  const nlpModel = shortModelName(ctx.resolvedModels.nlpModel);
  const indexModel = resolveCodeSummaryModel(ctx.config);
  const llmModel = shortModelName(indexModel);
  state.relabelTask('rag-code', `Embedding code (${codeModel})`);
  state.relabelTask('rag-nlp', `LLM summaries (${llmModel}) & embedding (${nlpModel})`);
  state.relabelTask('rag-doc-project', `Chunking & embedding project docs (${nlpModel})`);
  state.relabelTask('rag-doc-internal', `Chunking & embedding internal docs (${nlpModel})`);

  let ragResult: RagIndexResult | undefined;
  const ragLogPath = join(ctx.runDir, 'logs', 'rag-index.log');
  mkdirSync(join(ctx.runDir, 'logs'), { recursive: true });
  const ragLogStream = createWriteStream(ragLogPath, { flags: 'a' });
  let ragPhase = 'code';
  const ragPhaseToTaskId: Record<string, string> = {
    code: 'rag-code',
    nlp: 'rag-nlp',
    upsert: 'rag-upsert',
    'doc-project': 'rag-doc-project',
    'doc-internal': 'rag-doc-internal',
  };

  state.startTask('rag-code', '0/?');

  try {
    ragResult = await indexProject({
      projectRoot: ctx.projectRoot,
      tasks,
      rebuild: ctx.rebuildRag,
      concurrency: ctx.concurrency,
      verbose: ctx.verbose,
      indexModel,
      resolvedModels: ctx.resolvedModels,
      ragMode: ctx.resolvedRagMode,
      docsDir: ctx.config.documentation?.docs_path ?? 'docs',
      onLog: (msg) => {
        ctx.runLog?.debug({ phase: 'rag-index' }, msg);
        ragLogStream.write(`${new Date().toISOString()} ${msg}\n`);
        ctx.renderer?.logPlain(`[rag] ${msg}`);
      },
      onProgress: (current, total) => {
        const taskId = ragPhaseToTaskId[ragPhase];
        if (taskId) state.updateTask(taskId, `${current}/${total}`);
      },
      onPhase: (phase) => {
        const prevTaskId = ragPhaseToTaskId[ragPhase];
        const nextTaskId = ragPhaseToTaskId[phase];
        ragPhase = phase;
        // Complete previous phase task with interim detail —
        // doc tasks get their final detail from ragResult after indexing completes
        if (prevTaskId && prevTaskId !== nextTaskId) {
          const interimDetail = prevTaskId.startsWith('rag-doc-') ? '…' : 'done';
          state.completeTask(prevTaskId, interimDetail);
          // Remove upsert synthetic file when leaving upsert phase
          if (prevTaskId === 'rag-upsert') {
            state.activeFiles.delete('Saving index\u2026');
          }
        }
        // Start next phase task
        if (nextTaskId) {
          state.startTask(nextTaskId);
          // During upsert, show synthetic file entry
          if (phase === 'upsert') {
            state.trackFile('Saving index\u2026');
          }
        }
      },
      onFileStart: (file) => { state.trackFile(file); },
      onFileDone: (file) => { state.untrackFile(file); },
      isInterrupted: () => ctx.interrupted,
      conversationDir: join(ctx.runDir, 'conversations'),
      router: ctx.router,
      fileFilter: ctx.fileFilter ?? undefined,
    });
  } finally {
    ragLogStream.end();
    // Free GPU/VRAM immediately — review uses pre-computed vectors from LanceDB.
    await stopGgufContainers(logFn);
    await stopTeiContainers();
  }

  // Complete final RAG phase task
  const finalTaskId = ragPhaseToTaskId[ragPhase];
  if (finalTaskId) {
    state.completeTask(finalTaskId, finalTaskId === 'rag-upsert' ? 'done' : (state.tasks.find((t) => t.id === finalTaskId)?.detail ?? 'done'));
  }
  // Remove upsert synthetic file
  state.activeFiles.delete('Saving index\u2026');

  // Set final completion details on all rag tasks
  if (ragResult) {
    state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
    const nlpTask = state.tasks.find(t => t.id === 'rag-nlp');
    state.completeTask('rag-nlp', nlpTask?.status === 'pending' ? 'cached' : `${ragResult.totalCards} cards`);
    state.completeTask('rag-upsert', 'done');
    state.completeTask('rag-doc-project', ragResult.docsIdentical
      ? 'deduplicated (= internal)'
      : ragResult.projectDocSections > 0
        ? `${ragResult.projectDocSections} sections` : ragResult.projectDocsCached ? 'cached' : 'no project docs');
    state.completeTask('rag-doc-internal', ragResult.internalDocSections > 0
      ? `${ragResult.internalDocSections} sections` : ragResult.internalDocsCached ? 'cached' : 'no internal docs');
  }

  const ragDuration = Date.now() - ragStart;
  ctx.phaseDurations['rag-index'] = ragDuration;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'rag-index', durationMs: ragDuration });

  if (ctx.interrupted) {
    console.log('interrupted — rag indexing incomplete');
    if (ctx.lockPath) { releaseLock(ctx.lockPath); ctx.lockPath = undefined; }
    return { ragEnabled: false };
  }

  // Aggregate RAG LLM costs (NLP summaries + doc chunking)
  if (ragResult?.costUsd) {
    ctx.totalCostUsd += ragResult.costUsd;
  }

  // Store dedup status for project docs sync after internal docs update
  if (ragResult?.docsIdentical) {
    ctx.docsIdentical = true;
  }

  const ragCompleted = {
    phase: 'rag-index', runId: ctx.runId, durationMs: ragDuration,
    cardsGenerated: ragResult?.cardsIndexed ?? 0, cached: (ragResult?.totalCards ?? 0) - (ragResult?.cardsIndexed ?? 0),
    costUsd: ragResult?.costUsd ?? 0,
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
  internalDocsTree?: string | null,
  internalDocsDir?: string,
): Promise<void> {
  const log = getLogger();
  const rl = ctx.runLog;
  const reviewStart = Date.now();
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'review' });
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
  const state = ctx.pipelineState!;
  const axesTotal = evaluators.length;
  state.setPhase('review');
  state.startTask('review', `0/${evaluateTotal}`);

  let completedCount = 0;

  const updateReviewTask = () => {
    const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
    state.updateTask('review', `${completedCount}/${evaluateTotal}${findingsNote}`);
  };

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
        pm.updateFileStatus(filePath, 'DONE', undefined, evaluators.map(e => e.id));
        ctx.filesReviewed++;
        ctx.reviewCounts.skipped++;
        rl?.info({ event: 'file_skip', phase: 'review', file: filePath, reason: triage.reason }, 'file skipped');
        return;
      }

      // Evaluate tier: run all axis evaluators in parallel
      pm.updateFileStatus(filePath, 'IN_PROGRESS');
      state.trackFile(filePath, { axesTotal });
      rl?.info({ event: 'file_review_start', file: filePath, phase: 'review', worker: workerIndex, tier: triage?.tier ?? 'evaluate', symbolCount: task.symbols?.length ?? 0, axes: evaluators.map((e) => e.id) }, 'file review started');
      ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'file_review_start', file: filePath });

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
              internalDocsTree,
              internalDocsDir,
              deliberation: ctx.deliberation,
              codeWeight: ctx.config.rag.code_weight,
              conversationDir: join(ctx.runDir, 'conversations'),
              router: ctx.router,
              userInstructions: ctx.userInstructions,
              onAxisComplete: () => {
                state.markAxisDone(filePath);
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
              rl?.info({ event: 'retry', file: filePath, attempt, delayMs }, 'rate limited, retrying');
              const delaySec = (delayMs / 1000).toFixed(0);
              state.setRetryMessage(filePath, `retry ${delaySec}s (${attempt}/5)`);
            },
            onStandby: (resetsAtMs) => {
              const MARGIN_MS = 5 * 60 * 1000;
              const resumeDate = new Date(resetsAtMs + MARGIN_MS);
              const resumeStr = resumeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              rl?.info({ event: 'standby', file: filePath, resetsAt: resetsAtMs, resumeAt: resumeStr }, 'sleeping until rate limit expired');
              state.setRetryMessage(filePath, `sleeping until ${resumeStr} (rate limit)`);
            },
          },
        );

        writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
        cacheReview(ctx.projectRoot, result.review);
        writeTranscript(ctx.projectRoot, filePath, result.transcript, ctx.runDir);
        const succeededAxes = result.failedAxes.length > 0
          ? evaluators.map(e => e.id).filter(id => !result.failedAxes.includes(id))
          : evaluators.map(e => e.id);
        pm.updateFileStatus(filePath, 'DONE', undefined, succeededAxes);
        ctx.filesReviewed++;
        ctx.reviewCounts.evaluated++;
        completedCount++;
        ctx.totalFindings += countReviewFindings(result.review, 60);
        ctx.totalCostUsd += result.costUsd;
        if (result.failedAxes.length > 0) {
          ctx.degradedReviews++;
        }
        for (const at of result.axisTiming) {
          const s = ctx.axisStats[at.axisId] ??= { calls: 0, totalDurationMs: 0, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0 };
          s.calls++;
          s.totalDurationMs += at.durationMs;
          s.totalCostUsd += at.costUsd;
          s.totalInputTokens += at.inputTokens;
          s.totalOutputTokens += at.outputTokens;
          s.totalCacheReadTokens += at.cacheReadTokens;
          s.totalCacheCreationTokens += at.cacheCreationTokens;
          // Track per-provider stats (Story 39.2)
          const ps = ctx.providerStats[at.provider];
          ps.calls++;
          ps.costUsd += at.costUsd;
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
        ctx.runLog?.info({ event: 'file_review_end', ...reviewFields }, 'file review completed');
        ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'file_review_end', file: filePath, verdict: result.review.verdict, durationMs: result.durationMs });
        if (ctx.plain) {
          const findings = countReviewFindings(result.review);
          const verdict = result.review.verdict;
          const dur = (result.durationMs / 1000).toFixed(1);
          const note = findings > 0 ? ` | ${findings} findings` : '';
          ctx.renderer?.logPlain(`[review] [${completedCount}/${evaluateTotal}] ${filePath} \u2192 ${verdict}${note} (${dur}s)`);
        }
      } catch (error) {
        if (ctx.interrupted) return;

        const message = error instanceof AnatolyError ? error.message : String(error);
        const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
        pm.updateFileStatus(filePath, errorCode === 'SDK_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
        ctx.errorCount++;
        ctx.errorsByCode[errorCode] = (ctx.errorsByCode[errorCode] ?? 0) + 1;
        log.error({ file: filePath, code: errorCode, err: error }, 'file review failed');
        ctx.runLog?.error({ event: 'file_review_end', file: filePath, code: errorCode, message, verdict: 'ERROR' }, 'file review failed');
        ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'file_review_end', file: filePath, verdict: 'ERROR', error: errorCode });
        completedCount++;
      } finally {
        ctx.activeAborts.delete(currentAbort);
        state.untrackFile(filePath);
        updateReviewTask();
      }
      });
    },
  });

  const findingsNote = ctx.totalFindings > 0 ? ` | ${ctx.totalFindings} findings` : '';
  state.completeTask('review', `${completedCount}/${evaluateTotal}${findingsNote}`);
  await pm.flush();

  const reviewDuration = Date.now() - reviewStart;
  ctx.phaseDurations.review = reviewDuration;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'review', durationMs: reviewDuration });
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
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_start', phase: 'report' });
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

  // --- Doc report aggregation ---
  let docReferenceSection: string | undefined;
  if (ctx.docPipelineResult) {
    try {
      const reviews = loadReviews(ctx.projectRoot, ctx.runDir);
      const idealPageCount = ctx.docPipelineResult.generation?.totalPages ?? 0;
      const cacheResult = ctx.docPipelineResult.generation?.cacheResult;
      const newPageSources = ctx.docPipelineResult.generation?.cacheResult.added.map(p => ({
        page: p,
        source: `scaffolded`,
      }));
      ctx.docReportResult = aggregateDocReport({
        projectRoot: ctx.projectRoot,
        projectTypes: ctx.docPipelineResult.scaffold.projectTypes,
        reviews,
        tasks: ctx.allTasks,
        idealPageCount,
        cacheResult,
        newPageSources,
        docsPath: ctx.config.documentation?.docs_path ?? 'docs',
      });
      docReferenceSection = ctx.docReportResult.renderedSection;
      log.info({ docScore: ctx.docReportResult.score.overall, docVerdict: ctx.docReportResult.score.verdict, recommendations: ctx.docReportResult.recommendations.length }, 'doc report aggregated');
      rl?.info({ docScore: ctx.docReportResult.score.overall, docVerdict: ctx.docReportResult.score.verdict }, 'doc report aggregated');
    } catch (err) {
      log.warn({ err }, 'doc report aggregation failed');
      rl?.warn({ err }, 'doc report aggregation failed');
    }
  } else if (ctx.profile && ctx.allTasks.length > 0) {
    // Fallback: no doc pipeline ran (e.g. cached run), but we can still
    // aggregate coverage metrics from reviews + profile.
    try {
      const reviews = loadReviews(ctx.projectRoot, ctx.runDir);
      ctx.docReportResult = aggregateDocReport({
        projectRoot: ctx.projectRoot,
        projectTypes: ctx.profile.types,
        reviews,
        tasks: ctx.allTasks,
        idealPageCount: 0,
        docsPath: ctx.config.documentation?.docs_path ?? 'docs',
      });
      docReferenceSection = ctx.docReportResult.renderedSection;
      log.info({ docScore: ctx.docReportResult.score.overall }, 'doc report aggregated (from cached reviews)');
    } catch (err) {
      log.warn({ err }, 'doc report aggregation fallback failed');
    }
  }

  // Persist doc reference section so `anatoly report` can reload it
  if (docReferenceSection && ctx.runDir) {
    writeFileSync(join(ctx.runDir, 'doc-reference-section.md'), docReferenceSection);
  }

  const { reportPath, data } = generateReport(ctx.projectRoot, errorFiles, ctx.runDir, triageStats, runStats, docReferenceSection);

  if (ctx.config.output?.max_runs) {
    purgeRuns(ctx.projectRoot, ctx.config.output.max_runs!);
  }

  // Badge injection (before summary display)
  let badgeNote = '';
  if (ctx.badge.enabled) {
    const badgeResult = injectBadge({
      projectRoot: ctx.projectRoot,
      verdict: data.globalVerdict,
      includeVerdict: ctx.badge.verdict,
      link: ctx.badge.link,
    });
    if (badgeResult.injected && !badgeResult.updated) {
      badgeNote = ' (badge added in README.md)';
    }
  }

  // Notifications (fire-and-forget, after report generation)
  {
    const notifPayload: NotificationPayload = {
      verdict: data.globalVerdict,
      totalFiles: data.totalFiles,
      cleanFiles: data.cleanFiles.length,
      findingFiles: data.findingFiles.length,
      errorFiles: data.errorFiles.length,
      durationMs: Date.now() - ctx.startTime,
      costUsd: ctx.totalCostUsd,
      axisScorecard: Object.fromEntries(
        REPORT_AXIS_IDS.map((axis) => {
          const countsKey: Record<ReportAxisId, keyof typeof data.counts> = {
            correction: 'correction', utility: 'dead', duplication: 'duplicate',
            overengineering: 'overengineering', tests: 'tests', documentation: 'documentation',
            'best-practices': 'best_practices',
          };
          const c = data.counts[countsKey[axis]];
          const { pct, label } = axisHealthPercent(data, axis);
          return [countsKey[axis], { ...c, healthPct: pct, label }];
        }),
      ),
      topFindings: data.actions.slice(0, 10).map(a => ({
        file: a.file,
        axis: a.source ?? 'unknown',
        severity: a.severity,
        detail: a.description,
      })),
      reportUrl: ctx.config.notifications?.telegram?.report_url ?? undefined,
    };
    // Fire-and-forget: errors are caught internally by sendNotifications
    void sendNotifications(ctx.config, notifPayload);
  }

  const { skipped, evaluated } = ctx.reviewCounts;
  const tierSummary = ctx.triageEnabled
    ? ` (${skipped} skipped \u00b7 ${evaluated} evaluated)`
    : '';
  const duration = formatDuration(Date.now() - ctx.startTime);
  const rel = (p: string) => relative(process.cwd(), p) || '.';
  const claudeCost = ctx.providerStats.anthropic.costUsd;
  const geminiCost = ctx.providerStats.gemini.costUsd;
  const costStr = `$${ctx.totalCostUsd.toFixed(2)}`;
  const costColor = ctx.totalCostUsd > 5 ? chalk.red.bold : ctx.totalCostUsd > 1 ? chalk.yellow.bold : chalk.green.bold;
  const hasGemini = ctx.providerStats.gemini.calls > 0;
  const costLine = hasGemini
    ? `${chalk.bold('Cost:')} ${costColor(`$${claudeCost.toFixed(2)}`)} (Claude) \u00b7 ${chalk.green.bold(`$${geminiCost.toFixed(2)}`)} (Gemini)`
    : `${chalk.bold('Cost:')} ${costColor(costStr)} in API calls \u00b7 ${chalk.green.bold('$0.00')} with Claude Code`;
  const quotaLine = hasGemini
    ? `${chalk.bold('Quota:')} ${ctx.providerStats.anthropic.calls} Claude \u00b7 ${ctx.providerStats.gemini.calls} Gemini (\u2212${Math.round((ctx.providerStats.gemini.calls / (ctx.providerStats.anthropic.calls + ctx.providerStats.gemini.calls)) * 100)}%)`
    : undefined;

  // Transition pipeline display to summary
  const state = ctx.pipelineState;
  if (state) {
    state.completeTask('report', 'done');
    state.setSummary({
      headline: chalk.bold('Done') + ` \u2014 ${data.totalFiles} files | ${ctx.totalFindings} findings | ${data.cleanFiles.length} clean${tierSummary} | ${duration}${badgeNote}`,
      paths: [
        { key: 'run', value: ctx.runId },
        { key: 'report', value: chalk.cyan(rel(reportPath)) },
        { key: 'reviews', value: chalk.cyan(rel(resolve(ctx.runDir, 'reviews')) + '/') },
        { key: 'transcripts', value: chalk.cyan(rel(resolve(ctx.runDir, 'logs')) + '/') },
        { key: 'log', value: chalk.cyan(rel(resolve(ctx.runDir, 'anatoly.ndjson'))) },
      ],
      cost: quotaLine ? `${costLine}\n${quotaLine}` : costLine,
    });
  }

  // Stop renderer — final frame will show summary
  ctx.renderer?.stop();

  // Plain mode: print summary to stdout
  if (ctx.plain || !state) {
    console.log('');
    console.log(chalk.bold('Done') + ` \u2014 ${data.totalFiles} files | ${ctx.totalFindings} findings | ${data.cleanFiles.length} clean${tierSummary} | ${duration}`);
    console.log('');
    console.log(`  run          ${ctx.runId}`);
    console.log(`  report       ${chalk.cyan(rel(reportPath))}`);
    console.log(`  reviews      ${chalk.cyan(rel(resolve(ctx.runDir, 'reviews')) + '/')}`);
    console.log(`  transcripts  ${chalk.cyan(rel(resolve(ctx.runDir, 'logs')) + '/')}`);
    console.log(`  log          ${chalk.cyan(rel(resolve(ctx.runDir, 'anatoly.ndjson')))}`);
    console.log('');
    console.log(`  ${costLine}`);
    if (quotaLine) console.log(`  ${quotaLine}`);
  }

  if (ctx.shouldOpen) openFile(reportPath);

  const reportDuration = Date.now() - reportStart;
  ctx.phaseDurations.report = reportDuration;
  ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'phase_end', phase: 'report', durationMs: reportDuration });
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

  // Derive conversationStats from axisStats (review-phase axis evaluations).
  // RAG + doc-gen LLM costs are aggregated into ctx.totalCostUsd directly.
  const conversationStats = {
    total: 0,
    byPhase: {} as Record<string, number>,
    byModel: {} as Record<string, number>,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };
  for (const [, s] of Object.entries(ctx.axisStats)) {
    conversationStats.total += s.calls;
    conversationStats.totalInputTokens += s.totalInputTokens;
    conversationStats.totalOutputTokens += s.totalOutputTokens;
    conversationStats.totalCostUsd += s.totalCostUsd;
  }
  if (conversationStats.total > 0) {
    conversationStats.byPhase.review = conversationStats.total;
    const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
    for (const e of evaluators) {
      const s = ctx.axisStats[e.id];
      if (s) {
        conversationStats.byModel[resolveAxisModel(e, ctx.config)] = (conversationStats.byModel[resolveAxisModel(e, ctx.config)] ?? 0) + s.calls;
      }
    }
  }

  // Compute provider stats (Story 39.2)
  const totalCalls = ctx.providerStats.anthropic.calls + ctx.providerStats.gemini.calls;
  const claude_quota_saved_pct = totalCalls > 0
    ? Math.round((ctx.providerStats.gemini.calls / totalCalls) * 100)
    : 0;

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
    providers: {
      anthropic: { calls: ctx.providerStats.anthropic.calls, costUsd: Math.round(ctx.providerStats.anthropic.costUsd * 100) / 100 },
      gemini: { calls: ctx.providerStats.gemini.calls, costUsd: Math.round(ctx.providerStats.gemini.costUsd * 100) / 100 },
    },
    claude_quota_saved_pct,
    phaseDurations: ctx.phaseDurations,
    axisStats: ctx.axisStats,
    timeline: ctx.timeline.sort((a, b) => a.t - b.t),
    conversations: conversationStats,
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
 * Copy .rev.json and .rev.md files for CACHED files from the accumulative cache
 * into the current runDir/reviews directory.
 *
 * This ensures the report always reflects the full project state, not just
 * the files that were re-reviewed in this run.
 *
 * @param projectRoot Absolute path to the project root.
 * @param currentRunDir Absolute path to the current run output directory.
 * @param pm Progress manager holding the cached-file manifest.
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
    // Copy both .rev.json and .rev.md (human-readable review)
    for (const ext of ['.rev.json', '.rev.md']) {
      const src = join(cacheReviewsDir, `${baseName}${ext}`);
      const dst = join(currentReviewsDir, `${baseName}${ext}`);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          copyFileSync(src, dst);
          if (ext === '.rev.json') copied++;
        } catch (err) {
          getLogger().debug({ src, err }, 'failed to copy cached review (non-fatal)');
        }
      }
    }
  }

  if (copied > 0) {
    getLogger().info({ copied }, 'copied cached reviews into current run');
  }
}

/**
 * Persist a .rev.json and .rev.md into the accumulative cache directory.
 * Always overwrites — the latest review is the source of truth.
 * Failures are silently swallowed (non-fatal, logged at debug level).
 *
 * @param projectRoot Absolute path to the project root.
 * @param review Parsed review file to cache.
 */
function cacheReview(projectRoot: string, review: ReviewFile): void {
  const cacheReviewsDir = resolve(projectRoot, '.anatoly', 'cache', 'reviews');
  mkdirSync(cacheReviewsDir, { recursive: true });
  const baseName = toOutputName(review.file);
  try {
    writeFileSync(join(cacheReviewsDir, `${baseName}.rev.json`), JSON.stringify(review, null, 2) + '\n');
    writeFileSync(join(cacheReviewsDir, `${baseName}.rev.md`), renderReviewMarkdown(review));
  } catch (err) {
    getLogger().debug({ baseName, err }, 'failed to cache review (non-fatal)');
  }
}
