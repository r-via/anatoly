// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildProviderChecks, formatProvidersTable, formatAuthLabel, type ProviderCheckResult } from './providers.js';
import { ConfigSchema } from '../schemas/config.js';
import type { Config } from '../schemas/config.js';
import { ConfigV3Schema } from '../schemas/config-v3.js';
import { adaptV3ToV2 } from '../schemas/config-v3-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

/**
 * Build a v3-loaded Config the same way `loadConfig` does: parse v3, adapt to
 * v2, then attach the v3 source on the documented hidden Symbol so
 * `getV3Source` returns it. Mirrors `config-loader.ts:111`.
 */
function makeV3Config(v3Yaml: Record<string, unknown>): Config {
  const v3 = ConfigV3Schema.parse(v3Yaml);
  const adapted = adaptV3ToV2(v3);
  const final = ConfigSchema.parse(adapted);
  Object.defineProperty(final, Symbol.for('anatoly.config.v3Source'), {
    value: structuredClone(v3),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return final;
}

const MINIMAL_V3 = {
  version: 3,
  providers: {
    anthropic: {
      transport: 'claude_agent_sdk',
      auth: 'oauth',
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
    },
    'local-onnx': {
      transport: 'onnxruntime_node',
      models: ['all-MiniLM-L6-v2'],
    },
  },
  routing: {
    generation: {
      quality: 'anthropic/claude-sonnet-4-6',
      fast: 'anthropic/claude-haiku-4-5',
      deliberation: 'anthropic/claude-opus-4-6',
      summarization: 'anthropic/claude-haiku-4-5',
    },
    embeddings: {
      code: 'local-onnx/all-MiniLM-L6-v2',
      text: 'local-onnx/all-MiniLM-L6-v2',
    },
  },
} as const;

function withProviders(extra: Record<string, unknown>) {
  return {
    ...MINIMAL_V3,
    providers: { ...MINIMAL_V3.providers, ...extra },
  };
}

// ---------------------------------------------------------------------------
// formatAuthLabel — pure derivation from v3 declaration
// ---------------------------------------------------------------------------

describe('formatAuthLabel', () => {
  it('returns OAuth for auth=oauth', () => {
    expect(formatAuthLabel({ transport: 'claude_agent_sdk', auth: 'oauth' })).toBe('OAuth');
  });

  it('returns "API Key (ENV_VAR)" for api_key with env_key', () => {
    expect(formatAuthLabel({ transport: 'google_genai', auth: 'api_key', env_key: 'GEMINI_API_KEY' }))
      .toBe('API Key (GEMINI_API_KEY)');
  });

  it('returns "Local" for auth=none (system-local sidecar)', () => {
    expect(formatAuthLabel({
      transport: 'openai_compatible',
      auth: 'none',
      base_url: 'http://localhost:8082/v1',
    })).toBe('Local');
  });

  it('returns "Local (in-process)" for onnxruntime_node', () => {
    expect(formatAuthLabel({ transport: 'onnxruntime_node' })).toBe('Local (in-process)');
  });
});

// ---------------------------------------------------------------------------
// buildProviderChecks — v3 path
// ---------------------------------------------------------------------------

describe('buildProviderChecks (v3)', () => {
  it('walks every routing reference and includes transport + auth from v3', () => {
    const config = makeV3Config({
      ...withProviders({
        google: {
          transport: 'google_genai',
          auth: 'api_key',
          env_key: 'GEMINI_API_KEY',
          models: ['gemini-2.5-flash-lite'],
        },
        'local-advanced': {
          transport: 'openai_compatible',
          auth: 'none',
          base_url: 'http://localhost:8082/v1',
          models: ['nomic-embed-code-gguf', 'qwen3-embedding-8b-gguf'],
        },
      }),
      routing: {
        generation: {
          quality: 'anthropic/claude-sonnet-4-6',
          fast: 'anthropic/claude-haiku-4-5',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'google/gemini-2.5-flash-lite',
        },
        embeddings: {
          code: 'local-advanced/nomic-embed-code-gguf',
          text: 'local-advanced/qwen3-embedding-8b-gguf',
        },
      },
    });

    const checks = buildProviderChecks(config);

    const byProvider = (id: string) => checks.filter(c => c.provider === id);

    expect(byProvider('anthropic').length).toBeGreaterThanOrEqual(3);
    expect(byProvider('anthropic')[0]!.transport).toBe('claude_agent_sdk');
    expect(byProvider('anthropic')[0]!.auth).toBe('OAuth');

    expect(byProvider('google').length).toBe(1);
    expect(byProvider('google')[0]!.transport).toBe('google_genai');
    expect(byProvider('google')[0]!.auth).toBe('API Key (GEMINI_API_KEY)');

    expect(byProvider('local-advanced').length).toBe(2);
    expect(byProvider('local-advanced')[0]!.transport).toBe('openai_compatible');
    expect(byProvider('local-advanced')[0]!.auth).toBe('Local');
  });

  it('marks ONNX providers as Local (in-process) without an env_key', () => {
    const config = makeV3Config(MINIMAL_V3);
    const checks = buildProviderChecks(config);
    const onnx = checks.find(c => c.provider === 'local-onnx');
    expect(onnx).toBeDefined();
    expect(onnx!.transport).toBe('onnxruntime_node');
    expect(onnx!.auth).toBe('Local (in-process)');
    expect(onnx!.envKey).toBeUndefined();
  });

  it('deduplicates by full <provider>/<model> reference', () => {
    const config = makeV3Config({
      ...MINIMAL_V3,
      routing: {
        generation: {
          quality: 'anthropic/claude-sonnet-4-6',
          fast: 'anthropic/claude-sonnet-4-6',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-sonnet-4-6',
        },
        embeddings: {
          code: 'local-onnx/all-MiniLM-L6-v2',
          text: 'local-onnx/all-MiniLM-L6-v2',
        },
      },
    });
    const checks = buildProviderChecks(config);
    const sonnetCount = checks.filter(c => c.model === 'anthropic/claude-sonnet-4-6').length;
    expect(sonnetCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildProviderChecks — v2 fallback path
// ---------------------------------------------------------------------------

describe('buildProviderChecks (v2 fallback)', () => {
  it('returns Claude models when only the default provider is configured', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every(c => c.provider === 'anthropic')).toBe(true);
    expect(checks.every(c => c.transport === 'claude_agent_sdk')).toBe(true);
    // Default anthropic mode is 'subscription' → 'OAuth' label
    expect(checks.every(c => c.auth === 'OAuth')).toBe(true);
  });

  it('includes the main model and deliberation model', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    const models = checks.map(c => c.model);
    expect(models).toContain('anthropic/claude-sonnet-4-6');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('deduplicates models', () => {
    const config = makeConfig({
      models: { quality: 'anthropic/claude-sonnet-4-6', deliberation: 'anthropic/claude-sonnet-4-6' },
    });
    const checks = buildProviderChecks(config);
    const sonnetCount = checks.filter(c => c.model === 'anthropic/claude-sonnet-4-6').length;
    expect(sonnetCount).toBe(1);
  });

  it('includes fast model (haiku) in checks', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    const models = checks.map(c => c.model);
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// formatProvidersTable
// ---------------------------------------------------------------------------

describe('formatProvidersTable', () => {
  const results: ProviderCheckResult[] = [
    { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', latencyMs: 1234, auth: 'OAuth', transport: 'claude_agent_sdk' },
    { provider: 'anthropic', model: 'claude-opus-4-6', status: 'error', latencyMs: 0, auth: 'OAuth', transport: 'claude_agent_sdk', error: 'timeout' },
  ];

  it('produces a string containing all providers', () => {
    const table = formatProvidersTable(results);
    expect(table).toContain('anthropic');
    expect(table).toContain('claude-sonnet-4-6');
    expect(table).toContain('claude-opus-4-6');
  });

  it('shows checkmark for successful checks', () => {
    const table = formatProvidersTable(results);
    expect(table).toMatch(/✓/);
  });

  it('shows cross for failed checks', () => {
    const table = formatProvidersTable(results);
    expect(table).toMatch(/✗/);
  });

  it('displays latency for successful checks', () => {
    const table = formatProvidersTable(results);
    expect(table).toContain('1234');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('JSON output shape', () => {
  it('produces valid JSON with providers array', () => {
    const results: ProviderCheckResult[] = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', latencyMs: 500, auth: 'OAuth', transport: 'claude_agent_sdk' },
    ];
    const json = JSON.parse(JSON.stringify({ providers: results }));
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'ok',
      latencyMs: 500,
      auth: 'OAuth',
      transport: 'claude_agent_sdk',
    });
  });
});
