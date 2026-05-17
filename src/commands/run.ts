// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { resolve, join } from 'node:path';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import picomatch from 'picomatch';
import { loadConfig, getV3Source } from '../utils/config-loader.js';
import { ensurePricing } from '../utils/pricing-cache.js';
import { enumerateActiveModels } from '../utils/active-models.js';
import { type Config } from '../schemas/config.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { loadTasks } from '../core/estimator.js';
import { ProgressManager } from '../core/progress-manager.js';
import { writeReviewOutput, writeTranscript } from '../core/review-writer.js';
import { sendDesktopNotification } from '../core/notifications/desktop.js';
import { AnatolyError, ERROR_CODES, isFatalAuthError, isCircuitOpenError, circuitOpenError } from '../utils/errors.js';
import { toOutputName } from '../utils/cache.js';
import { type RagMode } from '../rag/index.js';
import { setRagQueryTrail } from '../rag/vector-store.js';
import { findExternalConfigIssues } from '../rag/known-embedding-providers.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, type ResolvedModels } from '../rag/hardware-detect.js';
import { stopGgufContainers } from '../rag/docker-gguf.js';
import { stopTeiContainers } from '../rag/docker-tei.js';
import { generateRunId, isValidRunId, createRunDir, countEmptyRuns, RUNS_REMOVE_EMPTY_CMD } from '../utils/run-id.js';
import { getLogger, createFileLogger, flushFileLogger } from '../utils/logger.js';
import { enterLlmCallSink } from '../utils/llm-calls-sink.js';
import { runWithContext } from '../utils/log-context.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import { withTimeout } from '../utils/with-timeout.js';
import type { Task } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import { generateSkipReview, evaluatorAxesForSkip, type TriageResult } from '../core/triage.js';
import { type UsageGraph } from '../core/usage-graph.js';
import { type DependencyMeta } from '../core/dependency-meta.js';
import { getEnabledEvaluators, isDocAxisActive } from '../core/axes/index.js';
import { evaluateFile } from '../core/file-evaluator.js';
import { runWorkerPool } from '../core/worker-pool.js';
import { countReviewFindings, formatRunDuration } from '../utils/format.js';
import { loadUserInstructions } from '../utils/user-instructions.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';
import { type DocPipelineResult } from '../core/doc-pipeline.js';
import { type DocReportResult } from '../core/doc-report-aggregator.js';
import { parseAxesOption, warnDisabledAxes } from '../utils/axes-filter.js';
import { checkGeminiAuth } from '../utils/gemini-auth.js';
import { checkAnthropicAuth } from '../utils/anthropic-auth.js';
import { renderProviderAuthBox } from '../utils/provider-auth.js';
import { saveDeliberationMemory } from '../core/correction-memory.js';
import { resolveAxisModel, type AxisId } from '../core/axis-evaluator.js';
import { ALL_AXIS_IDS } from '../core/axes/index.js';
import { TransportRouter, findModelForProvider } from '../core/transports/index.js';
import { AnthropicTransport } from '../core/transports/anthropic-transport.js';
import { GeminiTransport } from '../core/transports/gemini-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import { printBanner } from '../utils/banner.js';
import { printNotice } from '../utils/notice.js';
import { buildRunConfig, writeRunConfig, resolveDocMode } from '../core/run-config.js';
import { runInitSubprocess, writeFirstRunConfig, runRagSetup } from '../cli/setup-prompts.js';
import { quickInitDocConfig } from '../core/documentation-config.js';
import { type ProjectProfile } from '../core/language-detect.js';
import { needsBootstrap, writeScaffoldStatus } from '../core/doc-bootstrap.js';
import { getEffectiveSourceRoot } from '../core/worktree-path-resolution.js';
import { launchBackgroundRun, buildForwardedArgs } from '../core/background-runner.js';
import { writeRunStatus, getGitInfo, type RunStatus } from '../core/run-status.js';
import { createWorktreeManager } from '../core/worktree-manager.js';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { writeProjectReview, loadProjectReview, loadLegacyPathBasedReview } from '../core/project-review-cache.js';
import { computePromptHash } from '../utils/cache-meta.js';
import { resolveSystemPrompt } from '../core/prompt-resolver.js';
import { runDocConflictDetection } from '../core/doc-conflict-detector.js';
import { runPhase } from '../core/orchestration/run-phase.js';
import { runReportPhase } from '../core/orchestration/phases/report.js';
import { runSetupPhase } from '../core/orchestration/phases/setup.js';
import { runRagPhase } from '../core/orchestration/phases/rag.js';
import { runDocBootstrap, runDocUpdate, reindexDocsAfterUpdate } from '../core/orchestration/phases/doc.js';
import { recordLlmCost } from '../core/orchestration/cost.js';
import { requestFatalStop } from '../core/orchestration/run-control.js';
import { runRefinementStage } from '../core/orchestration/phases/refinement.js';
import type { RagContext } from '../core/orchestration/handoff.js';
import { loadDocConflicts } from '../core/doc-conflict-store.js';
import type { ArbitratedFragment } from '../core/axes/reference-docs-context.js';

// ---------------------------------------------------------------------------
// Story 55.7: Extract doc-wins arbitrated fragments from doc-conflicts.yaml
// ---------------------------------------------------------------------------

function loadArbitratedFragments(projectRoot: string): ArbitratedFragment[] {
  try {
    const lock = loadDocConflicts(projectRoot);
    if (!lock) return [];
    return lock.entries
      .filter((e) => e.verdict === 'doc-wins' && e.status === 'applied')
      .map((e) => ({
        referencePath: e.reference_excerpt.path,
        lineRange: e.reference_excerpt.line_range,
        text: e.reference_excerpt.text,
        arbitratedAt: e.verdict_set_at ?? e.detected_at,
        note: e.verdict_note,
      }));
  } catch {
    return [];
  }
}

/**
 * Mutable context bag threaded through every phase of a single `run` command
 * invocation. Populated incrementally during setup and consumed by review,
 * report, and doc-generation phases.
 */
