// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { writeFileSync, existsSync } from 'node:fs';

import { resolve } from 'node:path';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { loadConfig, getV3Source } from '../utils/config-loader.js';
import { ensurePricing } from '../utils/pricing-cache.js';
import { enumerateActiveModels } from '../utils/active-models.js';
import { type Config } from '../schemas/config.js';
import { releaseLock } from '../utils/lock.js';
import { sendDesktopNotification } from '../core/notifications/desktop.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { type RagMode } from '../rag/index.js';
import { setRagQueryTrail } from '../rag/vector-store.js';
import { findExternalConfigIssues } from '../rag/known-embedding-providers.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, type ResolvedModels } from '../rag/hardware-detect.js';
import { stopGgufContainers } from '../rag/docker-gguf.js';
import { stopTeiContainers } from '../rag/docker-tei.js';
import { generateRunId, isValidRunId, createRunDir, countEmptyRuns, RUNS_REMOVE_EMPTY_CMD, readLatestPointer, listRuns, resolveRunDir } from '../utils/run-id.js';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { runErrorLogPath, runEventLogPath } from '../utils/run-layout.js';
import { getLogger, createFileLogger, flushFileLogger } from '../utils/logger.js';
import { loadUserInstructions } from '../utils/user-instructions.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';
import { parseAxesOption } from '../utils/axes-filter.js';
import { checkAnthropicAuth } from '../utils/anthropic-auth.js';
import { recordingModeFromEnv } from '../core/transports/recording-transport.js';
import { renderProviderAuthBox } from '../utils/provider-auth.js';
import { saveDeliberationMemory } from '../core/platform/index.js';
import { type AxisId } from '../core/evaluation/index.js';
import { ALL_AXIS_IDS } from '../core/evaluation/index.js';
import { TransportRouter } from '../core/transports/index.js';
import { AnthropicTransport } from '../core/transports/anthropic-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import { printBanner } from '../utils/banner.js';
import { printNotice } from '../utils/notice.js';
import { buildRunConfig, writeRunConfig, readRunConfig, resolveResumedScope, type RunConfig } from '../core/run/index.js';
import { runInitSubprocess, writeFirstRunConfig, runRagSetup } from '../cli/setup-prompts.js';
import { quickInitDocConfig } from '../core/documentation/index.js';
import { type ProjectProfile } from '../core/scanning/index.js';
import { launchBackgroundRun, buildForwardedArgs } from '../core/run/index.js';
import { writeRunStatus, getGitInfo, detectResumableRun, type RunStatus } from '../core/run/index.js';
import { createWorktreeManager } from '../core/worktree/index.js';
import { runPipeline } from '../core/orchestration/pipeline.js';

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
  /** Skip review cache — re-evaluate all files. Does NOT write fresh
   *  results back to the cache; the on-disk store is left untouched. */
  noCache: boolean;
  /** Force re-evaluation of every file (like --no-cache) AND write the
   *  fresh results back to the cache, overwriting stale entries. Useful
   *  after a tool-internal logic change (e.g. an evaluator bug fix) where
   *  the prompt hash is unchanged but the cached verdict is no longer
   *  correct. Mutually exclusive with `noCache`. */
  cacheRefresh: boolean;
  /** Promote TIMEOUT files to PENDING at review-phase start so a previous
   *  run's timed-out files get another attempt (opt-in via --retry-timeout). */
  retryTimeout: boolean;
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
  /** Count of skipped (triage), cached (previous run), and evaluated files */
  reviewCounts: { skipped: number; cached: number; evaluated: number };
  /** Files freshly reviewed (not cached) this run — used to invalidate deliberation cache */
  freshFiles: Set<string>;
  /** Epoch timestamp when the run started */
  startTime: number;
  /** Whether multi-axis deliberation is enabled */
  deliberation: boolean;
  /** Whether the pre-deliberation invariants phase is enabled (default false) */
  invariants: boolean;
  /** Whether the deterministic flows phase (doc 23, Stage 1) is enabled (default true; also gates the flow-doc narration phase) */
  flows: boolean;
  /** Accumulated phase durations for run-metrics.json */
  phaseDurations: Record<string, number>;
  /** Total LLM cost accumulated across all review phases */
  totalCostUsd: number;
  /** Error count for error summary */
  errorCount: number;
  /** Errors aggregated by code for end-of-run summary */
  errorsByCode: Record<string, number>;
  /** Per-file error details for end-of-run summary */
  errorDetails: Array<{ file: string; code: string; message: string; phase: string; axesInFlight?: string[] }>;
  /** Number of files where at least one axis evaluator crashed */
  degradedReviews: number;
  /** Per-axis aggregated stats for run-metrics.json */
  axisStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
  /** Per-phase aggregated stats for run-metrics.json (mirrors axisStats but keyed by pipeline phase, including non-axis phases like rag-index, doc-generation, coherence-review, refinement). */
  phaseStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
  /** Per-provider call counts and cost (Story 39.2) */
  providerStats: { anthropic: { calls: number; costUsd: number } };
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
  /** Quick-win preset active — reduced axis set (utility + duplication + correction) */
  quickWin: boolean;
  /** Unified project profile — set during setup, used by doc pipeline */
  profile?: ProjectProfile;
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
    .option('--resume', 'resume the previous run: reuse its run directory (artifacts + ledger appended in-place), skip files already DONE, retry TIMEOUT/ERROR/IN_PROGRESS files. Picks the run via .anatoly/runs/latest. Implies --retry-timeout. Mutually exclusive with --run-id.')
    .option('--axes <list>', 'comma-separated axes: utility,duplication,correction,overengineering,tests,best_practices')
    .option('--no-cache', 'ignore SHA-256 cache for this run, re-review all files; on-disk cache is left untouched (does not refresh stale entries)')
    .option('--cache-refresh', 'force re-evaluation of every file AND overwrite the on-disk cache with the fresh results (mutually exclusive with --no-cache; use this after a tool-internal fix that changes verdicts without changing the prompt hash)')
    .option('--retry-timeout', 'also re-evaluate files left in TIMEOUT status by a previous run (defaults to false — TIMEOUTs persist until explicitly retried)')
    .option('--file <glob>', 'restrict scope to matching files')
    .option('--concurrency <n>', 'number of concurrent reviews (1-10)', parseInt)
    .option('--sdk-concurrency <n>', 'max concurrent SDK calls (1-20)', parseInt)
    .option('--rebuild-rag', 'force full RAG re-indexation')
    .option('--code-model <model>', 'embedding model for code vectors (default: auto-detect)')
    .option('--nlp-model <model>', 'embedding model for NLP vectors (default: auto-detect)')
    .option('--no-triage', 'disable triage, review all files with full agent')
    .option('--deliberation', 'enable Opus deliberation pass after axis merge')
    .option('--no-deliberation', 'disable deliberation pass')
    .option('--invariants', 'enable the pre-deliberation invariants phase (cross-representation consistency)')
    .option('--flows', 'enable the deterministic user-flow modeling phase (doc 23, Stage 1; no-LLM, opt-in)')
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
      cache?: boolean; cacheRefresh?: boolean; retryTimeout?: boolean; resume?: boolean; file?: string; concurrency?: number; sdkConcurrency?: number;
      rebuildRag?: boolean; codeModel?: string; nlpModel?: string;
      triage?: boolean; deliberation?: boolean; invariants?: boolean; flows?: boolean;
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

      // Auto-detect an incomplete previous run and propose to resume it —
      // unless the user already expressed explicit run-selection intent
      // (--resume, --run-id, --background) or asked for non-interactive
      // execution (--defaults-settings, --quick-win, no TTY). Without this
      // prompt, a `anatoly run` after a crash silently starts a fresh run
      // on top of the stale one, losing the in-place ledger continuity and
      // requiring the user to know about --resume.
      const canAutoPromptResume =
        process.stdin.isTTY === true
        && !cmdOpts.resume
        && !cmdOpts.runId
        && !cmdOpts.background
        && cmdOpts.defaultsSettings !== true
        && cmdOpts.quickWin !== true;
      if (canAutoPromptResume) {
        const resumable = detectResumableRun(projectRoot);
        if (resumable) {
          const label = resumable.state === 'failed'
            ? 'failed'
            : resumable.state === 'crashed'
              ? 'crashed'
              : 'stale (running but process gone)';
          const choice = await p.select({
            message: `Found an incomplete previous run (${resumable.runId}, ${label}). ${resumable.done} files done, ${resumable.pending} pending.`,
            options: [
              { value: 'resume', label: 'Resume in-place (recommended) — append to that run dir, retry TIMEOUT files' },
              { value: 'fresh', label: 'Start a fresh run — new run dir, the previous one is left untouched' },
              { value: 'cancel', label: 'Cancel — quit without doing anything' },
            ],
            initialValue: 'resume',
          });
          if (p.isCancel(choice) || choice === 'cancel') {
            getLogger().info('user cancelled after incomplete-run prompt');
            return;
          }
          if (choice === 'resume') {
            cmdOpts.resume = true;
          }
          // 'fresh' → leave cmdOpts.resume undefined; the rest of the flow
          // generates a brand new runId as usual.
        }
      }

      // --resume implies "use the previous run's config verbatim" — there is
      // nothing to ask the user about because the prior run already chose.
      // Treat it as --defaults-settings to skip every interactive prompt
      // (axes multiselect, end-of-setup choice, etc.). The user can still
      // override individual flags on the resume command line (e.g.
      // `--concurrency 4`) and those win as usual.
      const useDefaults = cmdOpts.defaultsSettings === true || cmdOpts.resume === true;
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

      // --resume: reuse the previous run directory (its artifacts, ledger,
      // anatoly.ndjson are appended in-place; progress.json keeps the
      // DONE/CACHED/TIMEOUT history so the same `anatoly run` resumes
      // exactly where it stopped). Implies --retry-timeout so files left in
      // limbo by a partial run get another attempt. Mutually exclusive with
      // --run-id to avoid ambiguous selection.
      if (cmdOpts.resume && cmdOpts.runId) {
        printNotice({
          kind: 'error',
          title: '--resume and --run-id are mutually exclusive',
          hint: 'omit one — --resume auto-picks the latest run from .anatoly/runs/latest',
        });
        process.exitCode = 2;
        return;
      }
      // --no-cache (read+write bypass) and --cache-refresh (force re-eval +
      // overwrite cache) make contradictory promises about the on-disk
      // store. Force the user to pick.
      if (cmdOpts.cache === false && cmdOpts.cacheRefresh === true) {
        printNotice({
          kind: 'error',
          title: '--no-cache and --cache-refresh are mutually exclusive',
          hint: '--no-cache bypasses the cache without touching it; --cache-refresh forces a re-eval AND overwrites the cache. Pick one.',
        });
        process.exitCode = 2;
        return;
      }
      let resolvedRunId: string | undefined;
      // The run-config snapshot of the run being resumed. Source of truth for
      // the run-scoped scope filters (axes, file) so a resume continues the
      // SAME audit instead of silently widening to the full config axis set.
      let resumedRunConfig: RunConfig | null = null;
      if (cmdOpts.resume) {
        const runsDir = anatolyPath(projectRoot, 'runs');
        resolvedRunId = readLatestPointer(runsDir) ?? listRuns(projectRoot)[0];
        if (!resolvedRunId) {
          printNotice({
            kind: 'error',
            title: '--resume: no previous run found under .anatoly/runs/',
            hint: 'run `anatoly run` once (without --resume) to produce a run to resume',
          });
          process.exitCode = 2;
          return;
        }
        // Imply --retry-timeout for resume so files left in TIMEOUT by the
        // prior partial run get another attempt automatically. The user can
        // still opt out by deleting/promoting individual statuses manually.
        cmdOpts.retryTimeout = true;
        const resumedRunDir = resolveRunDir(projectRoot, resolvedRunId);
        resumedRunConfig = resumedRunDir ? readRunConfig(resumedRunDir) : null;
        const resumedAxesNote = resumedRunConfig?.axesFilter
          ? ` | axes: ${resumedRunConfig.axesFilter.join(', ')}`
          : '';
        printNotice({
          kind: 'info',
          title: `resuming run ${resolvedRunId}`,
          hint: `artifacts will be appended in-place; --retry-timeout implied${resumedAxesNote}`,
        });
      }

      const runId = resolvedRunId ?? cmdOpts.runId ?? generateRunId();
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
      // On resume, restore the original axis/file scope from the resumed
      // run-config when the user didn't pass an explicit override. Without this
      // a resume loses the prior `--axes a,b,c` scope and re-expands to the full
      // config axis set (a "3 axes → 7 axes" full re-diff). Explicit flags win.
      const restoredScope = resolveResumedScope(resumedRunConfig, {
        axesFilter: axesResult,
        fileFilter: cmdOpts.file,
      });
      const axesFilter: AxisId[] | undefined = restoredScope.axesFilter;
      if (axesResult === undefined && axesFilter) {
        getLogger().info(`resume: restored axis filter ${axesFilter.join(', ')} from run-config`);
      }
      if (cmdOpts.file === undefined && restoredScope.fileFilter !== undefined) {
        cmdOpts.file = restoredScope.fileFilter;
        getLogger().info(`resume: restored file filter ${cmdOpts.file} from run-config`);
      }

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
      // Skipped in replay transport mode: the cassette serves every model
      // call, so no real `claude` CLI / API key is ever needed (hermetic
      // goldens run with ANATOLY_TRANSPORT=replay on a CI box without claude).
      if (config.providers.anthropic && recordingModeFromEnv() !== 'replay') {
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

      // Build mode-aware transport router
      const _nativeTransports: Record<string, import('../core/transports/index.js').LlmTransport> = {
        anthropic: new AnthropicTransport(),
      };
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
        runId,
        // Created lazily after the user confirms the pipeline summary so that
        // bailing at the prompt does not leave a phantom audit behind.
        runDir: '',
        concurrency,
        plain,
        verbose: parentOpts.verbose as boolean | undefined,
        fileFilter: cmdOpts.file,
        noCache: cmdOpts.cache === false,
        cacheRefresh: cmdOpts.cacheRefresh === true,
        retryTimeout: cmdOpts.retryTimeout === true,
        enableRag: parentOpts.rag !== false && config.rag.enabled,
        ragMode,
        rebuildRag: cmdOpts.rebuildRag,
        shouldOpen: parentOpts.open as boolean | undefined,
        triageEnabled: cmdOpts.triage !== false,
        deliberation: cmdOpts.deliberation !== undefined
          ? cmdOpts.deliberation
          : config.agents.enabled,
        // --invariants force-enables; otherwise honor config (default false).
        // No --no-invariants flag: the phase is opt-in while it matures.
        invariants: cmdOpts.invariants === true
          ? true
          : (config.invariants?.enabled ?? false),
        // --flows force-enables; otherwise honor config (default true). The
        // fallback mirrors the FlowsConfigSchema default so a config object
        // missing the section still runs the phase. No --no-flows flag yet
        // (disable via `flows: { enabled: false }` in the config).
        flows: cmdOpts.flows === true
          ? true
          : (config.flows?.enabled ?? true),
        interrupted: false,
        activeAborts: new Set(),
        reviewCounts: { skipped: 0, cached: 0, evaluated: 0 },
        freshFiles: new Set<string>(),
        startTime: Date.now(),
        phaseDurations: {},
        totalCostUsd: 0,
        errorCount: 0,
        errorsByCode: {},
        errorDetails: [],
        degradedReviews: 0,
        axisStats: {},
        phaseStats: {},
        providerStats: { anthropic: { calls: 0, costUsd: 0 } },
        timeline: [],
        axesFilter,
        dryRun,
        badge: {
          enabled: cmdOpts.badge !== false && config.badge.enabled,
          verdict: cmdOpts.badgeVerdict ?? config.badge.verdict,
          link: config.badge.link,
        },
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

      // Raise max listeners to account for concurrent SDK subprocess exit handlers.
      // Also bump events.defaultMaxListeners so child AbortSignal instances created
      // by the SDK during parallel primitive invocations (DAG executor fan-out)
      // don't trip the MaxListenersExceededWarning — epic 56 surfaced this by
      // running 7 axis primitives concurrently, each propagating the same parent
      // AbortSignal through the transport stack.
      const maxConcurrency = config.providers.anthropic?.concurrency ?? 8;
      process.setMaxListeners(Math.max(process.getMaxListeners(), maxConcurrency + 10));
      const { EventEmitter } = await import('node:events');
      if (EventEmitter.defaultMaxListeners < maxConcurrency + 10) {
        EventEmitter.defaultMaxListeners = maxConcurrency + 10;
      }

      const initRunDir = () => {
        ctx.runDir = createRunDir(projectRoot, runId);
        const runLogPath = runEventLogPath(ctx.runDir);
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
          cacheRefresh: ctx.cacheRefresh,
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
        await runPipeline(ctx, { runId, projectRoot, cmdOpts, initRunDir, resolvedModels: resolvedEmbedForPricing });
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
              writeFileSync(runErrorLogPath(ctx.runDir), `${new Date().toISOString()} ${errMsg}\n${error instanceof Error ? error.stack ?? '' : ''}\n`);
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
