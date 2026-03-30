// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';
import { KNOWN_PROVIDERS } from '../core/providers/known-providers.js';
import { ALL_AXIS_IDS } from '../core/axes/index.js';

const CONFIG_FILENAME = '.anatoly.yml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSelection {
  mode: 'subscription' | 'api';
  single_turn?: 'subscription' | 'api';
  agents?: 'subscription' | 'api';
}

export interface WizardSelections {
  providers: Map<string, ProviderSelection>;
  models: {
    quality: string;
    fast: string;
    deliberation: string;
    code_summary?: string;
  };
}

function isCancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

// ---------------------------------------------------------------------------
// Pure logic (testable)
// ---------------------------------------------------------------------------

const SUBSCRIPTION_PROVIDERS = new Set(['anthropic', 'google']);

/**
 * Validate that a provider supports the given mode.
 * Returns an error message or null if valid.
 */
export function validateProviderMode(
  providerId: string,
  mode: string,
): string | null {
  if (mode === 'subscription' && !SUBSCRIPTION_PROVIDERS.has(providerId)) {
    return `Subscription mode only available for Anthropic and Google`;
  }
  return null;
}

/**
 * Detect if an API key environment variable is set for a provider.
 * Returns the env var name if found, null otherwise.
 */
export function detectApiKey(providerId: string): string | null {
  const known = KNOWN_PROVIDERS[providerId];
  const envKey = known?.env_key ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  if (process.env[envKey]) return envKey;
  // Backward compat: also check GOOGLE_API_KEY for google provider
  if (providerId === 'google' && process.env.GOOGLE_API_KEY) return 'GOOGLE_API_KEY';
  return null;
}

/**
 * Build a config object from wizard selections.
 * Returns an object suitable for YAML serialization.
 */