export interface RunContext {
  /** Absolute path to the project being audited */
  projectRoot: string;
  /** Absolute path to the source tree (worktree snapshot). When set, source files are read from here. Defaults to projectRoot. */
  sourceRoot?: string;
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
  /**
   * Run-fatal error (e.g. provider-auth 401) latched by {@link requestFatalStop}.
   * Once set, the run stops as fast as possible and exits `failed`: `runPhase`
   * rethrows it at the next phase boundary so it reaches the top-level catch.
   */
  fatalError?: unknown;
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
  /** Count of skipped (triage), cached (previous run), and evaluated files */
  reviewCounts: { skipped: number; cached: number; evaluated: number };
  /** Files freshly reviewed (not cached) this run — used to invalidate deliberation cache */
  freshFiles: Set<string>;
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
  /** Per-file error details for end-of-run summary */
  errorDetails: Array<{ file: string; code: string; message: string }>;
  /** Number of files where at least one axis evaluator crashed */
  degradedReviews: number;
  /** Per-axis aggregated stats for run-metrics.json */
  axisStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
  /** Per-phase aggregated stats for run-metrics.json (mirrors axisStats but keyed by pipeline phase, including non-axis phases like rag-index, doc-generation, coherence-review, refinement). */
  phaseStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
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
  /** Quick-win preset active — reduced axis set (utility + duplication + correction) */
  quickWin: boolean;
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
  /** Skip all interactive prompts and use built-in defaults (--defaults-settings / non-TTY) */
  defaultsSettings: boolean;
  /** Run the pre-flight RAG embedding probe before indexing (default true). */
  connectivityCheck: boolean;
  /** Git branch + commit captured once during initRunDir, reused in done/failed status writes. */
  gitInfo?: { branch?: string; commit?: string };
  /** Doc-wins arbitrated fragments promoted to authoritative status. Story 55.7. */
  arbitratedFragments?: import('../core/axes/reference-docs-context.js').ArbitratedFragment[];
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
    .option('--rebuild-rag', 'force full RAG re-indexation')
    .option('--code-model <model>', 'embedding model for code vectors (default: auto-detect)')
    .option('--nlp-model <model>', 'embedding model for NLP vectors (default: auto-detect)')
    .option('--no-triage', 'disable triage, review all files with full agent')
    .option('--deliberation', 'enable Opus deliberation pass after axis merge')
    .option('--no-deliberation', 'disable deliberation pass')
    .option('--no-badge', 'skip README badge injection after audit')
    .option('--badge-verdict', 'include audit verdict in README badge')
    .option('--flush-memory', 'clear deliberation memory before running (fresh start)')
    .option('--dry-run', 'simulate the run: scan, estimate, triage, then show what would happen')
    .option('--background', 'run audit in background via git worktree snapshot (returns immediately)')
    .option('--no-notify', 'disable desktop notification on background run completion')
    .option('--quick-win', 'run with reduced axis set (utility + duplication + correction, no doc scaffold)')
    .option('--defaults-settings', 'skip all interactive prompts, use built-in defaults (CI/scripts)')
    .option('--allow-missing-pricing', 'continue when one or more models have no pricing entry (their cost reports as $0)')
    .option('--no-connectivity-check', 'skip the pre-flight RAG embedding probe (CI/deterministic runs)')
    .option('--source-root <path>', '[internal] source root for background worktree runs')
    .action(async (cmdOpts: {
      runId?: string; axes?: string; flushMemory?: boolean;
      cache?: boolean; file?: string; concurrency?: number; sdkConcurrency?: number;
      rebuildRag?: boolean; codeModel?: string; nlpModel?: string;
      triage?: boolean; deliberation?: boolean;
      badge?: boolean; badgeVerdict?: boolean; dryRun?: boolean;
      background?: boolean; notify?: boolean; sourceRoot?: string;
      quickWin?: boolean; defaultsSettings?: boolean;
      allowMissingPricing?: boolean;
      connectivityCheck?: boolean;
    }) => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      let config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      // Banner first — every launch-time message below is printed as a
      // standardised notice underneath, instead of ad-hoc lines drifting
      // above and below the banner.
      printBanner();

      // CLI flag parse — needs to happen before the wizard because a bad
      // --axes value should fail fast (not after the user picks a tier).
      const pricingAxesFilter = parseAxesOption(cmdOpts.axes);
      if (pricingAxesFilter === null) return;

      const useDefaults = cmdOpts.defaultsSettings === true;
      if (useDefaults || !process.stdin.isTTY) {
        getLogger().info('running with default settings (no prompts)');
      }

      // First run: when no .anatoly.yml exists, `run` performs NO setup
      // itself. It delegates to `anatoly init` (Q0 Quick/Advanced + the
      // advanced phases incl. RAG tier selection + provisioning), then
      // reloads the config and continues the audit in the same command.
      // Non-interactive (CI / --defaults-settings / non-TTY) can't prompt,
      // so a quick default config is written directly so the audit proceeds.
      const wasFirstRun = !existsSync(resolve(projectRoot, '.anatoly.yml'));
      if (wasFirstRun) {
        const interactive = process.stdin.isTTY === true && !useDefaults;
        if (interactive) {
          const initResult = runInitSubprocess(projectRoot);
          if (!initResult.ok || !existsSync(resolve(projectRoot, '.anatoly.yml'))) {
            printNotice({
              kind: 'info',
              title: 'Setup not completed',
              hint: 'No .anatoly.yml written. Run `anatoly init` to configure, then `anatoly run`.',
            });
            return;
          }
        } else {
          try {
            const { config: quickDoc } = quickInitDocConfig(projectRoot);
            await writeFirstRunConfig(projectRoot, { overrides: { documentation: quickDoc } });
            getLogger().info('first-run: no config — wrote quick default (non-interactive)');
            // Quick default is lite-tier: provision the lite ONNX models
            // now so the audit doesn't stall on a cold embedding download.
            await runRagSetup(projectRoot, 'lite', { isTTY: false, defaultsSettings: true });
          } catch (err) {
            getLogger().warn({ err }, 'failed to write .anatoly.yml — continuing with defaults');
          }
        }
        // Reload config from the file init (or the quick fallback) wrote so
        // the rest of the run uses the chosen settings, not bare defaults.
        try {
          config = loadConfig(projectRoot);
        } catch (err) {
          getLogger().warn({ err }, 'failed to reload .anatoly.yml — continuing with defaults');
        }
      }

      // External embedding mode requires `rag.embedding.{code,nlp}` to be
      // filled in and the matching API keys exported in `.env`. The wizard
      // only writes a commented reference template; this is the canonical
      // halt point that blocks the run until the yaml is uncommented + the
      // env is set. Anatoly auto-loads the project `.env` via dotenv/config,
      // so the user adds the variable and re-runs.
      const externalReadyFlag = readEmbeddingsReadyFlag(projectRoot);
      if (
        parentOpts.rag !== false
        && config.rag.enabled
        && externalReadyFlag?.backend === 'external'
      ) {
        const issues = findExternalConfigIssues(config.rag.embedding);
        if (issues.length > 0) {
          const yamlPath = resolve(projectRoot, '.anatoly.yml');
          const envPath = resolve(projectRoot, '.env');
          printNotice({
            kind: 'error',
            title: 'External embedding setup is incomplete',
            hint:
              `Sync ${yamlPath} and ${envPath}, then re-run \`anatoly run\`:\n`
              + issues.map((i) => `  - ${i.message}`).join('\n'),
          });
          process.exitCode = 2;
          return;
        }
      }

      // Pricing gate runs AFTER the first-run wizard so it sees the user's
      // actual tier choice (and any `rag.embedding` block written by the
      // wizard or by the external-tier follow-up). Before this, on a brand
      // new project, the gate would pre-screen against the default config
      // and either over-permit (lite defaults pass strict trivially) or
      // mis-screen the eventual external models.
      //
      // strict mode refuses to start when any configured model has no
      // pricing entry. Disabled on `--dry-run` (no calls billed) and when
      // the user opts out via `--allow-missing-pricing`.
      //
      // Scoping: pass the resolved run shape (--no-rag drops embeddings,
      // --no-deliberation drops the deliberation tier, --axes restricts
      // axis overrides) so the gate doesn't refuse to start over a model
      // that won't actually be invoked this run.
      const ragForPricing = parentOpts.rag !== false && config.rag.enabled;

      // Resolve the embedding tier eagerly so external SDK models (Voyage,
      // OpenRouter, …) the user identified by `provider` only — without an
      // explicit `model` in `.anatoly.yml` — still flow into the strict
      // pricing gate. Local tiers (ONNX / GGUF) resolve to non-external
      // backends and stay out of the active list (no API price to check).
      let resolvedEmbedForPricing: ResolvedModels | undefined;
      if (ragForPricing) {
        const earlyHardware = detectHardware();
        const earlyReadyFlag = readEmbeddingsReadyFlag(projectRoot);
        resolvedEmbedForPricing = await resolveEmbeddingModels(
          config.rag, earlyHardware, undefined, earlyReadyFlag, getV3Source(config),
        );
      }

      const activeModels = enumerateActiveModels(config, {
        enableRag: ragForPricing,
        enableDeliberation: cmdOpts.deliberation !== false,
        axesFilter: pricingAxesFilter,
      });
      // Only `external` backend models are billable per token; `lite` /
      // `advanced-gguf` route through the SDK to local servers and have no
      // upstream pricing — adding them would falsely trigger PRICING_INCOMPLETE.
      if (resolvedEmbedForPricing?.backend === 'external') {
        activeModels.push(resolvedEmbedForPricing.codeModel, resolvedEmbedForPricing.nlpModel);
      }
      const dedupedActiveModels = [...new Set(activeModels)];
      const strictPricing = !cmdOpts.dryRun && !cmdOpts.allowMissingPricing;
      try {
        await ensurePricing(dedupedActiveModels, projectRoot, {
          log: (level, message) => getLogger()[level](message),
          strict: strictPricing,
        });
      } catch (err) {
        if (err instanceof AnatolyError && err.code === ERROR_CODES.PRICING_INCOMPLETE) {
          printNotice({
            kind: 'error',
            title: 'Pricing data incomplete',
            hint:
              `${err.message}\n\n` +
              'Refresh the pricing snapshot with `anatoly providers`,\n' +
              'or pass `--allow-missing-pricing` to continue (their cost reports as $0).',
          });
          process.exitCode = 2;
          return;
        }
        throw err;
      }

      const cliConcurrency = cmdOpts.concurrency;
      const concurrency = cliConcurrency ?? config.runtime.concurrency;

      if (concurrency < 1 || concurrency > 10 || !Number.isInteger(concurrency)) {
        printNotice({
          kind: 'error',
          title: 'invalid --concurrency',
          hint: 'must be an integer between 1 and 10',
        });
        process.exitCode = 2;
        return;
      }

      const cliSdkConcurrency = cmdOpts.sdkConcurrency;
      if (cliSdkConcurrency !== undefined) {
        if (cliSdkConcurrency < 1 || cliSdkConcurrency > 20 || !Number.isInteger(cliSdkConcurrency)) {
          printNotice({
            kind: 'error',
            title: 'invalid --sdk-concurrency',
            hint: 'must be an integer between 1 and 20',
          });
          process.exitCode = 2;
          return;
        }
        if (config.providers.anthropic) {
          config.providers.anthropic.concurrency = cliSdkConcurrency;
        }
      }

      const runId = cmdOpts.runId ?? generateRunId();
      if (cmdOpts.runId && !isValidRunId(cmdOpts.runId)) {
        printNotice({
          kind: 'error',
          title: `invalid --run-id "${cmdOpts.runId}"`,
          hint: 'use alphanumeric characters, dashes, or underscores',
        });
        process.exitCode = 2;
        return;
      }

      // --- Background mode: spawn detached child and return immediately ---
      if (cmdOpts.background) {
        const runDir = createRunDir(projectRoot, runId);
        const forwardedArgs = buildForwardedArgs(cmdOpts);

        // Try to create a worktree for source isolation
        let worktreeCreated = false;
        try {
          const wm = createWorktreeManager(projectRoot);
          const wtPath = await wm.create(runId);
          forwardedArgs.push('--source-root', wtPath);
          worktreeCreated = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          printNotice({
            kind: 'warn',
            title: 'worktree creation failed — running in foreground',
            details: [msg],
          });
          // Fallback: run in foreground mode without --background
          cmdOpts.background = false;
        }

        if (cmdOpts.background) {
          const { pid } = launchBackgroundRun(projectRoot, runId, runDir, forwardedArgs);
          printNotice({
            kind: 'success',
            title: `review started in background (run: ${runId})`,
            hint: 'run `anatoly status` to check progress',
          });
          if (pid > 0) {
            getLogger().info({ runId, pid, worktreeCreated }, 'background run launched');
          }
          return;
        }
      }

      // Warn about empty (phantom) runs
      const emptyRunCount = countEmptyRuns(projectRoot);
      if (emptyRunCount > 0) {
        printNotice({
          kind: 'warn',
          title: `${emptyRunCount} empty audit(s) in .anatoly/runs/`,
          hint: `run ${chalk.bold(RUNS_REMOVE_EMPTY_CMD)} to clean up`,
        });
      }

      const dryRun = cmdOpts.dryRun ?? false;
      const plain = Boolean(parentOpts.plain) || 'NO_COLOR' in process.env || !process.stdout.isTTY;

      // Validate --lite / --advanced mutual exclusivity
      if (parentOpts.ragLite && parentOpts.ragAdvanced) {
        printNotice({
          kind: 'error',
          title: '--rag-lite and --rag-advanced are mutually exclusive',
          hint: 'pick one — or omit both to let Anatoly auto-detect',
        });
        process.exitCode = 2;
        return;
      }
      const ragMode: 'lite' | 'advanced' | 'auto' = parentOpts.ragLite ? 'lite'
        : parentOpts.ragAdvanced ? 'advanced'
        : 'auto';

      // CLI model overrides take precedence over config
      if (cmdOpts.codeModel) config.rag.code_model = cmdOpts.codeModel;
      if (cmdOpts.nlpModel) config.rag.nlp_model = cmdOpts.nlpModel;

      // Parse --axes filter (fail fast on invalid axis IDs)
      const axesResult = parseAxesOption(cmdOpts.axes);
      if (axesResult === null) return;
      const axesFilter: AxisId[] | undefined = axesResult;

      // Flush deliberation memory if requested
      if (cmdOpts.flushMemory) {
        saveDeliberationMemory(projectRoot, { version: 2, false_positives: [] });
        printNotice({
          kind: 'info',
          title: 'deliberation memory flushed',
        });
      }

      // Validate Anthropic provider auth — fail fast if misconfigured.
      // Catches missing `claude` CLI (subscription) or missing
      // ANTHROPIC_API_KEY (api) before the first axis call would
      // surface an opaque crash deep in the pipeline.
      if (config.providers.anthropic) {
        const anthropic = config.providers.anthropic;
        const result = checkAnthropicAuth(anthropic.mode);
        if (!result.ok) {
          throw new AnatolyError(
            renderProviderAuthBox('anthropic', anthropic.mode, result.reason ?? 'auth check failed'),
            ERROR_CODES.PROVIDER_AUTH_FAILED,
            false,
            undefined,
            undefined,
            true,
          );
        }
      }

      // Validate Google provider auth — fail fast if misconfigured
      if (config.providers.google) {
        const google = config.providers.google;
        let reason: string | null = null;
        if (google.mode === 'subscription') {
          const googleModel = findModelForProvider(config, 'google') ?? 'google/gemini-2.5-flash';
          const authOk = await checkGeminiAuth(projectRoot, googleModel);
          if (!authOk) {
            reason = 'Gemini CLI auth failed (not logged in or session expired)';
          }
        } else if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
          reason = 'neither GOOGLE_GENERATIVE_AI_API_KEY nor GOOGLE_API_KEY is set in the environment';
        }
        if (reason) {
          throw new AnatolyError(
            renderProviderAuthBox('google', google.mode, reason),
            ERROR_CODES.PROVIDER_AUTH_FAILED,
            false,
            undefined,
            undefined,
            true,
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
        if (prov) _providerModes[id] = { mode: prov.mode, single_turn: prov.single_turn, agents: prov.agents, concurrency: prov.concurrency };
      }
      const _router = new TransportRouter({
        nativeTransports: _nativeTransports,
        vercelSdkTransport: new VercelSdkTransport(config),
        providerModes: _providerModes,
      });

      const _userInstructions = loadUserInstructions(projectRoot);

      const ctx: RunContext = {
        projectRoot,
        sourceRoot: cmdOpts.sourceRoot ? resolve(cmdOpts.sourceRoot) : undefined,
        config,
        ...(resolvedEmbedForPricing ? { resolvedModels: resolvedEmbedForPricing } : {}),
        runId,
        // Created lazily after the user confirms the pipeline summary so that
        // bailing at the prompt does not leave a phantom audit behind.
        runDir: '',
        concurrency,
        plain,
        verbose: parentOpts.verbose as boolean | undefined,
        fileFilter: cmdOpts.file,
        noCache: cmdOpts.cache === false,
        enableRag: parentOpts.rag !== false && config.rag.enabled,
        ragMode,
        rebuildRag: cmdOpts.rebuildRag,
        shouldOpen: parentOpts.open as boolean | undefined,
        triageEnabled: cmdOpts.triage !== false,
        deliberation: cmdOpts.deliberation !== undefined
          ? cmdOpts.deliberation
          : config.agents.enabled,
        interrupted: false,
        activeAborts: new Set(),
        filesReviewed: 0,
        totalFindings: 0,
        totalFiles: 0,
        reviewCounts: { skipped: 0, cached: 0, evaluated: 0 },
        freshFiles: new Set<string>(),
        startTime: Date.now(),
        allTasks: [],
        triageMap: new Map(),
        phaseDurations: {},
        totalCostUsd: 0,
        errorCount: 0,
        errorsByCode: {},
        errorDetails: [],
        degradedReviews: 0,
        axisStats: {},
        phaseStats: {},
        providerStats: { anthropic: { calls: 0, costUsd: 0 }, gemini: { calls: 0, costUsd: 0 } },
        timeline: [],
        axesFilter,
        dryRun,
        badge: {
          enabled: cmdOpts.badge !== false && config.badge.enabled,
          verdict: cmdOpts.badgeVerdict ?? config.badge.verdict,
          link: config.badge.link,
        },
        isFirstRun: false,
        quickWin: false,
        docsIdentical: false,
        router: _router,
        userInstructions: _userInstructions.hasInstructions ? _userInstructions : undefined,
        defaultsSettings: useDefaults,
        connectivityCheck: cmdOpts.connectivityCheck !== false,
      };

      // Quick-win: a preset that restricts to 3 axes. Activated only by the
      // --quick-win CLI flag now (the first-run wizard no longer asks an
      // audit mode — first run uses the config's default axis set). Doc
      // bootstrap is no longer skipped here as a side effect: it is derived
      // from (documentation axis enabled AND internal.mode === 'full'); with
      // the 3-axis preset, documentation isn't selected so bootstrap is
      // naturally not triggered.
      const quickWinActive = cmdOpts.quickWin === true;
      if (quickWinActive) {
        ctx.quickWin = true;
        ctx.axesFilter = ['utility', 'duplication', 'correction'] as AxisId[];
        getLogger().info('quick-win preset: utility + duplication + correction');
      }

      // Config-seeded axis checkbox. Interactive override of which axes run
      // *this* invocation, pre-checked from the config-enabled set. Skipped
      // when: non-interactive, --defaults-settings, an explicit --axes filter,
      // the --quick-win preset, or this is the first run (wizardResult set
      // means .anatoly.yml was just generated — first run uses config
      // defaults verbatim, no extra prompt). Config remains the default
      // state; this is a transient per-run override, never persisted.
      if (
        process.stdin.isTTY === true
        && !useDefaults
        && ctx.axesFilter === undefined
        && !quickWinActive
        && !wasFirstRun
      ) {
        const enabledAxes = ALL_AXIS_IDS.filter(
          (id) => config.axes?.[id]?.enabled !== false,
        );
        const picked = await p.multiselect({
          message: 'Axes to run this audit (config defaults pre-checked)',
          options: ALL_AXIS_IDS.map((id) => ({ value: id, label: id })),
          initialValues: enabledAxes,
          required: false,
        });
        if (p.isCancel(picked)) {
          // Non-fatal: keep config defaults rather than aborting the run.
          getLogger().info('axis selection cancelled — using config defaults');
        } else if (picked.length === 0) {
          getLogger().info('no axes selected — using config defaults');
        } else if (
          picked.length !== enabledAxes.length
          || picked.some((id) => !enabledAxes.includes(id))
        ) {
          ctx.axesFilter = picked as AxisId[];
          getLogger().info(`axis selection: ${picked.join(', ')}`);
        }
      }

      // Raise max listeners to account for concurrent SDK subprocess exit handlers
      // and gemini-cli-core Config instances that each add a model-changed listener.
      // Also bump events.defaultMaxListeners so child AbortSignal instances created
      // by the SDK during parallel primitive invocations (DAG executor fan-out)
      // don't trip the MaxListenersExceededWarning — epic 56 surfaced this by
      // running 7 axis primitives concurrently, each propagating the same parent
      // AbortSignal through the transport stack.
      const maxConcurrency = Math.max(config.providers.anthropic?.concurrency ?? 8, config.providers.google?.concurrency ?? 0);
      process.setMaxListeners(Math.max(process.getMaxListeners(), maxConcurrency + 10));
      const { EventEmitter } = await import('node:events');
      if (EventEmitter.defaultMaxListeners < maxConcurrency + 10) {
        EventEmitter.defaultMaxListeners = maxConcurrency + 10;
      }
      try {
        const { coreEvents } = await import('@google/gemini-cli-core');
        coreEvents.setMaxListeners(Math.max(coreEvents.getMaxListeners(), maxConcurrency + 10));
      } catch { /* gemini-cli-core not installed — no-op */ }

      const initRunDir = () => {
        ctx.runDir = createRunDir(projectRoot, runId);
        const runLogPath = join(ctx.runDir, 'anatoly.ndjson');
        ctx.runLog = createFileLogger(runLogPath);
        ctx.runLog.info({ runId, concurrency, projectRoot }, 'run started');

        // Mirror `rag.query` observability events into the per-run ndjson trail.
        // The global logger only surfaces info-level events at `--verbose` or
        // above; this ensures every retrieval (who, when, what, returned what)
        // is captured in `.anatoly/runs/<runId>/anatoly.ndjson` by default.
        const runLogRef = ctx.runLog;
        setRagQueryTrail((event) => runLogRef.info(event, 'rag.query'));

        const runConfig = buildRunConfig({
          runId,
          projectRoot,
          concurrency,
          ragMode: ctx.ragMode,
          enableRag: ctx.enableRag,
          noCache: ctx.noCache,
          rebuildRag: ctx.rebuildRag,
          deliberation: ctx.deliberation,
          dryRun: ctx.dryRun,
          axesFilter: ctx.axesFilter,
          fileFilter: ctx.fileFilter,
          badge: ctx.badge,
          config: ctx.config,
        });
        writeRunConfig(ctx.runDir, runConfig);

        // Write initial 'running' status for foreground visibility (Story 53.1)
        ctx.gitInfo = getGitInfo(projectRoot);
        const runStatus: RunStatus = {
          runId: ctx.runId,
          pid: process.pid,
          status: 'running',
          startedAt: new Date(ctx.startTime).toISOString(),
          branch: ctx.gitInfo.branch,
          commit: ctx.gitInfo.commit,
          background: !!process.env.ANATOLY_BACKGROUND_MODE,
        };
        writeRunStatus(ctx.runDir, runStatus);
      };

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
        await runWithContext({ runId }, async () => {
        const setup = await runSetupPhase(ctx);
        if (ctx.dryRun) return;
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          return;
        }

        // User confirmed the pipeline summary — materialize the run dir now.
        initRunDir();

        // Open the per-call LLM sink for the remainder of the run. Transports
        // emit records via recordLlmCall(), persisted to costs/ledger.ndjson.
        enterLlmCallSink(join(ctx.runDir, 'costs', 'ledger.ndjson'));

        // Detect first run — Story 29.21. The doc ledger lives next to the
        // docs under ctx.projectRoot (runDocScaffold/runDocGeneration write
        // there), so all flag I/O uses ctx.projectRoot. In non-worktree runs
        // this equals the old effectiveSourceRoot; in worktree it now
        // correctly points where the docs actually are.
        ctx.isFirstRun = needsBootstrap(ctx.projectRoot);

        // Initialize pipeline display
        const pipelineState = new PipelineState();
        if (ctx.router) {
          pipelineState.setRouter(ctx.router);
        }
        if (ctx.isFirstRun && isDocAxisActive(ctx)) {
          pipelineState.addTask('bootstrap-doc', 'Bootstrapping internal docs');
        }
        if (ctx.enableRag) {
          pipelineState.addTask('rag-code', 'Embedding code');
          pipelineState.addTask('rag-nlp', 'LLM summaries & embedding');
          pipelineState.addTask('rag-doc-project', 'Chunking & embedding project docs');
          pipelineState.addTask('rag-doc-internal', 'Chunking & embedding internal docs');
        }
        pipelineState.addTask('internal-docs', 'Updating internal docs');
        pipelineState.addTask('review', 'Reviewing files');
        if (ctx.deliberation) {
          pipelineState.addTask('refinement', 'Deliberation');
        }
        pipelineState.addTask('report', 'Generating report');
        ctx.pipelineState = pipelineState;

        const renderer = new ScreenRenderer(pipelineState, { plain: ctx.plain });
        ctx.renderer = renderer;
        renderer.start();

        // Background runs skip the global lock — they run in isolated worktrees
        // and use per-run status files for coordination (Story 47.6)
        if (!process.env.ANATOLY_BACKGROUND_MODE) {
          ctx.lockPath = acquireLock(projectRoot);
        }

        // --- Phase: bootstrap doc (first run only, skipped in quick-win) — Story 29.21 ---
        // Mode guards: `off` skips everything; `lite` defers doc context to
        // per-file RAG retrieval (no upfront digest, see `retrieveRelevantDocsForFile`);
        // `full` keeps the existing scaffold + generation + coherence + arbitration.
        const internalDocMode = resolveDocMode(ctx.config);
        if (internalDocMode === 'off' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=off — skipping scaffold, generation, and coherence');
          ctx.renderer?.logPlain('[internal-docs] mode=off — skipping scaffold, generation, and coherence');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'off');
        } else if (internalDocMode === 'lite' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=lite — doc context delivered via per-file RAG retrieval (no digest)');
          ctx.renderer?.logPlain('[internal-docs] mode=lite — doc context delivered via per-file RAG retrieval');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'lite (per-file retrieval)');
        } else if (ctx.isFirstRun && isDocAxisActive(ctx) && !ctx.interrupted) {
          await runPhase(ctx, 'bootstrap-doc', async () => {
            await runDocBootstrap(ctx, setup.tasks);
          });
          // Mark the docs as validly scaffolded — the canonical signal
          // future `needsBootstrap()` checks will look for. Written after
          // runDocBootstrap returns (which itself includes the refinement
          // pass), so a crash mid-pipeline leaves no tag and the next run
          // correctly re-bootstraps.
          if (!ctx.interrupted) {
            writeScaffoldStatus(ctx.projectRoot, {
              mode: 'bootstrap',
              runId: ctx.runId,
            });
          }

          // Run doc-conflict detection after bootstrap — Story 55.4 FR5
          if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-bootstrap', async () => {
              await runDocConflictDetection({
                projectRoot: ctx.projectRoot,
                config: ctx.config,
                tasks: setup.tasks,
                fragmentsDir,
                runDir: ctx.runDir,
                ...(ctx.router ? { router: ctx.router } : {}),
              });
            });
          }
        }

        const ragContext = await runPhase(ctx, 'rag-index', async () => runRagPhase(ctx, setup.tasks));
        if (ctx.interrupted) return;

        // --- Phase: update internal docs (pre-review) — Story 55.2 ---
        // Moved from post-review to pre-review so that doc-conflict arbitration
        // results are available during the review phase of the current run.
        // Gate: triage-based (evaluable files exist) instead of filesReviewed > 0.
        const hasEvaluableFiles = [...setup.triageMap.values()].some(t => t.tier === 'evaluate');
        if (internalDocMode === 'off' && !ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'off');
        } else if (internalDocMode === 'lite' && !ctx.interrupted) {
          // Lite mode no longer materialises an internal-docs artefact at
          // run scope. Reference content reaches the axes per file via RAG
          // retrieval (see file-evaluator → retrieveRelevantDocsForFile).
          ctx.pipelineState?.completeTask('internal-docs', 'lite (per-file retrieval)');
        } else if (internalDocMode !== 'lite' && internalDocMode !== 'off' && !ctx.interrupted && hasEvaluableFiles) {
          await runPhase(ctx, 'internal-docs', async () => {
            await runDocUpdate(ctx, setup.tasks);
          });

          // Re-index doc sections that changed after the doc-update pipeline.
          // Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate
          // chunk cache → restart embedding containers → re-embed + upsert → stop.
          if (ctx.enableRag && ctx.resolvedRagMode && ragContext.vectorStore) {
            await reindexDocsAfterUpdate(ctx, ragContext.vectorStore);
          }

          // Refresh the pipeline-complete marker to record this update.
          if (!ctx.interrupted) {
            writeScaffoldStatus(ctx.projectRoot, {
              mode: 'update',
              runId: ctx.runId,
            });
          }

          // Run doc-conflict detection after update — Story 55.4 FR5
          if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-update', async () => {
              await runDocConflictDetection({
                projectRoot: ctx.projectRoot,
                config: ctx.config,
                tasks: setup.tasks,
                fragmentsDir,
                runDir: ctx.runDir,
                ...(ctx.router ? { router: ctx.router } : {}),
              });
            });
          }
        } else if (!ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'skipped — no evaluable files');
        }
        // Story 55.7: load doc-wins arbitrated fragments for axis prompts
        if (!ctx.interrupted) {
          ctx.arbitratedFragments = loadArbitratedFragments(ctx.projectRoot);
        }

        if (ctx.interrupted) return;

        // --- Phase: review (pass 1) ---
        await runPhase(ctx, 'review', async () => {
          await runReviewPhase(ctx, setup.triageMap, setup.usageGraph, ragContext, setup.depMeta, setup.projectTree, setup.docsTree, setup.internalDocsTree, setup.internalDocsDir);
        });
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote} | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        // --- Phase: refinement (tier 1 → tier 2 → tier 3) — Story 41.5 ---
        if (ctx.deliberation && ctx.filesReviewed > 0 && !ctx.interrupted) {
          await runPhase(ctx, 'refinement', () => runRefinementStage(ctx, setup));
        } else if (!ctx.interrupted && ctx.filesReviewed > 0) {
          ctx.pipelineState?.completeTask('refinement', 'skipped — deliberation disabled');
        }

        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${ctx.filesReviewed}/${ctx.totalFiles} files reviewed | ${ctx.totalFindings} findings${inFlightNote} | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        await runPhase(ctx, 'report', async () => { runReportPhase(ctx); });

        // Desktop notification for background runs (Story 47.5)
        if (process.env.ANATOLY_BACKGROUND_MODE && cmdOpts.notify !== false) {
          sendDesktopNotification(
            'Anatoly',
            `Review complete — ${ctx.totalFindings} finding${ctx.totalFindings !== 1 ? 's' : ''} in ${ctx.totalFiles} file${ctx.totalFiles !== 1 ? 's' : ''}`,
          );
        }

        if (ctx.lockPath) releaseLock(ctx.lockPath);
        ctx.lockPath = undefined;
        });
      } catch (error) {
        if (ctx.lockPath) releaseLock(ctx.lockPath);
        if (error instanceof AnatolyError && error.preformatted) {
          // Throw site already produced a fully styled multi-line block
          // (e.g. provider-auth box) — print it verbatim.
          console.error(error.message);
        } else if (error instanceof AnatolyError) {
          printNotice({
            kind: 'error',
            title: error.message,
            ...(error.details ? { details: [...error.details] } : {}),
            ...(error.hint ? { hint: error.hint } : {}),
          });
        } else {
          printNotice({
            kind: 'error',
            title: String(error),
          });
        }

        // Persist failed status — transition to 'failed' (Story 53.1)
        if (ctx.runDir) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const gi = ctx.gitInfo ?? getGitInfo(ctx.projectRoot);
          const failedStatus: RunStatus = {
            runId: ctx.runId,
            pid: process.pid,
            status: 'failed',
            startedAt: new Date(ctx.startTime).toISOString(),
            completedAt: new Date().toISOString(),
            error: errMsg,
            branch: gi.branch,
            commit: gi.commit,
            background: !!process.env.ANATOLY_BACKGROUND_MODE,
          };
          writeRunStatus(ctx.runDir, failedStatus);

          // Write error.log and send desktop notification for background runs
          if (process.env.ANATOLY_BACKGROUND_MODE) {
            try {
              writeFileSync(join(ctx.runDir, 'error.log'), `${new Date().toISOString()} ${errMsg}\n${error instanceof Error ? error.stack ?? '' : ''}\n`);
            } catch { /* best-effort */ }

            // Desktop notification (Story 47.5)
            if (cmdOpts.notify !== false) {
              sendDesktopNotification('Anatoly', `Review failed: ${errMsg}`);
            }
          }
        }

        process.exitCode = 2;
      } finally {
        ctx.renderer?.stop();
        await stopGgufContainers(); // no-op if no containers running
        await stopTeiContainers(); // no-op if no containers running
        flushFileLogger();
        setRagQueryTrail(undefined);
        process.removeListener('SIGINT', onSigint);

        // Cleanup worktree on error for background runs (Story 47.3)
        if (process.env.ANATOLY_BACKGROUND_MODE && ctx.sourceRoot) {
          try {
            const wm = createWorktreeManager(ctx.projectRoot);
            await wm.remove(ctx.runId);
          } catch { /* best-effort cleanup */ }
        }
      }
    });
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

  // Fail-fast: a provider circuit breaker tripped during an earlier phase
  // (e.g. doc-conflict-update) is still open when review starts moments
  // later — its half-open delay has not elapsed. Proceeding would fast-fail
  // every axis on every file and silently produce a report whose
  // un-evaluated axes render as "clean". Stop the run with an actionable
  // error instead of publishing a misleading green report.
  const openProviders = ctx.router
    ? [...ctx.router.breakers.entries()].filter(([, b]) => b.isOpen()).map(([id]) => id)
    : [];
  if (openProviders.length > 0) {
    requestFatalStop(ctx, circuitOpenError(openProviders.join(', ')));
    return;
  }

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
    // --no-cache: BYPASS the cache, never destroy it. Mark CACHED files as
    // PENDING so they're re-evaluated this run. cacheReview() and
    // writeProjectReview() are gated separately to skip writes too. If the
    // run fails, the cache on disk is unchanged — `anatoly reset` is the
    // command that actually wipes it.
    log.info('--no-cache: bypassing cache for this run (no files deleted).');
    for (const [, fp] of Object.entries(progress.files)) {
      if (fp.status === 'CACHED') pm.updateFileStatus(fp.file, 'PENDING');
    }
  }

  let pending = pm.getPendingFiles();
  if (ctx.fileFilter) {
    const isMatch = picomatch(ctx.fileFilter);
    pending = pending.filter((fp) => isMatch(fp.file));
  }

  // Collect cached files so they flow through the handler for accurate metrics + display
  const currentProgress = pm.getProgress();
  const cachedFiles = Object.values(currentProgress.files).filter((f) => f.status === 'DONE' || f.status === 'CACHED');

  if (pending.length === 0 && cachedFiles.length === 0) {
    console.log('anatoly — review');
    console.log('  No pending files to review.');
    console.log('');
    return;
  }

  ctx.totalFiles = pending.length + cachedFiles.length;
  // Story 53.5 FR6: announce total file count so `anatoly attach` can render
  // the progress bar denominator (pending + cached).
  rl?.info({ event: 'estimate_total', phase: 'review', total: ctx.totalFiles, pending: pending.length, cached: cachedFiles.length }, 'estimate total');

  const allTasks = loadTasks(getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot));
  const taskMap = new Map<string, Task>();
  for (const t of allTasks) taskMap.set(t.file, t);

  const reviewItems: Array<{ filePath: string; task: Task; cached: boolean }> = [
    // Cached files first — instant, no API call
    ...cachedFiles
      .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file), cached: true }))
      .filter((item): item is { filePath: string; task: Task; cached: boolean } => item.task !== undefined),
    // Pending files — actual evaluation
    ...pending
      .map((fp) => ({ filePath: fp.file, task: taskMap.get(fp.file), cached: false }))
      .filter((item): item is { filePath: string; task: Task; cached: boolean } => item.task !== undefined),
  ];

  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  if (ctx.axesFilter) {
    warnDisabledAxes(ctx.axesFilter, evaluators.map((e) => e.id));
  }
  const axisIds = evaluators.map((e) => e.id);
  const reviewModelId = evaluators.map((e) => resolveAxisModel(e, ctx.config)).sort().join('+');
  const reviewPromptHash = computeAxesPromptHash(axisIds, reviewModelId);
  // A file counts toward evaluateTotal when at least one axis evaluator
  // actually runs on it. Skip-tier files with a partial-axes policy
  // (e.g. trivial files keeping correction/duplication/utility via
  // evaluatorAxesForSkip) DO trigger completedCount++ in the handler,
  // so they must be included here — otherwise completedCount can exceed
  // evaluateTotal and produce displays like "13/12".
  const evaluateTotal = reviewItems.filter((item) => {
    if (item.cached) return false;
    if (!ctx.triageEnabled) return true;
    const triage = triageMap.get(item.filePath);
    if (triage?.tier !== 'skip') return true;
    // Skip-tier file: include only if the partial-axes policy keeps at
    // least one axis running for this skip reason.
    const partialAxes = evaluatorAxesForSkip(triage.reason);
    return evaluators.some((e) => partialAxes.has(e.id));
  }).length;
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
      const { filePath, task, cached } = item;
      await runWithContext({ file: filePath, worker: workerIndex }, async () => {

      // Handle cached files: load existing review, count findings, display [CACHED]
      if (cached) {
        const cachedReview = loadCachedReview(ctx.projectRoot, filePath, evaluators.map((e) => e.id), reviewPromptHash, ctx.sourceRoot);
        if (cachedReview) {
          // Copy into current run dir so the report is complete
          writeReviewOutput(ctx.projectRoot, cachedReview, ctx.runDir);
          ctx.filesReviewed++;
          ctx.reviewCounts.cached++;
          ctx.totalFindings += countReviewFindings(cachedReview, 60);
          if (ctx.plain) {
            const findings = countReviewFindings(cachedReview);
            const note = findings > 0 ? ` | ${findings} findings` : '';
            ctx.renderer?.logPlain(`[review] [CACHED] ${filePath} → ${cachedReview.verdict}${note}`);
          }
          rl?.info({ event: 'file_cached', phase: 'review', file: filePath, verdict: cachedReview.verdict }, 'file loaded from cache');
          // Story 53.5 FR6: drive attach progress bar
          rl?.info({ event: 'file_review_end', phase: 'review', file: filePath, verdict: cachedReview.verdict, source: 'cache' }, 'file review end');
        }
        return;
      }

      const triage = triageMap.get(filePath);

      // Determine which evaluators actually run for this file. Skip-tier
      // files used to bypass every axis with blanket safe defaults; we
      // now apply per-skip-reason policy: trivial files still get
      // correction/duplication/utility (small surface, real signal),
      // while barrel-export / type-only / constants-only fall through
      // to the pure synthetic-review path.
      const isSkipTier = ctx.triageEnabled && triage?.tier === 'skip';
      const partialAxesOnSkip = isSkipTier
        ? evaluatorAxesForSkip(triage.reason)
        : null;
      const fileEvaluators = partialAxesOnSkip
        ? evaluators.filter((e) => partialAxesOnSkip.has(e.id))
        : evaluators;

      // Pure-skip path: triage decided no axis should run on this file.
      // Generate a synthetic review; the usage graph still resolves the
      // utility verdict per symbol so unused type/constant exports
      // surface as DEAD instead of blanket USED.
      if (isSkipTier && fileEvaluators.length === 0) {
        pm.updateFileStatus(filePath, 'IN_PROGRESS');
        const skipReview = generateSkipReview(task, triage.reason, ctx.axesFilter, usageGraph);
        writeReviewOutput(ctx.projectRoot, skipReview, ctx.runDir);
        if (!ctx.noCache) cacheReview(ctx.projectRoot, skipReview, reviewPromptHash, reviewModelId, axisIds, ctx.sourceRoot);
        pm.updateFileStatus(filePath, 'DONE', undefined, evaluators.map(e => e.id));
        ctx.filesReviewed++;
        ctx.reviewCounts.skipped++;
        rl?.info({ event: 'file_skip', phase: 'review', file: filePath, reason: triage.reason }, 'file skipped');
        // Story 53.5 FR6: drive attach progress bar
        rl?.info({ event: 'file_review_end', phase: 'review', file: filePath, verdict: skipReview.verdict, source: 'skip' }, 'file review end');
        return;
      }

      // Evaluate tier (or skip tier with a partial axis set): run the
      // selected axis evaluators. Axes not in fileEvaluators are filled
      // with '-' by the merger (axes-not-evaluated semantic).
      pm.updateFileStatus(filePath, 'IN_PROGRESS');
      state.trackFile(filePath, { axesTotal });
      rl?.info({ event: 'file_review_start', file: filePath, phase: 'review', worker: workerIndex, tier: triage?.tier ?? 'evaluate', symbolCount: task.symbols?.length ?? 0, axes: fileEvaluators.map((e) => e.id), partialSkip: isSkipTier }, 'file review started');
      ctx.timeline.push({ t: Date.now() - ctx.startTime, event: 'file_review_start', file: filePath });

      let currentAbort = new AbortController();
      ctx.activeAborts.add(currentAbort);
      let timedOut = false;

      try {
        const runEval = () => retryWithBackoff(
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
              sourceRoot: ctx.sourceRoot,
              task,
              config: ctx.config,
              evaluators: fileEvaluators,
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
              arbitratedFragments: ctx.arbitratedFragments,
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
            isInterrupted: () => ctx.interrupted || timedOut,
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
        // Wall-clock budget per file: the agentic axes have no SDK-level
        // timeout, so a single stuck file would otherwise hang the review
        // worker pool indefinitely. `currentAbort` is read live (it may be
        // re-created across retries), so the abort always hits the active call.
        const result = await withTimeout(runEval, {
          timeoutMs: ctx.config.runtime.timeout_per_file * 1000,
          label: `review ${filePath}`,
          onTimeout: () => {
            timedOut = true;
            currentAbort.abort();
          },
        });

        writeReviewOutput(ctx.projectRoot, result.review, ctx.runDir);
        writeTranscript(ctx.projectRoot, filePath, result.transcript, ctx.runDir);
        const succeededAxes = result.failedAxes.length > 0
          ? fileEvaluators.map(e => e.id).filter(id => !result.failedAxes.includes(id))
          : fileEvaluators.map(e => e.id);
        // Every axis evaluator crashed: `result.review` is all-default
        // placeholder verdicts (OK/UNIQUE/LEAN…), not a real evaluation.
        // Caching it or marking the file DONE would make the next run serve
        // this phantom "clean" review and permanently hide that the file was
        // never evaluated. Record it as a file-level error so it is
        // re-reviewed next run and counted honestly in run metrics; the
        // review output is still written so the file surfaces in THIS run's
        // Degraded Reviews section.
        const allAxesCrashed = fileEvaluators.length > 0 && succeededAxes.length === 0;
        if (allAxesCrashed) {
          const msg = `all ${fileEvaluators.length} axis evaluators crashed`;
          pm.updateFileStatus(filePath, 'ERROR', msg);
          ctx.errorCount++;
          ctx.errorsByCode[ERROR_CODES.AXES_ALL_FAILED] = (ctx.errorsByCode[ERROR_CODES.AXES_ALL_FAILED] ?? 0) + 1;
          ctx.errorDetails.push({ file: filePath, code: ERROR_CODES.AXES_ALL_FAILED, message: msg });
          ctx.degradedReviews++;
          completedCount++;
        } else {
          if (!ctx.noCache) cacheReview(ctx.projectRoot, result.review, reviewPromptHash, reviewModelId, axisIds, ctx.sourceRoot);
          pm.updateFileStatus(filePath, 'DONE', undefined, succeededAxes);
          ctx.filesReviewed++;
          ctx.reviewCounts.evaluated++;
          ctx.freshFiles.add(filePath);
          completedCount++;
          ctx.totalFindings += countReviewFindings(result.review, 60);
          if (result.failedAxes.length > 0) {
            ctx.degradedReviews++;
          }
        }
        // Story 53.5 FR6: drive attach progress bar + finding ticker. A single
        // emission below (line ~2670 with the full review fields) carries the
        // same event name — we previously emitted twice per file, which made
        // the attach progress counter double-count (e.g. 26/13 = 200%).
        for (const at of result.axisTiming) {
          recordLlmCost(ctx, {
            provider: at.provider,
            phase: 'review',
            axis: at.axisId,
            costUsd: at.costUsd,
            durationMs: at.durationMs,
            inputTokens: at.inputTokens,
            outputTokens: at.outputTokens,
            cacheReadTokens: at.cacheReadTokens,
            cacheCreationTokens: at.cacheCreationTokens,
          });
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
        // Run-fatal during review: provider-auth failure OR an open circuit
        // breaker. file-evaluator propagates these instead of degrading the
        // file, so they land here. A circuit-broken review is worthless
        // (every non-cached file fails) — stop now and fail the run loudly
        // instead of silently finishing `done` on stale cache.
        if (isFatalAuthError(error) || isCircuitOpenError(error)) {
          requestFatalStop(ctx, error);
          return;
        }
        if (ctx.interrupted) return;

        const message = error instanceof AnatolyError ? error.message : String(error);
        const errorCode = error instanceof AnatolyError ? error.code : 'UNKNOWN';
        pm.updateFileStatus(filePath, errorCode === 'SDK_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message);
        ctx.errorCount++;
        ctx.errorsByCode[errorCode] = (ctx.errorsByCode[errorCode] ?? 0) + 1;
        ctx.errorDetails.push({ file: filePath, code: errorCode, message });
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

  log.info({ filesReviewed: ctx.filesReviewed, findings: ctx.totalFindings, concurrency: ctx.concurrency }, 'review details');
  rl?.info({ filesReviewed: ctx.filesReviewed, findings: ctx.totalFindings, concurrency: ctx.concurrency }, 'review details');
}


/**
 * Filter a review to only contain data for the specified enabled axes.
 * Blanks disabled axis verdicts to '-' and removes disabled-axis actions.
 */
function filterReviewAxes(review: ReviewFile, enabledAxes: AxisId[]): ReviewFile {
  const enabledSet = new Set<AxisId>(enabledAxes);
  const disabledSymbolAxes: Array<{ key: keyof import('../schemas/review.js').SymbolReview; axis: AxisId }> = [
    { key: 'correction', axis: 'correction' },
    { key: 'utility', axis: 'utility' },
    { key: 'duplication', axis: 'duplication' },
    { key: 'overengineering', axis: 'overengineering' },
    { key: 'tests', axis: 'tests' },
    { key: 'documentation', axis: 'documentation' },
  ];

  const filteredSymbols = review.symbols.map((s) => {
    const next = { ...s };
    for (const { key, axis } of disabledSymbolAxes) {
      if (!enabledSet.has(axis) && next[key] !== '-') {
        (next as Record<string, unknown>)[key] = '-';
      }
    }
    if (!enabledSet.has('duplication')) next.duplicate_target = undefined;
    return next;
  });

  const disabledActionSources = new Set<string>();
  for (const axis of ['correction', 'utility', 'duplication', 'overengineering', 'tests', 'documentation', 'best_practices'] as AxisId[]) {
    if (!enabledSet.has(axis)) disabledActionSources.add(axis);
  }
  if (!enabledSet.has('best_practices')) disabledActionSources.add('best-practices');

  const filteredActions = review.actions.filter((a) => !a.source || !disabledActionSources.has(a.source));
  const bestPractices = enabledSet.has('best_practices') ? review.best_practices : undefined;

  return { ...review, symbols: filteredSymbols, actions: filteredActions, best_practices: bestPractices };
}

/**
 * Load a single cached review from the project-local content-addressable store.
 * Returns the parsed ReviewFile or undefined if not found / malformed.
 *
 * Both `enabledAxes` and `promptHash` are required: the cache key depends on
 * both, and callers that want to bypass cache should simply not call this.
 *
 * Falls back to the pre-Story-52.4 path-based cache layout when the new store
 * has no entry, so projects upgrading from an older anatoly version don't
 * lose every cached review at once. The legacy fallback is read-only and
 * will be removed in a future release.
 *
 * Filters out stale data for axes that are no longer enabled in the current config.
 */
function loadCachedReview(projectRoot: string, filePath: string, enabledAxes: AxisId[], promptHash: string, sourceRoot?: string): ReviewFile | undefined {
  const effectiveRoot = getEffectiveSourceRoot(projectRoot, sourceRoot);
  const absPath = resolve(effectiveRoot, filePath);

  let fileContent: string;
  try {
    fileContent = readFileSync(absPath, 'utf-8');
  } catch (err) {
    getLogger().debug({ file: filePath, err }, 'cache lookup skipped: source file unreadable');
    return undefined;
  }

  // Current content-addressable cache (post-Story-52.4)
  const cached = loadProjectReview(projectRoot, filePath, fileContent, promptHash, enabledAxes);
  if (cached) return filterReviewAxes(cached, enabledAxes);

  // Transitional: legacy path-based cache. Warns once per process on first hit.
  const legacy = loadLegacyPathBasedReview(projectRoot, filePath);
  if (legacy) return filterReviewAxes(legacy, enabledAxes);

  return undefined;
}

/**
 * Compute a combined prompt hash for all enabled axis system prompts.
 * Used as the `prompt_hash` in shared review cache `_meta` headers.
 */
function computeAxesPromptHash(axisIds: string[], modelId: string): string {
  const sortedAxes = [...axisIds].sort();
  const systemPrompts = sortedAxes.map((id) => {
    try { return resolveSystemPrompt(id); } catch { return id; }
  }).join('\0');
  return computePromptHash({
    schemaVersion: 1,
    modelId,
    systemPrompt: systemPrompts,
    userTemplate: '', // User template varies per file — we use content hash for that
  });
}

/**
 * Persist a review to the project-local content-addressable store.
 * Failures are silently swallowed (non-fatal, logged at debug level).
 *
 * @param projectRoot Absolute path to the project root.
 * @param review Parsed review file to cache.
 */
function cacheReview(
  projectRoot: string,
  review: ReviewFile,
  promptHash: string,
  modelId: string,
  axes: string[],
  sourceRoot?: string,
): void {
  const effectiveRoot = getEffectiveSourceRoot(projectRoot, sourceRoot);
  try {
    const absPath = resolve(effectiveRoot, review.file);
    const fileContent = readFileSync(absPath, 'utf-8');
    writeProjectReview(projectRoot, review, fileContent, promptHash, modelId, axes);
  } catch (err) {
    getLogger().debug({ file: review.file, err }, 'failed to write project review cache (non-fatal)');
  }
}
