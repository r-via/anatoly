// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { GGUF_MIN_VRAM_GB, type HardwareProfile } from '../rag/hardware-detect.js';
import { prefetchLiteModels, type PrefetchProgress } from '../rag/embeddings-prefetch.js';
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
