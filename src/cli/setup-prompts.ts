// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { anatolyPath } from '../utils/anatoly-paths.js';
import yaml from 'js-yaml';
import { GGUF_MIN_VRAM_GB, readEmbeddingsReadyFlag, type HardwareProfile } from '../rag/hardware-detect.js';
import { prefetchLiteModels, type PrefetchProgress } from '../rag/embeddings-prefetch.js';
import { prefetchGgufModels, type GgufPrefetchProgress } from '../rag/gguf-prefetch.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { tryOpenFile } from '../utils/open.js';
import { DEFAULT_MODELS } from '../core/platform/index.js';
import { detectProjectProfile } from '../core/scanning/index.js';
import { autoDetectScanGlobs } from '../core/scanning/index.js';
import { defaultDocumentationConfig } from '../core/documentation/index.js';
import { classifyDownloadError, promptDownloadRecovery, type RecoveryChoice } from './download-recovery.js';
import { DEFAULT_PROVIDER_CONCURRENCY } from './wizard-v3-mapping.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WizardOptions {
  hardware: HardwareProfile;
  isTTY: boolean;
  defaultsSettings: boolean;
  quickWin: boolean;
  /** Tier preference loaded from ~/.anatoly/preferences.yml (Story 49.2). */
  savedPreference?: 'lite' | 'advanced';
  /** True if --rag-lite or --rag-advanced was passed on CLI (ignores preferences). */
  cliTierOverride?: boolean;
  /** When true, render text without ANSI styling (Story 49.5). */
  plain?: boolean;
  /**
   * Project root used to look up `.anatoly/embeddings-ready.json`. When that
   * flag file exists (e.g. the user already ran `local-embeddings upgrade`
   * before any first run), the wizard skips the tier prompt and adopts the
   * recorded backend.
   */
  projectRoot?: string;
}

export interface WizardResult {
  tier: 'lite' | 'advanced' | 'external';
}

// ---------------------------------------------------------------------------
// Hardware capability check
// ---------------------------------------------------------------------------

function canRunAdvanced(hw: HardwareProfile): boolean {
  return hw.hasGpu && hw.gpuType === 'cuda' && (hw.vramGB ?? 0) >= GGUF_MIN_VRAM_GB;
}

// ---------------------------------------------------------------------------
// Comparison table (shown when advanced is available)
// ---------------------------------------------------------------------------

