// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess, SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { embed } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { loadConfig, getV3Source } from '../utils/config-loader.js';
import { ensurePricing } from '../utils/pricing-cache.js';
import { enumerateActiveModels } from '../utils/active-models.js';
import { getLogger } from '../utils/logger.js';
import type { Config } from '../schemas/config.js';
import type { ConfigV3, ProviderConfig, Transport } from '../schemas/config-v3.js';
import { parseModelRef } from '../schemas/config-v3.js';
import { GeminiTransport } from '../core/transports/gemini-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import { extractProvider, stripPrefix, type LlmTransport } from '../core/transports/index.js';
import { coreEvents } from '@google/gemini-cli-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a provider/model pair to check. */
export interface ProviderCheck {
  /** v3 provider id (e.g. "anthropic", "google", "local-advanced"). */
  provider: string;
  /** Full `<provider>/<model>` reference. */
  model: string;
  /** Display label for the Auth column, derived from the v3 declaration. */
  auth: string;
  /** Transport that determines which check function to dispatch to. */
  transport: Transport;
  /** Environment variable holding the API key (when auth=api_key). */
  envKey?: string;
  /** Provider base URL (when set in v3). */
  baseUrl?: string;
}

/** Result of a single provider connectivity check. */
export interface ProviderCheckResult {
  provider: string;
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  auth: string;
  transport: Transport;
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
// Auth label derivation
// ---------------------------------------------------------------------------

function isLocalUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
}

/**
 * Build a human-readable Auth column label from a v3 provider declaration.
 * The label mirrors what the YAML actually says (`auth`, `env_key`, transport)
 * rather than the v2-adapted `mode` projection — so users see the same vocabulary
 * they typed into `.anatoly.yml`.
 */
export function formatAuthLabel(provider: {
  transport: Transport;
  auth?: 'oauth' | 'api_key';
  env_key?: string;
  base_url?: string;
}): string {
  if (provider.transport === 'onnxruntime_node') return 'Local (in-process)';
  if (provider.auth === 'oauth') return 'OAuth';
  if (provider.auth === 'api_key') {
    const env = provider.env_key;
    if (isLocalUrl(provider.base_url)) {
      return env ? `Local (${env})` : 'Local';
    }
    return env ? `API Key (${env})` : 'API Key';
  }
  return '—';
}

/**
 * v2 fallback: derive an auth label from the post-adapter `mode` field. Only
 * used when no v3 source is attached (legacy configs without `version: 3`).
 */
function formatAuthLabelV2(providerId: string, provider: { mode: string; env_key?: string }): string {
  if (provider.mode === 'subscription') {
    return providerId === 'google' ? 'Google OAuth' : 'OAuth';
  }
  const env = provider.env_key;
  return env ? `API Key (${env})` : 'API Key';
}

/**
 * v2 fallback: guess transport from the provider id. v2 had no explicit
 * transport field, so anthropic/google are special-cased and any other
 * catchall provider is assumed to be openai-compatible.
 */
function guessTransportV2(providerId: string): Transport {
  if (providerId === 'anthropic') return 'claude_agent_sdk';
  if (providerId === 'google') return 'google_genai';
  return 'openai_compatible';
}

// ---------------------------------------------------------------------------
// Pure functions (testable)
// ---------------------------------------------------------------------------

/**
 * Build the list of provider/model pairs to check based on config.
 * Deduplicates by full `<provider>/<model>` reference. When the config came
 * from a v3 YAML, the v3 declarative section drives the walk (every provider
 * declared, including embedding-only ones like openai_compatible / ONNX).
 */
export function buildProviderChecks(config: Config): ProviderCheck[] {
  const v3 = getV3Source(config);
  if (v3) return buildProviderChecksV3(v3);
  return buildProviderChecksV2(config);
}

function buildProviderChecksV3(v3: ConfigV3): ProviderCheck[] {
  const seen = new Set<string>();
  const checks: ProviderCheck[] = [];

  const refs: string[] = [
    v3.routing.generation.quality,
    v3.routing.generation.fast,
    v3.routing.generation.deliberation,
    v3.routing.generation.summarization,
    v3.routing.embeddings.code,
    v3.routing.embeddings.text,
  ];
  for (const axis of Object.values(v3.evaluation.axes)) {
    if (typeof axis === 'object' && axis !== null && 'model' in axis && axis.model) {
      refs.push(axis.model);
    }
  }

  for (const ref of refs) {
    if (seen.has(ref)) continue;
    const parsed = parseModelRef(ref);
    if (!parsed) continue;
    const provider: ProviderConfig | undefined = v3.providers[parsed.provider];
    if (!provider) continue;
    seen.add(ref);
    checks.push({
      provider: parsed.provider,
      model: ref,
      auth: formatAuthLabel(provider),
      transport: provider.transport,
      envKey: provider.env_key,
      baseUrl: provider.base_url,
    });
  }

  return checks;
}

