// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { GGUF_MIN_VRAM_GB, type HardwareProfile } from '../rag/hardware-detect.js';
import { prefetchLiteModels, type PrefetchProgress } from '../rag/embeddings-prefetch.js';
import { prefetchGgufModels, type GgufPrefetchProgress } from '../rag/gguf-prefetch.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

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
export async function runGgufPrefetch(opts: { isTTY: boolean; defaultsSettings: boolean }): Promise<boolean> {
  const log = getLogger();
  let hadError = false;

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
            log.warn({ filename: ev.filename, err: ev.error.message }, 'GGUF model download failed');
            break;
        }
      },
    });

    spinner.stop(hadError ? 'GGUF download failed — falling back to lite' : 'GGUF models ready');
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
          log.warn({ filename: ev.filename, err: ev.error.message }, 'GGUF model download failed');
        }
      },
    });

    if (hadError) {
      log.warn('GGUF download failed — falling back to lite');
    } else {
      log.info('GGUF embedding models ready');
    }
  }

  return !hadError;
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