export function buildInitConfig(
  selections: WizardSelections,
): { providers: Record<string, ProviderSelection>; models: Record<string, string>; axes: Record<string, { enabled: boolean }> } {
  const providers: Record<string, ProviderSelection> = {};
  for (const [id, sel] of selections.providers) {
    const entry: ProviderSelection = { mode: sel.mode };
    if (sel.single_turn) entry.single_turn = sel.single_turn;
    if (sel.agents) entry.agents = sel.agents;
    providers[id] = entry;
  }

  const models: Record<string, string> = {
    quality: selections.models.quality,
    fast: selections.models.fast,
    deliberation: selections.models.deliberation,
  };
  if (selections.models.code_summary) {
    models.code_summary = selections.models.code_summary;
  }

  const axes: Record<string, { enabled: boolean }> = {};
  for (const id of ALL_AXIS_IDS) {
    axes[id] = { enabled: true };
  }

  return { providers, models, axes };
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

async function selectMode(message: string): Promise<'subscription' | 'api'> {
  const mode = await p.select({
    message,
    options: [
      { value: 'subscription' as const, label: 'Subscription', hint: 'Anthropic / Google console' },
      { value: 'api' as const, label: 'API', hint: 'pay-per-token' },
    ],
  });
  if (isCancelled(mode)) { p.cancel('Setup cancelled.'); process.exit(0); }
  return mode;
}

async function runInitWizard(): Promise<WizardSelections> {
  const providerNames = Object.keys(KNOWN_PROVIDERS);

  const selectedProviders = await p.multiselect({
    message: 'Select providers to configure',
    options: [
      ...providerNames.map((name) => ({ value: name, label: name })),
      { value: '__custom__', label: 'Custom provider' },
    ],
    required: true,
  });
  if (isCancelled(selectedProviders)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const providers = new Map<string, ProviderSelection>();

  for (const name of selectedProviders) {
    let providerId = name;
    if (name === '__custom__') {
      const custom = await p.text({ message: 'Enter custom provider name' });
      if (isCancelled(custom)) { p.cancel('Setup cancelled.'); process.exit(0); }
      providerId = custom;
    }

    const mode = await selectMode(`Mode for ${providerId}`);

    const error = validateProviderMode(providerId, mode);
    if (error) {
      p.log.error(error);
      continue;
    }

    // Detect API key for API mode
    if (mode === 'api') {
      const detected = detectApiKey(providerId);
      if (detected) {
        p.log.success(`${detected} detected`);
      } else {
        const known = KNOWN_PROVIDERS[providerId];
        const envKey = known?.env_key ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        p.log.warn(`Set ${envKey} in your environment before running anatoly.`);
      }
    }

    // Optional split mode
    const wantSplit = await p.confirm({
      message: `Configure separate modes for single_turn/agents for ${providerId}?`,
      initialValue: false,
    });
    if (isCancelled(wantSplit)) { p.cancel('Setup cancelled.'); process.exit(0); }

    const selection: ProviderSelection = { mode };
    if (wantSplit) {
      selection.single_turn = await selectMode(`single_turn mode for ${providerId}`);
      selection.agents = await selectMode(`agents mode for ${providerId}`);
    }

    providers.set(providerId, selection);
  }

  // Model selection
  const quality = await p.text({
    message: 'Model for quality (axis evaluations)',
    defaultValue: 'anthropic/claude-sonnet-4-6',
    placeholder: 'anthropic/claude-sonnet-4-6',
  });
  if (isCancelled(quality)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const fast = await p.text({
    message: 'Model for fast (triage, code summaries)',
    defaultValue: 'anthropic/claude-haiku-4-5-20251001',
    placeholder: 'anthropic/claude-haiku-4-5-20251001',
  });
  if (isCancelled(fast)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const deliberation = await p.text({
    message: 'Model for deliberation (tier 3)',
    defaultValue: 'anthropic/claude-opus-4-6',
    placeholder: 'anthropic/claude-opus-4-6',
  });
  if (isCancelled(deliberation)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const codeSummary = await p.text({
    message: 'Model for code_summary (optional, press Enter to skip)',
    defaultValue: '',
    placeholder: 'leave empty to skip',
  });
  if (isCancelled(codeSummary)) { p.cancel('Setup cancelled.'); process.exit(0); }

  return {
    providers,
    models: {
      quality,
      fast,
      deliberation,
      ...(codeSummary ? { code_summary: codeSummary } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy: generate commented-out defaults
// ---------------------------------------------------------------------------

function generateExampleConfig(): string {
  const defaults = ConfigSchema.parse({});
  // Inject all axes as enabled so the example config is complete
  const axes: Record<string, { enabled: boolean }> = {};
  for (const id of ALL_AXIS_IDS) {
    axes[id] = { enabled: true };
  }
  const withAxes = { ...defaults, axes };
  const yamlStr = yaml.dump(withAxes, { lineWidth: 120 });
  const commented = yamlStr
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `# ${line}`))
    .join('\n');

  return `# Anatoly configuration — uncomment and customize as needed.\n# All values shown are defaults.\n\n${commented}`;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Registers the `init` CLI sub-command on the given Commander program. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Interactive wizard to generate a multi-provider .anatoly.yml config')
    .option('--force', 'overwrite existing .anatoly.yml')
    .option('--defaults', 'generate commented-out defaults (non-interactive)')
    .action(async (opts: { force?: boolean; defaults?: boolean }) => {
      const projectRoot = process.cwd();
      const configPath = resolve(projectRoot, CONFIG_FILENAME);

      // Check for existing config
      if (existsSync(configPath) && !opts.force) {
        p.log.error(`${CONFIG_FILENAME} already exists. Use --force to overwrite, or edit it directly.`);
        process.exit(1);
      }

      // Non-interactive mode: just dump commented defaults
      if (opts.defaults) {
        const content = generateExampleConfig();
        writeFileSync(configPath, content);
        p.log.success(`${CONFIG_FILENAME} created with all defaults (commented out).`);
        return;
      }

      // Interactive wizard
      p.intro('anatoly init');

      const selections = await runInitWizard();
      const configObj = buildInitConfig(selections);
      const yamlStr = yaml.dump(configObj, { lineWidth: 120 });
      const content = `# Anatoly multi-provider configuration (v2)\n# Generated by anatoly init\n\n${yamlStr}`;

      p.note(content, 'Preview');

      const confirmed = await p.confirm({ message: 'Write this config?' });
      if (isCancelled(confirmed) || !confirmed) {
        p.cancel('Aborted.');
        return;
      }

      writeFileSync(configPath, content);
      p.log.success(`${CONFIG_FILENAME} written.`);
      p.log.info(`Providers: ${[...selections.providers.keys()].join(', ')}`);
      p.log.info(`Models: quality=${selections.models.quality}, fast=${selections.models.fast}`);
      p.outro('Done');
    });
}