function buildComparisonTable(plain: boolean): string {
  if (plain) {
    return [
      'Embeddings setup:',
      'lite      ONNX CPU       150 MB    instant   good recall',
      'advanced  GGUF GPU       15 GB     2-5 min   best recall',
      'external  third-party    ~0 MB     instant   depends on provider',
    ].join('\n');
  }
  return [
    '  Embeddings setup:',
    '',
    '  lite       ONNX CPU       ~150 MB     instant     good recall',
    '  advanced   GGUF GPU       ~15 GB      2-5 min     best recall',
    '  external   third-party    ~0 MB       instant     depends on provider',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

/**
 * First-run wizard: prompts the user for (1) embedding tier and (2) audit
 * mode. Returns the choices as a structured result.
 *
 * Skips all prompts and returns defaults when running non-interactively
 * (`--defaults-settings`, non-TTY, or CI).
 */
export async function runFirstRunWizard(opts: WizardOptions): Promise<WizardResult> {
  // Non-interactive: CI / pipe / --defaults-settings
  if (opts.defaultsSettings || !opts.isTTY) {
    return { tier: 'lite' };
  }

  // -----------------------------------------------------------------------
  // Short-circuit when `.anatoly/embeddings-ready.json` already exists.
  // Means the user ran `anatoly local-embeddings upgrade` (or the external
  // tier flow) before any first run — the embedding backend is settled, so
  // we skip the tier prompt entirely. No audit-mode prompt: first run uses
  // the config's default axis set; per-run axis selection happens later
  // (interactive checkbox in `run`, or --axes / --quick-win).
  // -----------------------------------------------------------------------
  if (opts.projectRoot) {
    const flag = readEmbeddingsReadyFlag(opts.projectRoot);
    if (flag?.backend) {
      const tier: 'lite' | 'advanced' | 'external' =
        flag.backend === 'advanced-gguf' ? 'advanced'
          : flag.backend === 'external' ? 'external'
            : 'lite';
      getLogger().info({ backend: flag.backend, tier }, 'embeddings-ready.json detected — skipping tier prompt');
      return { tier };
    }
  }

  // -----------------------------------------------------------------------
  // Tier resolution: saved preference → prompt
  // -----------------------------------------------------------------------
  const advanced = canRunAdvanced(opts.hardware);
  type TierValue = 'lite' | 'advanced' | 'external';
  let tier: TierValue;

  // Story 49.2: apply saved preference when no CLI override
  const pref = (!opts.cliTierOverride && opts.savedPreference) ? opts.savedPreference : undefined;
  if (pref === 'advanced' && advanced) {
    // AC2: skip prompt, apply silently
    getLogger().info('Using saved preference: advanced (override with --rag-lite)');
    tier = 'advanced';
  } else {
    // AC3: preference not supported on this hardware → inform and re-show prompt
    if (pref === 'advanced' && !advanced) {
      p.note(
        'Your saved preference (advanced) isn\'t supported here \u2014 falling back to default.',
        'Embeddings tier',
      );
    }

    // Value notice + comparison table unified into a single block (Story 49.5)
    const transparencyText = 'Embeddings power Anatoly\'s retrieval — better recall means sharper, more grounded findings.';
    const styledNotice = opts.plain ? transparencyText : chalk.dim(transparencyText);

    if (advanced && !opts.plain) {
      p.note(`${styledNotice}\n\n${buildComparisonTable(false)}`, 'Embeddings tier');
    } else {
      p.note(styledNotice, 'Embeddings tier');
      if (advanced && opts.plain) {
        console.log(buildComparisonTable(true));
      }
    }

    const tierOptions: Array<{ value: TierValue; label: string; hint?: string }> = [
      { value: 'lite', label: 'Lite \u2014 fast setup, works everywhere', hint: 'ONNX CPU, ~150 MB' },
    ];
    if (advanced) {
      tierOptions.push({
        value: 'advanced',
        label: 'Advanced \u2014 higher recall, needs GPU',
        hint: 'GGUF GPU, ~15 GB',
      });
    }
    tierOptions.push({
      value: 'external',
      label: 'External \u2014 bring your own provider (OpenAI, Voyage, Cohere, Azure...)',
      hint: 'API key required',
    });

    const tierChoice = await p.select({
      message: 'Which embedding backend?',
      options: tierOptions,
    });

    if (p.isCancel(tierChoice)) {
      p.cancel('Aborted.');
      process.exit(0);
    }
    tier = tierChoice as TierValue;
  }

  // The wizard no longer asks for an audit mode. First run uses the
  // config's default axis set; per-run axis selection (the config-seeded
  // checkbox, --axes, or --quick-win) happens later in `run`. This also
  // removes the old "doc scaffold" wording that was inconsistent with the
  // doc-mode model (doc behaviour is governed by documentation.internal.mode,
  // not by the audit breadth).
  return { tier };
}

// ---------------------------------------------------------------------------
// Lite ONNX prefetch with spinner
// ---------------------------------------------------------------------------

/**
 * Download both lite ONNX embedding models with visual feedback.
 *
 * - Interactive (TTY): uses a `@clack/prompts` spinner with dynamic message.
 * - Non-interactive (CI / pipe): emits a single log line per model.
 *
 * On failure, warns and continues — the models will be retried lazily.
 *
 * @param asFallback — when true, the messages are framed as "lite ONNX
 *   fallback" to make it clear that the user's chosen tier (advanced) is
 *   still the primary backend. The lite models are only downloaded so the
 *   pipeline can degrade gracefully if the GGUF setup fails later.
 */
export async function runLitePrefetch(opts: {
  isTTY: boolean;
  defaultsSettings: boolean;
  asFallback?: boolean;
}): Promise<void> {
  const log = getLogger();
  // Honest message: HF transformers doesn't surface a "verify" event — if the
  // weights are cached, pipeline() just resolves instantly with no callbacks.
  // So the spinner stays here until either a download initiates (event fires
  // → message swaps to "↓ filename") or everything resolves from cache.
  const startMsg = opts.asFallback
    ? 'Checking lite ONNX fallback models (cached load instantly; download only if missing)…'
    : 'Checking lite embedding models (cached load instantly; download only if missing)…';
  const doneMsg = opts.asFallback ? 'Lite ONNX fallback ready' : 'Embeddings (lite) ready';

  if (opts.isTTY && !opts.defaultsSettings) {
    // Interactive: spinner
    const spinner = p.spinner();
    spinner.start(startMsg);
    let lastMsg = '';

    await prefetchLiteModels({
      onProgress: (ev: PrefetchProgress) => {
        switch (ev.kind) {
          case 'initiate':
            lastMsg = `↓ ${ev.file} (starting…)`;
            spinner.message(lastMsg);
            break;
          case 'progress':
            lastMsg = `↓ ${ev.file}: ${Math.round(ev.percent)}%`;
            spinner.message(lastMsg);
            break;
          case 'done':
            break;
          case 'error':
            log.warn({ modelId: ev.modelId, err: ev.error.message }, 'lite model prefetch failed');
            break;
        }
      },
    });

    spinner.stop(doneMsg);
  } else {
    // Non-interactive: linear log
    log.info(opts.asFallback ? 'checking lite ONNX fallback models…' : 'checking lite embedding models…');

    await prefetchLiteModels({
      onProgress: (ev: PrefetchProgress) => {
        if (ev.kind === 'done') {
          log.info({ modelId: ev.modelId }, 'model ready');
        } else if (ev.kind === 'error') {
          log.warn({ modelId: ev.modelId, err: ev.error.message }, 'lite model prefetch failed');
        }
      },
    });

    log.info(opts.asFallback ? 'lite ONNX fallback ready' : 'lite embedding models ready');
  }
}

// ---------------------------------------------------------------------------
// GGUF prefetch with progress bar (advanced tier)
// ---------------------------------------------------------------------------

/**
 * Download both GGUF embedding models with visual feedback.
 * Returns `true` on success, `false` if any download failed (caller should
 * fall back to lite).
 *
 * - Interactive (TTY): uses a `@clack/prompts` spinner with download progress.
 * - Non-interactive (CI / pipe): emits linear log lines.
 *
 * On failure, warns and returns `false` — the caller forces tier to lite.
 */
export interface GgufPrefetchResult {
  ok: boolean;
  /** The last error encountered during GGUF download, if any. */
  lastError?: Error;
}

export async function runGgufPrefetch(opts: { isTTY: boolean; defaultsSettings: boolean }): Promise<GgufPrefetchResult> {
  const log = getLogger();
  let hadError = false;
  let lastError: Error | undefined;

  if (opts.isTTY && !opts.defaultsSettings) {
    // Interactive: spinner. The initial message reflects the first thing that
    // happens — a checksum verify of any already-cached weights (~25s/5 GB).
    // A real download only kicks in if a file is missing or its hash differs,
    // in which case the spinner switches to a per-file progress bar.
    const spinner = p.spinner();
    spinner.start('Checking GGUF embedding models (verify cached files; download only if missing)…');

    await prefetchGgufModels({
      onProgress: (ev: GgufPrefetchProgress) => {
        switch (ev.kind) {
          case 'verify':
            if (ev.status === 'ok') {
              spinner.message(`GGUF model verified: ${ev.filename}`);
            } else if (ev.status === 'mismatch') {
              spinner.message(`SHA256 mismatch, re-downloading: ${ev.filename}`);
            } else if (ev.status === 'missing') {
              spinner.message(`Downloading missing GGUF model: ${ev.filename}`);
            }
            break;
          case 'progress':
            spinner.message(`↓ ${ev.filename}: ${ev.downloadedMB}/${ev.totalMB} MB (${Math.round(ev.percent)}%)`);
            break;
          case 'done':
            break;
          case 'error':
            hadError = true;
            lastError = ev.error;
            log.warn({ filename: ev.filename, err: ev.error.message }, 'GGUF model download failed');
            break;
        }
      },
    });

    spinner.stop(hadError ? 'GGUF download failed' : 'GGUF models ready');
  } else {
    // Non-interactive: linear log
    log.info('checking GGUF embedding models (verify cached, download only if missing)…');

    await prefetchGgufModels({
      onProgress: (ev: GgufPrefetchProgress) => {
        if (ev.kind === 'verify' && ev.status === 'ok') {
          log.info({ filename: ev.filename }, 'GGUF model verified');
        } else if (ev.kind === 'done') {
          log.info({ filename: ev.filename }, 'GGUF model ready');
        } else if (ev.kind === 'error') {
          hadError = true;
          lastError = ev.error;
          log.warn({ filename: ev.filename, err: ev.error.message }, 'GGUF model download failed');
        }
      },
    });

    if (hadError) {
      log.warn('GGUF download failed');
    } else {
      log.info('GGUF embedding models ready');
    }
  }

  return { ok: !hadError, lastError };
}

// ---------------------------------------------------------------------------
// local-embeddings upgrade subprocess (advanced tier Docker setup)
// ---------------------------------------------------------------------------

export interface LocalEmbeddingsUpgradeResult {
  ok: boolean;
  exitCode: number;
}

/**
 * Run `anatoly local-embeddings upgrade` as a child process with stdio
 * inherited so the user sees Docker pull / container start logs in real time.
 *
 * @param projectRoot — passed as `ANATOLY_PROJECT_ROOT` env var.
 * @returns `{ ok: true, exitCode: 0 }` on success, `{ ok: false, exitCode }` on failure.
 * @throws {AnatolyError} if `process.argv[0]` or `process.argv[1]` is undefined.
 */
export function runLocalEmbeddingsUpgradeSubprocess(projectRoot: string): LocalEmbeddingsUpgradeResult {
  const argv0 = process.argv[0];
  const argv1 = process.argv[1];

  if (!argv0 || !argv1) {
    throw new AnatolyError(
      'Cannot resolve anatoly CLI binary path',
      ERROR_CODES.FILE_NOT_FOUND,
      false,
      'Ensure anatoly is invoked via its CLI entry point (e.g. npx anatoly run)',
    );
  }

  const result = spawnSync(argv0, [argv1, 'local-embeddings', 'upgrade'], {
    stdio: 'inherit',
    env: { ...process.env, ANATOLY_PROJECT_ROOT: projectRoot },
  });

  const exitCode = result.status ?? -1;
  return { ok: exitCode === 0, exitCode };
}

/**
 * Run `anatoly init` as a child process with stdio inherited so the user
 * answers the Q0 (Quick/Advanced) prompt and any advanced phases (RAG tier
 * + provisioning, providers, documentation) interactively. Used by the
 * `anatoly run` first-run path so `run` performs no setup itself: all
 * config generation lives in `init`.
 *
 * @returns `{ ok: true, exitCode: 0 }` when init wrote a config; `{ ok:
 *   false, exitCode }` on cancel/failure.
 * @throws {AnatolyError} if the CLI binary path can't be resolved.
 */
export function runInitSubprocess(projectRoot: string): { ok: boolean; exitCode: number } {
  const argv0 = process.argv[0];
  const argv1 = process.argv[1];
  if (!argv0 || !argv1) {
    throw new AnatolyError(
      'Cannot resolve anatoly CLI binary path',
      ERROR_CODES.FILE_NOT_FOUND,
      false,
      'Ensure anatoly is invoked via its CLI entry point (e.g. npx anatoly run)',
    );
  }
  const result = spawnSync(argv0, [argv1, 'init'], {
    stdio: 'inherit',
    cwd: projectRoot,
    env: { ...process.env, ANATOLY_PROJECT_ROOT: projectRoot },
  });
  const exitCode = result.status ?? -1;
  return { ok: exitCode === 0, exitCode };
}

// ---------------------------------------------------------------------------
// Write first-run .anatoly.yml
// ---------------------------------------------------------------------------

/** All axis IDs in the order they appear in the config schema. */
const AXIS_IDS = [
  'utility', 'duplication', 'correction', 'overengineering',
  'tests', 'best_practices', 'documentation',
] as const;

/**
 * Write a `.anatoly.yml` with sane defaults after the first-run wizard.
 *
 * Emits a fully-annotated v3 schema YAML — every available section is shown,
 * with the active settings uncommented and the optional sections rendered
 * as commented blocks the user can selectively enable.
 *
 * The tier dictates which embedding provider is **active** in `providers`
 * and `routing.embeddings`:
 *
 * - `lite` → `local-lite` (ONNX in-process, Jina + MiniLM)
 * - `advanced` → `local-advanced` (Docker GGUF sidecar on localhost)
 * - `external` → `mistral` + `openrouter` (third-party APIs).
 *   Also writes `.anatoly/embeddings-ready.json` with `backend: 'external'`
 *   so legacy callers that still consult that flag stay happy. Required env
 *   vars: `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`.
 *
 * @param projectRoot — the project root where `.anatoly.yml` will be written.
 * @param opts — `tier` decides which template variant gets written.
 */
/**
 * Detect the project profile and derive concrete scan globs. Failures (no
 * git, unreadable manifests) fall back to a permissive default; detection
 * never blocks the wizard. Shared by `writeFirstRunConfig` and `anatoly init`.
 */
export async function detectScanGlobs(
  projectRoot: string,
): Promise<{ include: string[]; exclude: string[] }> {
  try {
    const profile = await detectProjectProfile(projectRoot);
    return autoDetectScanGlobs(projectRoot, profile);
  } catch {
    return { include: ['src/**/*'], exclude: ['node_modules/**', 'dist/**'] };
  }
}

export async function writeFirstRunConfig(
  projectRoot: string,
  opts?: { tier?: 'lite' | 'advanced' | 'external'; overrides?: V3YamlOverrides },
): Promise<void> {
  const tier = opts?.tier ?? 'lite';
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  const scanGlobs = await detectScanGlobs(projectRoot);
  const yamlBody = buildAnnotatedV3Yaml(tier, hasApiKey, scanGlobs, opts?.overrides);
  writeFileSync(resolve(projectRoot, '.anatoly.yml'), yamlBody, 'utf-8');

  if (tier === 'external') writeExternalReadyFlag(projectRoot);
}

/**
 * Provision the embedding backend for a resolved tier: prefetch the lite
 * ONNX models (as the universal fallback), and for `advanced` download the
 * GGUF models + run `local-embeddings upgrade` with retry/recovery prompts.
 *
 * Single source of truth for RAG provisioning, shared by `anatoly init
 * --advanced` (RAG phase) and the `anatoly run` first-run path. Returns the
 * **effective** tier: `advanced` downgrades to `lite` when GGUF setup is
 * incomplete (recovery: continue-lite), so callers persist the tier the
 * machine can actually serve.
 *
 * @param tier resolved tier (from {@link runFirstRunWizard}).
 * @returns the effective tier (may downgrade advanced -> lite).
 */
export async function runRagSetup(
  projectRoot: string,
  tier: 'lite' | 'advanced' | 'external',
  opts: { isTTY: boolean; defaultsSettings: boolean },
): Promise<'lite' | 'advanced' | 'external'> {
  const { isTTY, defaultsSettings } = opts;

  // External: nothing to provision locally (third-party embeddings).
  if (tier === 'external') return 'external';

  // Lite prefetch (skipped when advanced is already provisioned — running it
  // would print a misleading "lite ready" line).
  const advancedAlreadyReady =
    tier === 'advanced'
    && readEmbeddingsReadyFlag(projectRoot)?.backend === 'advanced-gguf';
  if (!advancedAlreadyReady) {
    await runLitePrefetch({ isTTY, defaultsSettings, asFallback: tier === 'advanced' });
  }

  if (tier !== 'advanced') return 'lite';

  // Advanced: GGUF download + `local-embeddings upgrade`, with recovery.
  let advancedReady = advancedAlreadyReady;
  if (advancedAlreadyReady) {
    getLogger().info('embeddings-ready.json already set to advanced-gguf — skipping GGUF download + setup');
  }

  let ggufDone = advancedReady;
  while (!ggufDone) {
    const ggufResult = await runGgufPrefetch({ isTTY, defaultsSettings });
    if (ggufResult.ok) {
      ggufDone = true;
      let setupDone = false;
      while (!setupDone) {
        const setupResult = runLocalEmbeddingsUpgradeSubprocess(projectRoot);
        if (setupResult.ok) {
          setupDone = true;
          const flag = readEmbeddingsReadyFlag(projectRoot);
          if (flag) getLogger().info({ backend: flag.backend }, 'local-embeddings upgrade completed — advanced mode ready');
          advancedReady = true;
        } else {
          const setupError = new Error(`local-embeddings upgrade failed (exit ${setupResult.exitCode})`);
          const choice: RecoveryChoice = await promptDownloadRecovery({
            kind: classifyDownloadError(setupError),
            error: setupError,
            isTTY,
            defaultsSettings,
          });
          if (choice === 'retry') continue;
          if (choice === 'quit') process.exit(0);
          setupDone = true; // continue-lite
        }
      }
    } else {
      const dlError = ggufResult.lastError ?? new Error('GGUF download failed');
      const choice: RecoveryChoice = await promptDownloadRecovery({
        kind: classifyDownloadError(dlError),
        error: dlError,
        isTTY,
        defaultsSettings,
        neededGB: 15,
      });
      if (choice === 'retry') continue;
      if (choice === 'quit') process.exit(0);
      ggufDone = true; // continue-lite
    }
  }

  if (!advancedReady) {
    getLogger().warn('advanced setup incomplete — falling back to lite');
    return 'lite';
  }
  return 'advanced';
}

/**
 * Build the full annotated v3 YAML for a given tier. Active sections are
 * dumped as plain YAML; optional sections are dumped, commented out line by
 * line, and concatenated in. The result remains parseable as v3 since
 * comments are skipped by yaml.load and `loadConfig`.
 */
/**
 * Optional wizard-driven overrides for the v3 yaml. When `generation` is
 * absent, the providers/routing.generation default to the anthropic-only
 * tier baseline (first-run path stays byte-stable). When `documentation`
 * is absent, {@link defaultDocumentationConfig} is used.
 */
export interface V3YamlOverrides {
  generation?: {
    providers: Record<string, unknown>;
    routing: Record<string, string>;
  };
  documentation?: ReturnType<typeof defaultDocumentationConfig>;
  /** When set, emit an active `notifications.telegram` block instead of the
   *  commented default (advanced-init Telegram phase). */
  notificationsTelegramUsername?: string;
}

export function buildAnnotatedV3Yaml(
  tier: 'lite' | 'advanced' | 'external',
  hasApiKey: boolean,
  scanGlobs: { include: string[]; exclude: string[] },
  overrides?: V3YamlOverrides,
): string {
  return [
    '# Anatoly configuration — generated by first-run wizard. Edit freely.',
    '# Optional sections are commented out below — uncomment what you need.',
    '',
    'version: 3',
    '',
    sectionHeader('project'),
    activeYaml({ project: { name: '${PROJECT_NAME}' } }).replace('${PROJECT_NAME}', 'my-project'),
    '',
    sectionHeader('scan'),
    '# Detected from your manifests (package.json, tsconfig.json, Cargo.toml, …)',
    '# and language distribution. Edit freely — these are the strict, authoritative',
    '# globs `collectFiles` consumes.',
    '#',
    '# respect_gitignore (default true): files ignored by .gitignore are filtered',
    '# out by intersecting with `git ls-files`. Set to false to audit gitignored',
    '# files explicitly.',
    activeYaml({
      scan: {
        include: scanGlobs.include,
        exclude: scanGlobs.exclude,
        respect_gitignore: true,
      },
    }),
    '',
    sectionHeader('coverage (optional — defaults shown)'),
    commentedYaml({
      coverage: {
        enabled: true,
        command: 'npx vitest run --coverage.reporter=json',
        report_path: 'coverage/coverage-final.json',
      },
    }),
    '',
    sectionHeader('providers'),
    renderProvidersBlock(tier, hasApiKey, overrides?.generation?.providers),
    '',
    sectionHeader('routing'),
    activeYaml({ routing: routingForTier(tier, overrides?.generation?.routing) }),
    '',
    sectionHeader('commands (optional — per-command model for standalone LLM commands)'),
    '# Standalone commands that call an LLM outside an audit run (docs arbitrate',
    '# refresh, init --scope). `model` is the default; a command key overrides it.',
    '# Absent ⇒ the command uses routing.generation.quality (a single-turn slot).',
    commentedYaml({
      commands: {
        model: 'anthropic/claude-sonnet-4-6',
        scope: 'anthropic/claude-opus-4-6',
        refresh: 'anthropic/claude-haiku-4-5-20251001',
      },
    }),
    '',
    sectionHeader('evaluation'),
    // Story 54.1 no-magic: the documentation axis MUST be written in its full
    // object form with explicit reference.paths and internal.mode. The bool
    // short form (`documentation: true`) is no longer accepted by the schema.
    activeYaml({
      evaluation: {
        axes: {
          ...Object.fromEntries(AXIS_IDS.filter((id) => id !== 'documentation').map((id) => [id, true])),
          // Single source of truth shared with `anatoly init` so the
          // documentation section never drifts between entry paths.
          documentation: {
            enabled: true,
            ...(overrides?.documentation ?? defaultDocumentationConfig()),
          },
        },
      },
    }),
    '# Per-axis override example — replaces routing.generation.quality for that axis:',
    '#   correction:',
    '#     enabled: true',
    '#     model: anthropic/claude-opus-4-6',
    '# Documentation axis: edit reference.paths to point at your human docs,',
    '# and internal.mode to "full" for LLM-generated internal pages or "off"',
    '# to disable internal doc generation entirely. See docs for details.',
    '',
    sectionHeader('runtime (optional — defaults shown)'),
    commentedYaml({
      runtime: {
        concurrency: 8,
        timeout_per_call: 600,
        max_retries: 3,
        min_confidence: 70,
        max_stop_iterations: 3,
        agents: { max_turns: 30 },
        rag: { code_share: 0.6 },
        output: { max_runs: 20 },
        logging: { level: 'warn', pretty: true },
      },
    }),
    '',
    sectionHeader('notifications (optional)'),
    overrides?.notificationsTelegramUsername
      ? activeYaml({
          notifications: {
            telegram: {
              enabled: true,
              username: overrides.notificationsTelegramUsername,
              bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN',
            },
          },
        })
      : commentedYaml({
          notifications: {
            telegram: {
              enabled: true,
              username: 'YourTelegramUsername',
              bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN',
            },
          },
        }),
    '',
    sectionHeader('badge (optional — defaults shown)'),
    commentedYaml({
      badge: {
        enabled: true,
        verdict: false,
        link: 'https://github.com/r-via/anatoly',
      },
    }),
    '',
    sectionHeader('search (optional — disabled by default)'),
    commentedYaml({ search: { provider: 'brave' } }),
    '',
  ].join('\n');
}

/** ASCII-art-free section header — keeps the file scannable without noise. */
function sectionHeader(title: string): string {
  return `# ---- ${title} ${'-'.repeat(Math.max(0, 70 - title.length))}`;
}

/** Dump an object as YAML (active section). Trailing newline is stripped. */
function activeYaml(obj: Record<string, unknown>): string {
  return yaml.dump(obj, { lineWidth: 120, noRefs: true }).trimEnd();
}

/** Dump an object as YAML, then comment out every line so it's inert. */
function commentedYaml(obj: Record<string, unknown>): string {
  return activeYaml(obj)
    .split('\n')
    .map((line) => (line.length > 0 ? `# ${line}` : '#'))
    .join('\n');
}

/**
 * Render the providers block. The active provider set depends on the tier:
 * the chosen embedding provider is uncommented while the others are listed
 * as commented blocks for easy switch-over.
 */
function renderProvidersBlock(
  tier: 'lite' | 'advanced' | 'external',
  hasApiKey: boolean,
  /**
   * Generation providers from the interactive wizard (see
   * {@link wizardProvidersToV3}). When omitted, the tier default
   * (anthropic only) is used — keeps the first-run output byte-stable.
   */
  genProviders?: Record<string, unknown>,
): string {
  // `local-lite` is always active regardless of tier — it's the universal
  // fallback (ONNX in-process, no API key) so embeddings can degrade gracefully
  // even when the user picked advanced or external. Its models are only
  // *used* when routing.embeddings refers to it.
  const active: Record<string, unknown> = {
    ...(genProviders ?? { anthropic: anthropicProviderConfig(hasApiKey) }),
    'local-lite': LOCAL_LITE_PROVIDER,
  };

  if (tier === 'advanced') {
    active['local-advanced'] = LOCAL_ADVANCED_PROVIDER;
  } else if (tier === 'external') {
    active.mistral = MISTRAL_PROVIDER;
    active.openrouter = OPENROUTER_PROVIDER;
  }

  // Active section
  const activeBlock = activeYaml({ providers: active });

  // Catalog of provider templates for the commented section, minus those
  // already active. The user can uncomment a block to enable that provider.
  const optional: Array<{ name: string; comment: string; config: Record<string, unknown> }> = [];
  if (tier !== 'advanced') {
    optional.push({
      name: 'local-advanced',
      comment: 'GGUF embeddings via Docker sidecar. Run `anatoly local-embeddings upgrade` first.',
      config: LOCAL_ADVANCED_PROVIDER,
    });
  }
  if (tier !== 'external') {
    optional.push({
      name: 'mistral',
      comment: 'External embeddings (mistral-embed). Requires MISTRAL_API_KEY.',
      config: MISTRAL_PROVIDER,
    });
    optional.push({
      name: 'openrouter',
      comment: 'External embeddings/LLM gateway. Requires OPENROUTER_API_KEY.',
      config: OPENROUTER_PROVIDER,
    });
  }
  const optionalBlocks = optional
    .map(({ name, comment, config }) => [
      `  # ${comment}`,
      commentedYaml({ [name]: config }).split('\n').map((l) => `  ${l}`.trimEnd()).join('\n'),
    ].join('\n'))
    .join('\n  #\n');

  return `${activeBlock}\n  #\n${optionalBlocks}`;
}

/**
 * Routing block for a given tier. `generation` defaults to the
 * anthropic-only tier default (byte-stable for first-run) but can be
 * overridden with the wizard-derived routing; `embeddings` is always
 * tier-derived (the wizard never picks embedding models).
 */
function routingForTier(
  tier: 'lite' | 'advanced' | 'external',
  genRouting?: Record<string, string>,
): Record<string, unknown> {
  const generation = genRouting ?? {
    quality: `anthropic/${DEFAULT_MODELS_V3.quality}`,
    fast: `anthropic/${DEFAULT_MODELS_V3.fast}`,
    deliberation: `anthropic/${DEFAULT_MODELS_V3.deliberation}`,
    summarization: `anthropic/${DEFAULT_MODELS_V3.fast}`,
  };
  let embeddings: { code: string; text: string };
  if (tier === 'lite') {
    embeddings = {
      code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
      text: 'local-lite/Xenova/all-MiniLM-L6-v2',
    };
  } else if (tier === 'advanced') {
    embeddings = {
      code: 'local-advanced/nomic-embed-code-gguf',
      text: 'local-advanced/qwen3-embedding-8b-gguf',
    };
  } else {
    embeddings = {
      code: 'mistral/mistral-embed',
      text: 'openrouter/qwen/qwen3-embedding-8b',
    };
  }
  return { generation, embeddings };
}

/** Anthropic provider config — auth shape depends on whether an API key is in env. */
function anthropicProviderConfig(hasApiKey: boolean): Record<string, unknown> {
  const models = [DEFAULT_MODELS_V3.quality, DEFAULT_MODELS_V3.fast, DEFAULT_MODELS_V3.deliberation];
  return hasApiKey
    ? { transport: 'claude_agent_sdk', auth: 'api_key', env_key: 'ANTHROPIC_API_KEY', concurrency: DEFAULT_PROVIDER_CONCURRENCY, models }
    : { transport: 'claude_agent_sdk', auth: 'oauth', concurrency: DEFAULT_PROVIDER_CONCURRENCY, models };
}

const LOCAL_LITE_PROVIDER: Record<string, unknown> = {
  transport: 'onnxruntime_node',
  models: ['jinaai/jina-embeddings-v2-base-code', 'Xenova/all-MiniLM-L6-v2'],
};

const LOCAL_ADVANCED_PROVIDER: Record<string, unknown> = {
  transport: 'openai_compatible',
  auth: 'none',
  concurrency: DEFAULT_PROVIDER_CONCURRENCY,
  models: ['nomic-embed-code-gguf', 'qwen3-embedding-8b-gguf'],
};

const MISTRAL_PROVIDER: Record<string, unknown> = {
  transport: 'openai_compatible',
  auth: 'api_key',
  env_key: 'MISTRAL_API_KEY',
  concurrency: DEFAULT_PROVIDER_CONCURRENCY,
  models: ['mistral-embed'],
};

const OPENROUTER_PROVIDER: Record<string, unknown> = {
  transport: 'openai_compatible',
  auth: 'api_key',
  env_key: 'OPENROUTER_API_KEY',
  concurrency: DEFAULT_PROVIDER_CONCURRENCY,
  models: ['qwen/qwen3-embedding-8b'],
};

// onnxruntime_node (local-lite) is in-process — like auth/env_key/base_url,
// `concurrency` is meaningless there, so it is intentionally omitted (the v2
// adapter drops onnx providers entirely).

/**
 * v3 schema requires bare model ids inside `providers.<name>.models`, then
 * provider-prefixed refs in `routing.*`. Centralised here so the wizard
 * generates consistent ids without re-deriving from `DEFAULT_MODELS` each
 * time. (DEFAULT_MODELS already carries `anthropic/` prefixes for v2 — we
 * strip them for v3's models list.)
 */
const DEFAULT_MODELS_V3 = {
  quality: stripPrefix(DEFAULT_MODELS.quality),
  fast: stripPrefix(DEFAULT_MODELS.fast),
  deliberation: stripPrefix(DEFAULT_MODELS.deliberation),
};

function stripPrefix(modelRef: string): string {
  const slash = modelRef.indexOf('/');
  return slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
}

function writeExternalReadyFlag(projectRoot: string): void {
  const flag = {
    device: 'cpu',
    backend: 'external' as const,
    setup_at: new Date().toISOString(),
  };
  const flagPath = anatolyPath(projectRoot, 'setup', 'embeddings-ready.json');
  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, JSON.stringify(flag, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// End-of-setup 3-choice prompt
// ---------------------------------------------------------------------------

export interface EndOfSetupOptions {
  isTTY: boolean;
  defaultsSettings: boolean;
  projectRoot: string;
}

/**
 * After the setup phase completes (scan/estimate/triage), show a 3-choice
 * prompt so the user can review config before committing to LLM calls.
 *
 * - "Proceed with audit" → returns, run continues.
 * - "Open .anatoly.yml" → opens in editor (or prints content), exits.
 * - "Quit" → prints message, exits.
 *
 * Skipped (auto-proceed) when `--defaults-settings` or non-TTY.
 */
export async function runEndOfSetupPrompt(opts: EndOfSetupOptions): Promise<void> {
  if (opts.defaultsSettings || !opts.isTTY) {
    return;
  }

  type Choice = 'proceed' | 'open-config' | 'quit';
  const choice = await p.select({
    message: 'Ready to start?',
    options: [
      { value: 'proceed' as Choice, label: 'Proceed with audit' },
      { value: 'open-config' as Choice, label: 'Open .anatoly.yml' },
      { value: 'quit' as Choice, label: 'Quit' },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel('Aborted.');
    process.exit(0);
  }

  if (choice === 'proceed') {
    return;
  }

  if (choice === 'open-config') {
    const configPath = resolve(opts.projectRoot, '.anatoly.yml');
    const opened = await tryOpenFile(configPath);
    if (opened) {
      console.log('Opened in editor \u2014 run anatoly run again when ready');
    } else {
      console.log(`  Config: ${configPath}\n`);
      try {
        console.log(readFileSync(configPath, 'utf-8'));
      } catch {
        console.log(chalk.dim('  (could not read config file)'));
      }
    }
    process.exit(0);
  }

  // quit
  console.log('Configuration saved to .anatoly.yml \u2014 run anatoly run when ready');
  process.exit(0);
}
