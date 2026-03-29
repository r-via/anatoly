// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';
import { KNOWN_PROVIDERS } from '../core/providers/known-providers.js';

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

/** Abstraction for interactive I/O (injectable for testing). */
export interface PromptIO {
  select: (message: string, choices: string[]) => Promise<string>;
  multiSelect: (message: string, choices: string[]) => Promise<string[]>;
  confirm: (message: string) => Promise<boolean>;
  input: (message: string, defaultValue?: string) => Promise<string>;
  print: (message: string) => void;
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
  return process.env[envKey] ? envKey : null;
}

/**
 * Build a config object from wizard selections.
 * Returns an object suitable for YAML serialization.
 */
export function buildInitConfig(
  selections: WizardSelections,
): { providers: Record<string, ProviderSelection>; models: Record<string, string> } {
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

  return { providers, models };
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

function createReadlineIO(): PromptIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (answer) => resolve(answer.trim())));

  return {
    select: async (message, choices) => {
      console.log(`\n${message}`);
      choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
      const answer = await ask('  Choice: ');
      const idx = parseInt(answer, 10) - 1;
      return choices[idx] ?? choices[0];
    },
    multiSelect: async (message, choices) => {
      console.log(`\n${message} (comma-separated numbers, e.g. 1,2,3)`);
      choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
      const answer = await ask('  Choices: ');
      const indices = answer.split(',').map((s) => parseInt(s.trim(), 10) - 1);
      return indices.filter((i) => i >= 0 && i < choices.length).map((i) => choices[i]);
    },
    confirm: async (message) => {
      const answer = await ask(`${message} (Y/n) `);
      return answer.toLowerCase() !== 'n';
    },
    input: async (message, defaultValue) => {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await ask(`${message}${suffix}: `);
      return answer || defaultValue || '';
    },
    print: (message) => console.log(message),
  };
}

async function runInitWizard(io: PromptIO): Promise<WizardSelections> {
  const providerNames = Object.keys(KNOWN_PROVIDERS);
  const selectedProviders = await io.multiSelect(
    'Select providers to configure:',
    [...providerNames, 'Custom'],
  );

  const providers = new Map<string, ProviderSelection>();

  for (const name of selectedProviders) {
    const providerId = name === 'Custom'
      ? await io.input('Enter custom provider name')
      : name;

    const mode = await io.select(
      `Mode for ${providerId}:`,
      ['subscription', 'api'],
    ) as 'subscription' | 'api';

    const error = validateProviderMode(providerId, mode);
    if (error) {
      io.print(chalk.red(error));
      continue;
    }

    // Detect API key for API mode
    if (mode === 'api') {
      const detected = detectApiKey(providerId);
      if (detected) {
        io.print(chalk.green(`  ✓ ${detected} detected`));
      } else {
        const known = KNOWN_PROVIDERS[providerId];
        const envKey = known?.env_key ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        io.print(chalk.yellow(`  ⚠ Set ${envKey} in your environment before running anatoly.`));
      }
    }

    // Optional split mode
    const wantSplit = await io.confirm(`  Configure separate modes for single_turn/agents for ${providerId}?`);
    const selection: ProviderSelection = { mode };
    if (wantSplit) {
      selection.single_turn = await io.select(
        `  single_turn mode for ${providerId}:`,
        ['subscription', 'api'],
      ) as 'subscription' | 'api';
      selection.agents = await io.select(
        `  agents mode for ${providerId}:`,
        ['subscription', 'api'],
      ) as 'subscription' | 'api';
    }

    providers.set(providerId, selection);
  }

  // Model selection
  const quality = await io.input('Model for quality (axis evaluations)', 'anthropic/claude-sonnet-4-6');
  const fast = await io.input('Model for fast (triage, code summaries)', 'anthropic/claude-haiku-4-5-20251001');
  const deliberation = await io.input('Model for deliberation (tier 3)', 'anthropic/claude-opus-4-6');
  const codeSummary = await io.input('Model for code_summary (optional, press Enter to skip)');

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
  const yamlStr = yaml.dump(defaults, { lineWidth: 120 });
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
        console.error(chalk.yellow(
          `${CONFIG_FILENAME} already exists. Use --force to overwrite, or edit it directly.`,
        ));
        process.exit(1);
      }

      // Non-interactive mode: just dump commented defaults
      if (opts.defaults) {
        const content = generateExampleConfig();
        writeFileSync(configPath, content);
        console.log(chalk.green(`${CONFIG_FILENAME} created with all defaults (commented out).`));
        return;
      }

      // Interactive wizard
      const io = createReadlineIO();
      try {
        const selections = await runInitWizard(io);
        const configObj = buildInitConfig(selections);
        const yamlStr = yaml.dump(configObj, { lineWidth: 120 });
        const content = `# Anatoly multi-provider configuration (v2)\n# Generated by anatoly init\n\n${yamlStr}`;

        io.print(`\n${chalk.bold('Preview:')}\n${content}`);
        const confirmed = await io.confirm('\nWrite this config?');
        if (!confirmed) {
          io.print(chalk.yellow('Aborted.'));
          return;
        }

        writeFileSync(configPath, content);
        io.print(chalk.green(`\n✓ ${CONFIG_FILENAME} written.`));

        // Summary
        io.print(`\n${chalk.bold('Providers:')} ${[...selections.providers.keys()].join(', ')}`);
        io.print(`${chalk.bold('Models:')} quality=${selections.models.quality}, fast=${selections.models.fast}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') return;
        throw err;
      }
    });
}
