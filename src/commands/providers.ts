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
import { GeminiTransport } from '../core/transports/gemini-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import type { LlmTransport } from '../core/transports/index.js';
import { coreEvents } from '@google/gemini-cli-core';

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
  /** Concurrency stress-test results (only present for the first check per provider). */
  concurrency?: {
    attempted: number;
    succeeded: number;
    failed: number;
    totalMs: number;
  };
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

  const geminiAuth = config.providers.google
    ? (config.providers.google.mode === 'api' ? 'API Key' : 'Google OAuth')
    : undefined;

  const addModel = (model: string) => {
    const isGemini = model.startsWith('gemini-');
    const provider = isGemini ? 'gemini' : 'anthropic';
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    // Skip Gemini models when Google provider is not configured
    if (isGemini && !config.providers.google) return;
    seen.add(key);
    checks.push({
      provider,
      model,
      auth: isGemini ? geminiAuth! : 'Claude Code SDK',
    });
  };

  // Models section
  addModel(config.models.quality);
  addModel(config.models.fast);
  addModel(config.models.deliberation);
  if (config.models.code_summary) addModel(config.models.code_summary);

  // Agents section
  if (config.agents.scaffolding) addModel(config.agents.scaffolding);
  if (config.agents.review) addModel(config.agents.review);
  if (config.agents.deliberation) addModel(config.agents.deliberation);

  // Per-axis overrides
  for (const axisConfig of Object.values(config.axes)) {
    if (axisConfig.model) addModel(axisConfig.model);
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

async function checkAnthropic(model: string, projectRoot: string, signal?: AbortSignal): Promise<ProviderCheckResult> {
  const start = Date.now();
  const ac = new AbortController();
  // Abort on either local timeout or external signal
  const timeout = setTimeout(() => ac.abort(), 30_000);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
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
          ok = (message as SDKResultSuccess).result?.includes('OK') ?? false;
        } else {
          const errorResult = message as SDKResultError;
          const details = errorResult.errors?.join(', ') || errorResult.subtype || 'unknown';
          clearTimeout(timeout);
          return { provider: 'anthropic', model, status: 'error', latencyMs: Date.now() - start, auth: 'Claude Code SDK', error: details };
        }
      }
    }

    clearTimeout(timeout);
    if (ok) {
      return { provider: 'anthropic', model, status: 'ok', latencyMs: Date.now() - start, auth: 'Claude Code SDK' };
    }
    return { provider: 'anthropic', model, status: 'error', latencyMs: Date.now() - start, auth: 'Claude Code SDK', error: 'no result received' };
  } catch (err) {
    clearTimeout(timeout);
    return {
      provider: 'anthropic',
      model,
      status: 'error',
      latencyMs: Date.now() - start,
      auth: 'Claude Code SDK',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini connectivity check
// ---------------------------------------------------------------------------

function createGeminiTransport(mode: 'subscription' | 'api', projectRoot: string, model: string, config: Config): LlmTransport {
  return mode === 'api' ? new VercelSdkTransport(config) : new GeminiTransport(projectRoot, model);
}

async function checkGemini(model: string, projectRoot: string, mode: 'subscription' | 'api', config: Config): Promise<ProviderCheckResult> {
  const auth = mode === 'api' ? 'API Key' : 'Google OAuth';
  const start = Date.now();
  try {
    const transport = createGeminiTransport(mode, projectRoot, model, config);
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30_000);

    try {
      const response = await transport.query({
        systemPrompt: 'Respond with exactly "OK" and nothing else.',
        userMessage: 'Respond OK',
        model,
        projectRoot,
        abortController: ac,
      });

      const text = response.text.trim();
      if (text.length > 0) {
        return { provider: 'gemini', model, status: 'ok', latencyMs: Date.now() - start, auth };
      }
      return { provider: 'gemini', model, status: 'error', latencyMs: Date.now() - start, auth, error: 'empty response' };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      provider: 'gemini',
      model,
      status: 'error',
      latencyMs: Date.now() - start,
      auth,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Concurrency stress test
// ---------------------------------------------------------------------------

interface ConcurrencyResult {
  attempted: number;
  succeeded: number;
  failed: number;
  totalMs: number;
}

async function stressAnthropic(model: string, projectRoot: string, n: number): Promise<ConcurrencyResult> {
  const start = Date.now();
  const bail = new AbortController();
  const promises = Array.from({ length: n }, () =>
    checkAnthropic(model, projectRoot, bail.signal).then(r => {
      if (r.status !== 'ok') bail.abort();
      return r.status === 'ok';
    }),
  );
  const outcomes = await Promise.all(promises);
  const succeeded = outcomes.filter(Boolean).length;
  return { attempted: n, succeeded, failed: n - succeeded, totalMs: Date.now() - start };
}

async function stressGemini(model: string, projectRoot: string, n: number, mode: 'subscription' | 'api', config: Config): Promise<ConcurrencyResult> {
  const start = Date.now();
  const bail = new AbortController();
  // subscription: each call needs its own transport — resetChat() is not safe for concurrent use
  // api: single transport is fine — stateless SDK
  const sharedTransport = mode === 'api' ? createGeminiTransport(mode, projectRoot, model, config) : undefined;
  const promises = Array.from({ length: n }, () => {
    const transport = sharedTransport ?? createGeminiTransport(mode, projectRoot, model, config);
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 60_000);
    bail.signal.addEventListener('abort', () => ac.abort(), { once: true });
    return transport.query({
      systemPrompt: 'Respond with exactly "OK" and nothing else.',
      userMessage: 'Respond OK',
      model,
      projectRoot,
      abortController: ac,
    }).then(r => {
      clearTimeout(timeout);
      const ok = r.text.trim().length > 0;
      if (!ok) bail.abort();
      return ok;
    }).catch(() => {
      clearTimeout(timeout);
      bail.abort();
      return false;
    });
  });
  const outcomes = await Promise.all(promises);
  const succeeded = outcomes.filter(Boolean).length;
  return { attempted: n, succeeded, failed: n - succeeded, totalMs: Date.now() - start };
}

function formatConcurrencyTable(results: { provider: string; model: string; concurrency: ConcurrencyResult }[]): string {
  const header = `  ${'Provider'.padEnd(12)} ${'Model'.padEnd(30)} ${'Slots'.padEnd(7)} ${'OK'.padEnd(5)} ${'Fail'.padEnd(6)} Time`;
  const separator = `  ${'─'.repeat(12)} ${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(10)}`;
  const rows = results.map(r => {
    const c = r.concurrency;
    const okPad = String(c.succeeded).padEnd(5);
    const failPad = String(c.failed).padEnd(6);
    const coloredOk = c.failed === 0 ? chalk.green(okPad) : chalk.yellow(okPad);
    const coloredFail = c.failed === 0 ? chalk.dim(failPad) : chalk.red(failPad);
    return `  ${r.provider.padEnd(12)} ${r.model.padEnd(30)} ${String(c.attempted).padEnd(7)} ${coloredOk} ${coloredFail} ${c.totalMs}ms`;
  });
  return [header, separator, ...rows].join('\n');
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

      // Raise limit early — each SDK query() adds an exit listener to process,
      // and each gemini-cli-core Config adds listeners to the shared coreEvents emitter
      const maxConcurrency = Math.max(config.providers.anthropic?.concurrency ?? 24, config.providers.google?.concurrency ?? 0, checks.length);
      const prevMaxListeners = process.getMaxListeners();
      const prevCoreMaxListeners = coreEvents.getMaxListeners();
      process.setMaxListeners(Math.max(prevMaxListeners, maxConcurrency + 10));
      coreEvents.setMaxListeners(Math.max(prevCoreMaxListeners, maxConcurrency + 10));

      if (!opts.json) {
        console.log(chalk.bold('\nanatoly — providers\n'));
        console.log(`  Testing ${checks.length} provider(s)...\n`);
      }

      const results: ProviderCheckResult[] = [];

      for (const check of checks) {
        if (check.provider === 'anthropic') {
          const result = await checkAnthropic(check.model, projectRoot);
          results.push(result);
        } else if (check.provider === 'gemini') {
          const result = await checkGemini(check.model, projectRoot, config.providers.google?.mode ?? 'subscription', config);
          results.push(result);
        }
      }

      // --- Concurrency stress test (one model per provider, only reachable ones) ---
      const concurrencyResults: { provider: string; model: string; concurrency: ConcurrencyResult }[] = [];
      const reachable = results.filter(r => r.status === 'ok');
      const testedProviders = new Set<string>();

      for (const r of reachable) {
        if (testedProviders.has(r.provider)) continue;
        testedProviders.add(r.provider);

        const slots = r.provider === 'gemini'
          ? (config.providers.google?.concurrency ?? 10)
          : (config.providers.anthropic?.concurrency ?? 24);

        if (!opts.json) {
          console.log(chalk.dim(`  Stress-testing ${r.provider} (${r.model}) × ${slots} concurrent...`));
        }

        try {
          const cr = r.provider === 'gemini'
            ? await stressGemini(r.model, projectRoot, slots, config.providers.google?.mode ?? 'subscription', config)
            : await stressAnthropic(r.model, projectRoot, slots);
          concurrencyResults.push({ provider: r.provider, model: r.model, concurrency: cr });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          concurrencyResults.push({ provider: r.provider, model: r.model, concurrency: { attempted: slots, succeeded: 0, failed: slots, totalMs: 0 } });
          if (!opts.json) {
            console.log(chalk.red(`  Stress test failed: ${msg}`));
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ providers: results, concurrency: concurrencyResults }, null, 2));
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

        if (concurrencyResults.length > 0) {
          console.log(chalk.bold('\n  Concurrency stress test\n'));
          console.log(formatConcurrencyTable(concurrencyResults));
          console.log('');
          const allPassed = concurrencyResults.every(r => r.concurrency.failed === 0);
          if (allPassed) {
            console.log(chalk.green('  All concurrency slots validated ✓'));
          } else {
            for (const r of concurrencyResults) {
              const c = r.concurrency;
              if (c.failed === 0) continue;
              if (c.succeeded > 0) {
                // Partial success = rate limiting, not a connectivity issue
                console.log(chalk.yellow(`  ⚠ ${r.provider}: ${c.succeeded}/${c.attempted} slots OK — rate limited (consider sdk_concurrency: ${c.succeeded})`));
              } else {
                console.log(chalk.red(`  ✗ ${r.provider}: 0/${c.attempted} slots — concurrency fully blocked`));
              }
            }
          }
        }
        console.log('');
      }

      process.setMaxListeners(prevMaxListeners);
      coreEvents.setMaxListeners(prevCoreMaxListeners);
    });
}
