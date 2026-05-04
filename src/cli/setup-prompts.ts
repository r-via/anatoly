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
import { KNOWN_EMBEDDING_PROVIDERS } from '../rag/known-embedding-providers.js';
import { prefetchLiteModels, type PrefetchProgress } from '../rag/embeddings-prefetch.js';
import { prefetchGgufModels, type GgufPrefetchProgress } from '../rag/gguf-prefetch.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { tryOpenFile } from '../utils/open.js';
import { DEFAULT_MODELS } from '../core/default-models.js';

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
}

/** Per-axis external embedding provider config (returned by the wizard). */
export interface ExternalAxisConfig {
  provider: string;
  model: string;
  base_url?: string;
  env_key?: string;
}

export interface WizardResult {
  tier: 'lite' | 'advanced' | 'external';
  mode: 'quick-win' | 'full-run';
  /** Set when tier is 'external'. Both axes always present (NLP duplicated from code when "Same as code"). */
  external?: {
    code: ExternalAxisConfig;
    nlp: ExternalAxisConfig;
  };
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
      'default   ONNX CPU       150 MB    instant   good recall',
      'advanced  GGUF GPU       15 GB     2-5 min   best recall (recommended for this hardware)',
    ].join('\n');
  }
  return [
    '  Embeddings setup:',
    '',
    '  default    ONNX CPU       ~150 MB     instant     good recall',
    '  advanced   GGUF GPU       ~15 GB      2-5 min     best recall',
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
    return { tier: 'lite', mode: 'full-run' };
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

    // Privacy / transparency notice (Story 49.5: plain mode strips chalk.dim)
    const transparencyText = 'Anatoly sends code chunks to your configured LLM provider only. No telemetry.';
    p.note(
      opts.plain ? transparencyText : chalk.dim(transparencyText),
      'Embeddings tier',
    );

    if (advanced) {
      if (opts.plain) {
        console.log(buildComparisonTable(true));
      } else {
        p.note(buildComparisonTable(false), 'Comparison');
      }
    } else {
      const unavailableText = 'Advanced not available \u2014 needs CUDA GPU + 12 GB VRAM';
      p.note(
        opts.plain ? unavailableText : chalk.dim(unavailableText),
        'Embeddings tier',
      );
    }

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

  // -----------------------------------------------------------------------
  // External sub-prompts (Story 50.6)
  // -----------------------------------------------------------------------
  let externalConfig: { code: ExternalAxisConfig; nlp: ExternalAxisConfig } | undefined;
  if (tier === 'external') {
    externalConfig = await promptExternalEmbeddings();
  }

  // -----------------------------------------------------------------------
  // Mode prompt (skipped if --quick-win)
  // -----------------------------------------------------------------------
  if (opts.quickWin) {
    return { tier, mode: 'quick-win', external: externalConfig };
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

  return { tier, mode: modeChoice as ModeValue, external: externalConfig };
}

// ---------------------------------------------------------------------------
// External embedding provider sub-prompts (Story 50.6)
// ---------------------------------------------------------------------------

/** External providers from registry (exclude anatoly-local — that's the advanced-gguf backend). */
const EXTERNAL_PROVIDERS = Object.entries(KNOWN_EMBEDDING_PROVIDERS)
  .filter(([id]) => id !== 'anatoly-local');

/**
 * Show env key detection note.
 * - Key present → "✓ KEY detected"
 * - Key absent → "⚠ KEY not set..." warning
 */
function checkEnvKey(envKey?: string): void {
  if (!envKey) return;
  if (process.env[envKey]) {
    p.note(`✓ ${envKey} detected`, 'API key');
  } else {
    p.note(
      `⚠ ${envKey} not set in environment. The .anatoly.yml will be written, but embedding calls will fail until the key is exported.`,
      'API key',
    );
  }
}

/**
 * Prompt for a custom provider (4 text inputs: name, base_url, env_key, model).
 */
async function promptCustomProvider(kind: 'code' | 'nlp'): Promise<ExternalAxisConfig> {
  const label = kind === 'code' ? 'Code' : 'NLP';

  const providerName = await p.text({ message: `${label} provider name:` });
  if (p.isCancel(providerName)) { p.cancel('Aborted.'); process.exit(0); }

  const baseUrl = await p.text({
    message: `${label} base URL:`,
    validate: (value) => {
      if (!value) return 'URL is required';
      try { new URL(value); return undefined; } catch { return 'Please enter a valid URL'; }
    },
  });
  if (p.isCancel(baseUrl)) { p.cancel('Aborted.'); process.exit(0); }

  const envKey = await p.text({
    message: `${label} environment variable name (API key):`,
    validate: (value) => {
      if (!value) return 'Variable name is required';
      return /^[A-Z0-9_]+$/.test(value) ? undefined : 'Must match [A-Z0-9_]+';
    },
  });
  if (p.isCancel(envKey)) { p.cancel('Aborted.'); process.exit(0); }

  const model = await p.text({ message: `${label} model name:` });
  if (p.isCancel(model)) { p.cancel('Aborted.'); process.exit(0); }

  return {
    provider: providerName as string,
    model: model as string,
    base_url: baseUrl as string,
    env_key: envKey as string,
  };
}

/**
 * Interactive sub-prompts for external embedding provider selection.
 * Prompts for code provider/model, then NLP provider/model (or "Same as code").
 */
async function promptExternalEmbeddings(): Promise<{ code: ExternalAxisConfig; nlp: ExternalAxisConfig }> {
  // --- Code provider ---
  const codeProviderOptions: Array<{ value: string; label: string; hint?: string }> = EXTERNAL_PROVIDERS.map(
    ([id, entry]) => ({
      value: id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      hint: entry.default_code_model,
    }),
  );
  codeProviderOptions.push({ value: 'custom', label: 'Custom (manual)', hint: 'enter URL, key, and model' });

  // Put voyage first (recommended for code retrieval)
  const voyageIdx = codeProviderOptions.findIndex((o) => o.value === 'voyage');
  if (voyageIdx > 0) {
    const [voyage] = codeProviderOptions.splice(voyageIdx, 1);
    codeProviderOptions.unshift(voyage!);
  }

  const codeProviderChoice = await p.select({
    message: 'Code embedding provider:',
    options: codeProviderOptions,
  });
  if (p.isCancel(codeProviderChoice)) { p.cancel('Aborted.'); process.exit(0); }

  let codeConfig: ExternalAxisConfig;
  if (codeProviderChoice === 'custom') {
    codeConfig = await promptCustomProvider('code');
  } else {
    const providerId = codeProviderChoice as string;
    const entry = KNOWN_EMBEDDING_PROVIDERS[providerId]!;

    const codeModel = await p.text({
      message: 'Code embedding model:',
      initialValue: entry.default_code_model,
    });
    if (p.isCancel(codeModel)) { p.cancel('Aborted.'); process.exit(0); }

    codeConfig = { provider: providerId, model: codeModel as string };
    if (entry.env_key) {
      codeConfig.env_key = entry.env_key;
    }
  }

  checkEnvKey(codeConfig.env_key);

  // --- NLP provider ---
  const nlpProviderOptions: Array<{ value: string; label: string; hint?: string }> = [
    { value: 'same', label: `Same as code (use ${codeConfig.provider} for both)` },
    ...EXTERNAL_PROVIDERS.map(([id, entry]) => ({
      value: id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      hint: entry.default_nlp_model,
    })),
    { value: 'custom', label: 'Custom (manual)', hint: 'enter URL, key, and model' },
  ];

  // Put qwen as first distinct option (after "Same as code") — recommended for NLP
  const providerStartIdx = 1; // after 'same'
  const qwenIdx = nlpProviderOptions.findIndex((o, i) => i >= providerStartIdx && o.value === 'qwen');
  if (qwenIdx > providerStartIdx) {
    const [qwen] = nlpProviderOptions.splice(qwenIdx, 1);
    nlpProviderOptions.splice(providerStartIdx, 0, qwen!);
  }

  const nlpProviderChoice = await p.select({
    message: 'NLP embedding provider:',
    options: nlpProviderOptions,
  });
  if (p.isCancel(nlpProviderChoice)) { p.cancel('Aborted.'); process.exit(0); }

  let nlpConfig: ExternalAxisConfig;
  if (nlpProviderChoice === 'same') {
    // Duplicate code config
    nlpConfig = { ...codeConfig };
  } else if (nlpProviderChoice === 'custom') {
    nlpConfig = await promptCustomProvider('nlp');
    checkEnvKey(nlpConfig.env_key);
  } else {
    const providerId = nlpProviderChoice as string;
    const entry = KNOWN_EMBEDDING_PROVIDERS[providerId]!;

    const nlpModel = await p.text({
      message: 'NLP embedding model:',
      initialValue: entry.default_nlp_model,
    });
    if (p.isCancel(nlpModel)) { p.cancel('Aborted.'); process.exit(0); }

    nlpConfig = { provider: providerId, model: nlpModel as string };
    if (entry.env_key) {
      nlpConfig.env_key = entry.env_key;
    }
    checkEnvKey(nlpConfig.env_key);
  }

  return { code: codeConfig, nlp: nlpConfig };
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
 * - When `opts.external` is provided (tier 'external'), writes `rag.embedding` section.
 *
 * @param projectRoot — the project root where `.anatoly.yml` will be written.
 * @param opts — optional external embedding config from the wizard.
 */
export function writeFirstRunConfig(
  projectRoot: string,
  opts?: { external?: { code: ExternalAxisConfig; nlp: ExternalAxisConfig } },
): void {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const providerMode = hasApiKey ? 'api' : 'subscription';

  const ragSection: Record<string, unknown> = {
    code_model: 'auto',
  };

  // Story 50.6: add embedding section for external tier
  if (opts?.external) {
    const codeEntry: Record<string, string> = {
      provider: opts.external.code.provider,
      model: opts.external.code.model,
    };
    if (opts.external.code.base_url) codeEntry.base_url = opts.external.code.base_url;
    if (opts.external.code.env_key) codeEntry.env_key = opts.external.code.env_key;

    const nlpEntry: Record<string, string> = {
      provider: opts.external.nlp.provider,
      model: opts.external.nlp.model,
    };
    if (opts.external.nlp.base_url) nlpEntry.base_url = opts.external.nlp.base_url;
    if (opts.external.nlp.env_key) nlpEntry.env_key = opts.external.nlp.env_key;

    ragSection.embedding = { code: codeEntry, nlp: nlpEntry };
  }

  const config: Record<string, unknown> = {
    providers: {
      anthropic: {
        mode: providerMode,
        concurrency: 24,
      },
    },
    models: {
      quality: DEFAULT_MODELS.quality,
      fast: DEFAULT_MODELS.fast,
      deliberation: DEFAULT_MODELS.deliberation,
    },
    axes: Object.fromEntries(AXIS_IDS.map((id) => [id, { enabled: true }])),
    rag: ragSection,
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