function buildProviderChecksV2(config: Config): ProviderCheck[] {
  const seen = new Set<string>();
  const checks: ProviderCheck[] = [];

  const addModel = (model: string) => {
    if (seen.has(model)) return;
    const providerId = extractProvider(model);
    const provider = (config.providers as Record<string, { mode: string; env_key?: string; base_url?: string } | undefined>)[providerId];
    if (!provider) return;
    seen.add(model);
    checks.push({
      provider: providerId,
      model,
      auth: formatAuthLabelV2(providerId, provider),
      transport: guessTransportV2(providerId),
      envKey: provider.env_key,
      baseUrl: provider.base_url,
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
  const table = new Table({
    chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '  ', 'left-mid': '  ', mid: '─', 'mid-mid': ' ', right: '', 'right-mid': '', middle: ' ' },
    style: { 'padding-left': 0, 'padding-right': 0, head: ['dim'] },
    head: ['Provider', 'Model', 'Status', 'Latency', 'Auth'],
  });

  for (const r of results) {
    const statusIcon = r.status === 'ok' ? chalk.green('✓') : chalk.red('✗');
    const latency = r.status === 'ok' ? `${r.latencyMs}ms` : '—';
    const auth = r.error ? `${r.auth} ${chalk.dim(`(${r.error})`)}` : r.auth;
    table.push([r.provider, r.model, statusIcon, latency, auth]);
  }

  return table.toString();
}

// ---------------------------------------------------------------------------
// Anthropic (claude_agent_sdk) probe
// ---------------------------------------------------------------------------

/** Internal: short LLM ping returning a boolean status + latency. */
async function pingAnthropic(
  model: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const bareModel = stripPrefix(model);
  const start = Date.now();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const q = query({
      prompt: 'Respond OK',
      options: {
        systemPrompt: 'Respond with exactly "OK" and nothing else.',
        model: bareModel,
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
          return { ok: false, error: details, latencyMs: Date.now() - start };
        }
      }
    }

    clearTimeout(timeout);
    return ok
      ? { ok: true, latencyMs: Date.now() - start }
      : { ok: false, error: 'no result received', latencyMs: Date.now() - start };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

async function checkAnthropic(check: ProviderCheck, projectRoot: string, signal?: AbortSignal): Promise<ProviderCheckResult> {
  const r = await pingAnthropic(check.model, projectRoot, signal);
  return {
    provider: check.provider,
    model: check.model,
    status: r.ok ? 'ok' : 'error',
    latencyMs: r.latencyMs,
    auth: check.auth,
    transport: check.transport,
    ...(r.error ? { error: r.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gemini (google_genai) probe
// ---------------------------------------------------------------------------

function createGeminiTransport(mode: 'subscription' | 'api', projectRoot: string, model: string, config: Config): LlmTransport {
  return mode === 'api' ? new VercelSdkTransport(config) : new GeminiTransport(projectRoot, model);
}

async function pingGemini(
  model: string,
  projectRoot: string,
  mode: 'subscription' | 'api',
  config: Config,
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const start = Date.now();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 30_000);
  try {
    const transport = createGeminiTransport(mode, projectRoot, model, config);
    const response = await transport.query({
      systemPrompt: 'Respond with exactly "OK" and nothing else.',
      userMessage: 'Respond OK',
      model,
      projectRoot,
      abortController: ac,
    });
    const text = response.text.trim();
    return text.length > 0
      ? { ok: true, latencyMs: Date.now() - start }
      : { ok: false, error: 'empty response', latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkGemini(check: ProviderCheck, projectRoot: string, config: Config): Promise<ProviderCheckResult> {
  // v3 oauth → subscription, api_key → api. Honor `auth` directly when v3 was used;
  // fall back to v2's mode field otherwise.
  const mode: 'subscription' | 'api' = (() => {
    const v2Mode = config.providers.google?.mode;
    if (v2Mode) return v2Mode;
    return 'subscription';
  })();
  const r = await pingGemini(check.model, projectRoot, mode, config);
  return {
    provider: check.provider,
    model: check.model,
    status: r.ok ? 'ok' : 'error',
    latencyMs: r.latencyMs,
    auth: check.auth,
    transport: check.transport,
    ...(r.error ? { error: r.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (embeddings) probe
// ---------------------------------------------------------------------------

async function checkOpenAICompatible(check: ProviderCheck): Promise<ProviderCheckResult> {
  const start = Date.now();
  const bareModel = stripPrefix(check.model);

  if (!check.baseUrl) {
    return {
      provider: check.provider,
      model: check.model,
      status: 'error',
      latencyMs: 0,
      auth: check.auth,
      transport: check.transport,
      error: 'missing base_url',
    };
  }

  const local = isLocalUrl(check.baseUrl);
  const apiKey = check.envKey ? process.env[check.envKey] : undefined;

  if (!local && check.envKey && !apiKey) {
    return {
      provider: check.provider,
      model: check.model,
      status: 'error',
      latencyMs: Date.now() - start,
      auth: check.auth,
      transport: check.transport,
      error: `${check.envKey} not set`,
    };
  }

  try {
    const sdkProvider = createOpenAICompatible({
      baseURL: check.baseUrl,
      name: check.provider,
      apiKey: apiKey ?? 'dummy',
    });
    const model = sdkProvider.textEmbeddingModel(bareModel);
    const result = await embed({ model, value: 'anatoly probe' });
    const ok = result.embedding.length > 0;
    return {
      provider: check.provider,
      model: check.model,
      status: ok ? 'ok' : 'error',
      latencyMs: Date.now() - start,
      auth: check.auth,
      transport: check.transport,
      ...(ok ? {} : { error: 'empty embedding' }),
    };
  } catch (err) {
    return {
      provider: check.provider,
      model: check.model,
      status: 'error',
      latencyMs: Date.now() - start,
      auth: check.auth,
      transport: check.transport,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// ONNX (in-process) probe — no network call, just acknowledge it's local.
// ---------------------------------------------------------------------------

function checkOnnx(check: ProviderCheck): ProviderCheckResult {
  return {
    provider: check.provider,
    model: check.model,
    status: 'ok',
    latencyMs: 0,
    auth: check.auth,
    transport: check.transport,
  };
}

// ---------------------------------------------------------------------------
// Concurrency stress test (LLM transports only)
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
    pingAnthropic(model, projectRoot, bail.signal).then(r => {
      if (!r.ok) bail.abort();
      return r.ok;
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
  const table = new Table({
    chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '  ', 'left-mid': '  ', mid: '─', 'mid-mid': ' ', right: '', 'right-mid': '', middle: ' ' },
    style: { 'padding-left': 0, 'padding-right': 0, head: ['dim'] },
    head: ['Provider', 'Model', 'Slots', 'OK', 'Fail', 'Time'],
  });

  for (const r of results) {
    const c = r.concurrency;
    const ok = c.failed === 0 ? chalk.green(String(c.succeeded)) : chalk.yellow(String(c.succeeded));
    const fail = c.failed === 0 ? chalk.dim(String(c.failed)) : chalk.red(String(c.failed));
    table.push([r.provider, r.model, String(c.attempted), ok, fail, `${c.totalMs}ms`]);
  }

  return table.toString();
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

      // Refresh the pricing cache up-front so any cost annotations the table
      // surfaces stay accurate without re-fetching at every status check.
      await ensurePricing(enumerateActiveModels(config), projectRoot, {
        log: (level, message) => getLogger()[level](message),
      });

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
        let result: ProviderCheckResult;
        switch (check.transport) {
          case 'claude_agent_sdk':
            result = await checkAnthropic(check, projectRoot);
            break;
          case 'google_genai':
            result = await checkGemini(check, projectRoot, config);
            break;
          case 'openai_compatible':
            result = await checkOpenAICompatible(check);
            break;
          case 'onnxruntime_node':
            result = checkOnnx(check);
            break;
        }
        results.push(result);
      }

      // --- Concurrency stress test (LLM transports only — embeddings/ONNX skipped) ---
      const concurrencyResults: { provider: string; model: string; concurrency: ConcurrencyResult }[] = [];
      const reachable = results.filter(r => r.status === 'ok' && (r.transport === 'claude_agent_sdk' || r.transport === 'google_genai'));
      const testedTransports = new Set<Transport>();

      for (const r of reachable) {
        if (testedTransports.has(r.transport)) continue;
        testedTransports.add(r.transport);

        const slots = r.transport === 'google_genai'
          ? (config.providers.google?.concurrency ?? 10)
          : (config.providers.anthropic?.concurrency ?? 24);

        if (!opts.json) {
          console.log(chalk.dim(`  Stress-testing ${r.provider} (${r.model}) × ${slots} concurrent...`));
        }

        try {
          const cr = r.transport === 'google_genai'
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
