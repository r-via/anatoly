// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { GGUF_MIN_VRAM_GB, type HardwareProfile } from '../rag/hardware-detect.js';
import { prefetchLiteModels, type PrefetchProgress } from '../rag/embeddings-prefetch.js';
import { prefetchGgufModels, type GgufPrefetchProgress } from '../rag/gguf-prefetch.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { tryOpenFile } from '../utils/open.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WizardOptions {
  hardware: HardwareProfile;
  isTTY: boolean;
  defaultsSettings: boolean;
  quickWin: boolean;
}

export interface WizardResult {
  tier: 'lite' | 'advanced';
  mode: 'quick-win' | 'full-run';
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

function buildComparisonTable(): string {
  const lines = [
    '  Embeddings setup:',
    '',
    '  default    ONNX CPU       ~150 MB     instant     good recall',
    '  advanced   GGUF GPU       ~15 GB      2-5 min     best recall',
  ];
  return lines.join('\n');
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
    return { tier: 'lite', mode: 'full-run' };
  }

  // -----------------------------------------------------------------------
  // Tier prompt
  // -----------------------------------------------------------------------
  const advanced = canRunAdvanced(opts.hardware);

  // Privacy / transparency notice
  p.note(
    chalk.dim('Anatoly sends code chunks to your configured LLM provider only. No telemetry.'),
    'Embeddings tier',
  );

  if (advanced) {
    // Show comparison table
    p.note(buildComparisonTable(), 'Comparison');
  } else {
    // Explain why advanced is unavailable
    p.note(
      chalk.dim('Advanced not available \u2014 needs CUDA GPU + 12 GB VRAM'),
      'Embeddings tier',
    );
  }

  type TierValue = 'lite' | 'advanced';
  const tierOptions: Array<{ value: TierValue; label: string; hint?: string }> = [
    { value: 'lite', label: 'Default \u2014 fast setup, works everywhere', hint: 'ONNX CPU, ~150 MB' },
  ];
  if (advanced) {
    tierOptions.push({
      value: 'advanced',
      label: 'Advanced \u2014 higher recall, needs GPU',
      hint: 'GGUF GPU, ~15 GB',
    });
  }

  const tierChoice = await p.select({
    message: 'Which embedding backend?',
    options: tierOptions,
  });

  if (p.isCancel(tierChoice)) {
    p.cancel('Aborted.');
    process.exit(0);
  }
  const tier = tierChoice as TierValue;

  // -----------------------------------------------------------------------
  // Mode prompt (skipped if --quick-win)
  // -----------------------------------------------------------------------
  if (opts.quickWin) {
    return { tier, mode: 'quick-win' };
  }

  type ModeValue = 'quick-win' | 'full-run';
  const modeChoice = await p.select({
    message: 'Audit mode:',
    options: [
      {
        value: 'quick-win' as ModeValue,
        label: 'Quick Win \u2014 utility + duplication + correction, no doc scaffold (~30s)',
      },
      {
        value: 'full-run' as ModeValue,
        label: 'Full Run \u2014 all 7 axes + doc scaffold (several minutes)',
      },
    ],
  });

  if (p.isCancel(modeChoice)) {
    p.cancel('Aborted.');
    process.exit(0);
  }

  return { tier, mode: modeChoice as ModeValue };
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
 */
export async function runLitePrefetch(opts: { isTTY: boolean; defaultsSettings: boolean }): Promise<void> {
  const log = getLogger();

  if (opts.isTTY && !opts.defaultsSettings) {
    // Interactive: spinner
    const spinner = p.spinner();
    spinner.start('Downloading lite embedding models…');
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

    spinner.stop('Embeddings (lite) ready');
  } else {
    // Non-interactive: linear log
    log.info('downloading lite embedding models…');

    await prefetchLiteModels({
      onProgress: (ev: PrefetchProgress) => {
        if (ev.kind === 'done') {
          log.info({ modelId: ev.modelId }, 'model ready');
        } else if (ev.kind === 'error') {
          log.warn({ modelId: ev.modelId, err: ev.error.message }, 'lite model prefetch failed');
        }
      },
    });

    log.info('lite embedding models ready');
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
    // Interactive: spinner
    const spinner = p.spinner();
    spinner.start('Downloading GGUF embedding models…');

    await prefetchGgufModels({
      onProgress: (ev: GgufPrefetchProgress) => {
        switch (ev.kind) {
          case 'verify':
            if (ev.status === 'ok') {
              spinner.message(`GGUF model verified: ${ev.filename}`);
            } else if (ev.status === 'mismatch') {
              spinner.message(`SHA256 mismatch, re-downloading: ${ev.filename}`);
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
    log.info('downloading GGUF embedding models…');

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
// Setup-embeddings subprocess (advanced tier Docker setup)
// ---------------------------------------------------------------------------

export interface SetupEmbeddingsResult {
  ok: boolean;
  exitCode: number;
}

/**
 * Run `anatoly setup-embeddings` as a child process with stdio inherited
 * so the user sees Docker pull / container start logs in real time.
 *
 * @param projectRoot — passed as `ANATOLY_PROJECT_ROOT` env var.
 * @returns `{ ok: true, exitCode: 0 }` on success, `{ ok: false, exitCode }` on failure.
 * @throws {AnatolyError} if `process.argv[0]` or `process.argv[1]` is undefined.
 */
export function runSetupEmbeddingsSubprocess(projectRoot: string): SetupEmbeddingsResult {
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

  const result = spawnSync(argv0, [argv1, 'setup-embeddings'], {
    stdio: 'inherit',
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
 * - Detects `ANTHROPIC_API_KEY` in env to choose `api` vs `subscription` mode.
 * - All 7 axes are enabled.
 * - `rag.code_model` is set to `'auto'` so runtime resolution picks the right backend.
 *
 * @param projectRoot — the project root where `.anatoly.yml` will be written.
 */
export function writeFirstRunConfig(projectRoot: string): void {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const providerMode = hasApiKey ? 'api' : 'subscription';

  const config: Record<string, unknown> = {
    providers: {
      anthropic: {
        mode: providerMode,
        concurrency: 24,
      },
    },
    models: {
      quality: 'anthropic/claude-sonnet-4-6',
      fast: 'anthropic/claude-haiku-4-5-20251001',
      deliberation: 'anthropic/claude-opus-4-6',
    },
    axes: Object.fromEntries(AXIS_IDS.map((id) => [id, { enabled: true }])),
    rag: {
      code_model: 'auto',
    },
  };

  const yamlStr = yaml.dump(config, { lineWidth: 120 });
  const header = '# Anatoly configuration — generated by first-run wizard. Edit freely.\n\n';
  writeFileSync(resolve(projectRoot, '.anatoly.yml'), header + yamlStr, 'utf-8');
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
