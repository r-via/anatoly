// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess, SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a provider/model pair to check. */
export interface ProviderCheck {
  provider: string;
  model: string;
  auth: string;
}

/** Result of a single provider connectivity check. */
export interface ProviderCheckResult {
  provider: string;
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  auth: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Pure functions (testable)
// ---------------------------------------------------------------------------

/**
 * Build the list of provider/model pairs to check based on config.
 * Deduplicates models within the same provider.
 */
export function buildProviderChecks(config: Config): ProviderCheck[] {
  const seen = new Set<string>();
  const checks: ProviderCheck[] = [];

  const addClaude = (model: string) => {
    const key = `anthropic:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    checks.push({ provider: 'anthropic', model, auth: 'ANTHROPIC_API_KEY' });
  };

  // Main review model
  addClaude(config.llm.model);
  // Index / fast model (haiku)
  addClaude(config.llm.index_model);
  // Deliberation model (opus)
  addClaude(config.llm.deliberation_model);
  // Fast model override (if set)
  if (config.llm.fast_model) {
    addClaude(config.llm.fast_model);
  }

  return checks;
}

/**
 * Format provider check results as a human-readable table string.
 */
export function formatProvidersTable(results: ProviderCheckResult[]): string {
  const header = `  ${'Provider'.padEnd(12)} ${'Model'.padEnd(30)} ${'Status'.padEnd(8)} ${'Latency'.padEnd(10)} Auth`;
  const separator = `  ${'─'.repeat(12)} ${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(20)}`;

  const rows = results.map(r => {
    const statusIcon = r.status === 'ok' ? chalk.green('✓') : chalk.red('✗');
    const latency = r.status === 'ok' ? `${r.latencyMs}ms` : '—';
    const errorSuffix = r.error ? chalk.dim(` (${r.error})`) : '';
    return `  ${r.provider.padEnd(12)} ${r.model.padEnd(30)} ${statusIcon}${' '.repeat(7)} ${latency.padEnd(10)} ${r.auth}${errorSuffix}`;
  });

  return [header, separator, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// SDK connectivity check
// ---------------------------------------------------------------------------

async function checkAnthropic(model: string, projectRoot: string): Promise<ProviderCheckResult> {
  const start = Date.now();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30_000);

    const q = query({
      prompt: 'Respond OK',
      options: {
        systemPrompt: 'Respond with exactly "OK" and nothing else.',
        model,
        cwd: projectRoot,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController: ac,
      },
    });

    let ok = false;
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          ok = true;
        } else {
          const errorResult = message as SDKResultError;
          const details = errorResult.errors?.join(', ') || errorResult.subtype || 'unknown';
          clearTimeout(timeout);
          return { provider: 'anthropic', model, status: 'error', latencyMs: Date.now() - start, auth: 'ANTHROPIC_API_KEY', error: details };
        }
      }
    }

    clearTimeout(timeout);
    if (ok) {
      return { provider: 'anthropic', model, status: 'ok', latencyMs: Date.now() - start, auth: 'ANTHROPIC_API_KEY' };
    }
    return { provider: 'anthropic', model, status: 'error', latencyMs: Date.now() - start, auth: 'ANTHROPIC_API_KEY', error: 'no result received' };
  } catch (err) {
    return {
      provider: 'anthropic',
      model,
      status: 'error',
      latencyMs: Date.now() - start,
      auth: 'ANTHROPIC_API_KEY',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Registers the `providers` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerProvidersCommand(program: Command): void {
  program
    .command('providers')
    .description('Verify configured LLM providers are reachable')
    .option('--json', 'output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const checks = buildProviderChecks(config);

      if (!opts.json) {
        console.log(chalk.bold('\nanatoly — providers\n'));
        console.log(`  Testing ${checks.length} provider(s)...\n`);
      }

      const results: ProviderCheckResult[] = [];

      for (const check of checks) {
        if (check.provider === 'anthropic') {
          const result = await checkAnthropic(check.model, projectRoot);
          results.push(result);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ providers: results }, null, 2));
      } else {
        console.log(formatProvidersTable(results));
        console.log('');

        const ok = results.filter(r => r.status === 'ok').length;
        const fail = results.filter(r => r.status === 'error').length;
        if (fail === 0) {
          console.log(chalk.green(`  All ${ok} provider(s) reachable ✓`));
        } else {
          console.log(chalk.yellow(`  ${ok} reachable, ${fail} unreachable`));
        }
        console.log('');
      }
    });
}
