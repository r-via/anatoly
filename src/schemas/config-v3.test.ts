// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENTIC_TRANSPORTS,
  AuthSchema,
  ConfigV3Schema,
  EMBEDDING_TRANSPORTS,
  EvaluationConfigSchema,
  ProviderConfigSchema,
  ProvidersConfigSchema,
  RoutingConfigSchema,
  RuntimeConfigSchema,
  TransportSchema,
  isV3Config,
  parseModelRef,
  resolveAxis,
} from './config-v3.js';

// Helper: minimal valid config used as a baseline for most tests.
function baseConfig(): unknown {
  return {
    version: 3,
    providers: {
      anthropic: {
        transport: 'claude_agent_sdk',
        auth: 'oauth',
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
      },
      mistral: {
        transport: 'openai_compatible',
        auth: 'api_key',
        env_key: 'MISTRAL_API_KEY',
        models: ['mistral-embed'],
      },
      openrouter: {
        transport: 'openai_compatible',
        auth: 'api_key',
        env_key: 'OPENROUTER_API_KEY',
        models: ['qwen/qwen3-embedding-8b'],
      },
    },
    routing: {
      generation: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        summarization: 'anthropic/claude-haiku-4-5-20251001',
      },
      embeddings: {
        code: 'mistral/mistral-embed',
        text: 'openrouter/qwen/qwen3-embedding-8b',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic schemas (transport, auth, provider config)
// ---------------------------------------------------------------------------

describe('TransportSchema', () => {
  it('accepts the four canonical transports', () => {
    expect(TransportSchema.parse('claude_agent_sdk')).toBe('claude_agent_sdk');
    expect(TransportSchema.parse('google_genai')).toBe('google_genai');
    expect(TransportSchema.parse('openai_compatible')).toBe('openai_compatible');
    expect(TransportSchema.parse('onnxruntime_node')).toBe('onnxruntime_node');
  });

  it('rejects unknown transports', () => {
    expect(() => TransportSchema.parse('vercel_ai_sdk')).toThrow();
    expect(() => TransportSchema.parse('@anthropic-ai/claude-agent-sdk')).toThrow();
    expect(() => TransportSchema.parse('')).toThrow();
  });
});

describe('AuthSchema', () => {
  it('accepts oauth and api_key', () => {
    expect(AuthSchema.parse('oauth')).toBe('oauth');
    expect(AuthSchema.parse('api_key')).toBe('api_key');
  });
  it('rejects others', () => {
    expect(() => AuthSchema.parse('subscription')).toThrow();
  });
});

describe('Capability sets', () => {
  it('AGENTIC_TRANSPORTS covers exactly claude_agent_sdk + google_genai', () => {
    expect(AGENTIC_TRANSPORTS.has('claude_agent_sdk')).toBe(true);
    expect(AGENTIC_TRANSPORTS.has('google_genai')).toBe(true);
    expect(AGENTIC_TRANSPORTS.has('openai_compatible')).toBe(false);
    expect(AGENTIC_TRANSPORTS.has('onnxruntime_node')).toBe(false);
  });
  it('EMBEDDING_TRANSPORTS covers openai_compatible + onnxruntime_node', () => {
    expect(EMBEDDING_TRANSPORTS.has('openai_compatible')).toBe(true);
    expect(EMBEDDING_TRANSPORTS.has('onnxruntime_node')).toBe(true);
    expect(EMBEDDING_TRANSPORTS.has('claude_agent_sdk')).toBe(false);
    expect(EMBEDDING_TRANSPORTS.has('google_genai')).toBe(false);
  });
});

describe('ProviderConfigSchema', () => {
  it('accepts a network provider with api_key', () => {
    const r = ProviderConfigSchema.parse({
      transport: 'openai_compatible',
      auth: 'api_key',
      env_key: 'MISTRAL_API_KEY',
      models: ['mistral-embed'],
    });
    expect(r.transport).toBe('openai_compatible');
  });

  it('accepts an oauth provider without env_key', () => {
    const r = ProviderConfigSchema.parse({
      transport: 'claude_agent_sdk',
      auth: 'oauth',
      models: ['claude-sonnet-4-6'],
    });
    expect(r.auth).toBe('oauth');
  });

  it('accepts onnxruntime_node with no auth, no env_key, no base_url', () => {
    const r = ProviderConfigSchema.parse({
      transport: 'onnxruntime_node',
      models: ['jina-v2-base-code', 'all-MiniLM-L6-v2'],
    });
    expect(r.transport).toBe('onnxruntime_node');
    expect(r.auth).toBeUndefined();
  });

  it('rejects network provider without auth', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'openai_compatible',
        env_key: 'X',
        models: ['m'],
      }),
    ).toThrow(/requires an auth method/);
  });

  it('rejects api_key without env_key', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'openai_compatible',
        auth: 'api_key',
        models: ['m'],
      }),
    ).toThrow(/requires env_key/);
  });

  it('rejects oauth with env_key (mutually exclusive)', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'claude_agent_sdk',
        auth: 'oauth',
        env_key: 'ANTHROPIC_API_KEY',
        models: ['claude-sonnet-4-6'],
      }),
    ).toThrow(/oauth must not specify env_key/);
  });

  it('rejects openai_compatible + oauth', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'openai_compatible',
        auth: 'oauth',
        models: ['m'],
      }),
    ).toThrow(/openai_compatible does not support oauth/);
  });

  it('rejects onnxruntime_node with auth', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'onnxruntime_node',
        auth: 'api_key',
        env_key: 'X',
        models: ['m'],
      }),
    ).toThrow(/onnxruntime_node has no auth/);
  });

  it('rejects empty models list', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'onnxruntime_node',
        models: [],
      }),
    ).toThrow();
  });

  it('rejects duplicate models within a provider', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'onnxruntime_node',
        models: ['jina-v2-base-code', 'jina-v2-base-code'],
      }),
    ).toThrow(/duplicate model/);
  });

  it('rejects malformed base_url', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        transport: 'openai_compatible',
        auth: 'api_key',
        env_key: 'X',
        base_url: 'not a url',
        models: ['m'],
      }),
    ).toThrow();
  });
});

describe('ProvidersConfigSchema', () => {
  it('rejects empty providers map', () => {
    expect(() => ProvidersConfigSchema.parse({})).toThrow(/at least one provider/);
  });

  it('rejects provider id with uppercase', () => {
    expect(() =>
      ProvidersConfigSchema.parse({
        Anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6'],
        },
      }),
    ).toThrow();
  });

  it('accepts kebab-case provider ids', () => {
    const r = ProvidersConfigSchema.parse({
      'local-lite': {
        transport: 'onnxruntime_node',
        models: ['jina-v2-base-code'],
      },
      'local-advanced': {
        transport: 'openai_compatible',
        auth: 'api_key',
        env_key: 'DUMMY',
        base_url: 'http://localhost:8082/v1',
        models: ['nomic-embed-code-gguf'],
      },
    });
    expect(Object.keys(r)).toEqual(['local-lite', 'local-advanced']);
  });
});

// ---------------------------------------------------------------------------
// parseModelRef
// ---------------------------------------------------------------------------

describe('parseModelRef', () => {
  it('parses simple provider/model', () => {
    expect(parseModelRef('mistral/mistral-embed')).toEqual({
      provider: 'mistral',
      model: 'mistral-embed',
      raw: 'mistral/mistral-embed',
    });
  });

  it('parses multi-segment models', () => {
    expect(parseModelRef('openrouter/qwen/qwen3-embedding-8b')).toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3-embedding-8b',
      raw: 'openrouter/qwen/qwen3-embedding-8b',
    });
  });

  it('returns null on bare model id', () => {
    expect(parseModelRef('mistral-embed')).toBeNull();
  });

  it('returns null when provider is empty', () => {
    expect(parseModelRef('/mistral-embed')).toBeNull();
  });

  it('returns null when model is empty', () => {
    expect(parseModelRef('mistral/')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RoutingConfigSchema (in isolation, before cross-reference)
// ---------------------------------------------------------------------------

describe('RoutingConfigSchema', () => {
  it('accepts well-formed model refs', () => {
    const r = RoutingConfigSchema.parse({
      generation: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        summarization: 'anthropic/claude-haiku-4-5-20251001',
      },
      embeddings: {
        code: 'mistral/mistral-embed',
        text: 'openrouter/qwen/qwen3-embedding-8b',
      },
    });
    expect(r.generation.quality).toBe('anthropic/claude-sonnet-4-6');
  });

  it('rejects bare model refs without provider prefix', () => {
    expect(() =>
      RoutingConfigSchema.parse({
        generation: {
          quality: 'claude-sonnet-4-6',
          fast: 'anthropic/claude-haiku-4-5',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-haiku-4-5',
        },
        embeddings: {
          code: 'mistral/mistral-embed',
          text: 'openrouter/qwen/qwen3-embedding-8b',
        },
      }),
    ).toThrow(/<provider>\/<model>/);
  });
});

// ---------------------------------------------------------------------------
// EvaluationConfigSchema
// ---------------------------------------------------------------------------

describe('EvaluationConfigSchema', () => {
  it('applies defaults when omitted', () => {
    const r = EvaluationConfigSchema.parse({});
    expect(r.axes.utility).toBe(true);
    expect(r.axes.duplication).toBe(true);
    expect(r.axes.documentation).toBe(true);
  });

  it('accepts bool short form', () => {
    const r = EvaluationConfigSchema.parse({
      axes: { utility: false, duplication: true },
    });
    expect(r.axes.utility).toBe(false);
    expect(r.axes.duplication).toBe(true);
  });

  it('accepts long-form override with model', () => {
    const r = EvaluationConfigSchema.parse({
      axes: {
        correction: { enabled: true, model: 'anthropic/claude-opus-4-6' },
      },
    });
    expect(r.axes.correction).toEqual({ enabled: true, model: 'anthropic/claude-opus-4-6' });
  });

  it('accepts documentation extra fields', () => {
    const r = EvaluationConfigSchema.parse({
      axes: {
        documentation: {
          enabled: true,
          docs_path: 'site/docs',
          module_mapping: { 'site/docs/auth.md': ['src/auth/**/*.ts'] },
        },
      },
    });
    const doc = r.axes.documentation;
    if (typeof doc === 'boolean') throw new Error('expected object form');
    expect(doc.docs_path).toBe('site/docs');
    expect(doc.module_mapping).toEqual({ 'site/docs/auth.md': ['src/auth/**/*.ts'] });
  });
});

describe('resolveAxis', () => {
  it('normalizes the bool short form', () => {
    expect(resolveAxis(true)).toEqual({ enabled: true });
    expect(resolveAxis(false)).toEqual({ enabled: false });
  });
  it('returns object form unchanged for enabled+model', () => {
    expect(
      resolveAxis({ enabled: true, model: 'anthropic/claude-opus-4-6' }),
    ).toEqual({ enabled: true, model: 'anthropic/claude-opus-4-6' });
  });
  it('drops absent fields', () => {
    expect(resolveAxis({ enabled: false })).toEqual({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// RuntimeConfigSchema
// ---------------------------------------------------------------------------

describe('RuntimeConfigSchema', () => {
  it('applies all defaults when given {}', () => {
    const r = RuntimeConfigSchema.parse({});
    expect(r.concurrency).toBe(8);
    expect(r.agents.max_turns).toBe(30);
    expect(r.rag.code_share).toBe(0.6);
    expect(r.logging.level).toBe('warn');
    expect(r.logging.pretty).toBe(true);
  });

  it('rejects code_share outside [0,1]', () => {
    expect(() => RuntimeConfigSchema.parse({ rag: { code_share: 1.5 } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ rag: { code_share: -0.1 } })).toThrow();
  });

  it('rejects max_turns outside [1,200]', () => {
    expect(() => RuntimeConfigSchema.parse({ agents: { max_turns: 0 } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ agents: { max_turns: 999 } })).toThrow();
  });

  it('accepts a logging file sink', () => {
    const r = RuntimeConfigSchema.parse({ logging: { file: '/var/log/anatoly.log' } });
    expect(r.logging.file).toBe('/var/log/anatoly.log');
  });
});

// ---------------------------------------------------------------------------
// ConfigV3Schema (full cross-reference validation)
// ---------------------------------------------------------------------------

describe('ConfigV3Schema — happy path', () => {
  it('accepts the canonical full config', () => {
    const r = ConfigV3Schema.parse(baseConfig());
    expect(r.version).toBe(3);
    expect(r.routing.generation.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(r.routing.embeddings.text).toBe('openrouter/qwen/qwen3-embedding-8b');
  });

  it('applies runtime defaults when runtime section is omitted', () => {
    const r = ConfigV3Schema.parse(baseConfig());
    expect(r.runtime.concurrency).toBe(8);
    expect(r.runtime.agents.max_turns).toBe(30);
    expect(r.runtime.rag.code_share).toBe(0.6);
  });

  it('accepts evaluation overrides referencing a declared model', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    cfg.evaluation = {
      axes: {
        correction: { enabled: true, model: 'anthropic/claude-opus-4-6' },
      },
    };
    const r = ConfigV3Schema.parse(cfg);
    expect(r.evaluation.axes.correction).toEqual({
      enabled: true,
      model: 'anthropic/claude-opus-4-6',
    });
  });

  it('accepts a config with local providers only', () => {
    const cfg = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
        },
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jina-v2-base-code', 'all-MiniLM-L6-v2'],
        },
      },
      routing: {
        generation: {
          quality: 'anthropic/claude-sonnet-4-6',
          fast: 'anthropic/claude-haiku-4-5-20251001',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-haiku-4-5-20251001',
        },
        embeddings: {
          code: 'local-lite/jina-v2-base-code',
          text: 'local-lite/all-MiniLM-L6-v2',
        },
      },
    };
    const r = ConfigV3Schema.parse(cfg);
    expect(r.routing.embeddings.code).toBe('local-lite/jina-v2-base-code');
  });
});

describe('ConfigV3Schema — version literal', () => {
  it('rejects missing version', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    delete cfg.version;
    expect(() => ConfigV3Schema.parse(cfg)).toThrow();
  });

  it('rejects version: 2 (v2 schema rejected)', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    cfg.version = 2;
    expect(() => ConfigV3Schema.parse(cfg)).toThrow();
  });

  it('rejects version: "3" (string not number)', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    cfg.version = '3';
    expect(() => ConfigV3Schema.parse(cfg)).toThrow();
  });
});

describe('ConfigV3Schema — cross-reference: provider existence', () => {
  it('rejects routing.generation pointing to unknown provider', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    routing.generation.quality = 'ghost/some-model';
    const r = ConfigV3Schema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toContainEqual(expect.objectContaining({
        path: ['routing', 'generation', 'quality'],
        message: expect.stringContaining('provider "ghost" not declared') as unknown as string,
      }));
    }
  });

  it('rejects routing.embeddings pointing to unknown provider', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    routing.embeddings.code = 'ghost/voyage-code-3';
    const r = ConfigV3Schema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toContainEqual(expect.objectContaining({
        path: ['routing', 'embeddings', 'code'],
        message: expect.stringContaining('provider "ghost" not declared') as unknown as string,
      }));
    }
  });

  it('rejects evaluation override pointing to unknown provider', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    cfg.evaluation = {
      axes: { correction: { enabled: true, model: 'ghost/big-model' } },
    };
    const r = ConfigV3Schema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toContainEqual(expect.objectContaining({
        path: ['evaluation', 'axes', 'correction', 'model'],
        message: expect.stringContaining('provider "ghost" not declared') as unknown as string,
      }));
    }
  });
});

describe('ConfigV3Schema — cross-reference: model declaration', () => {
  it('rejects model not declared under its provider', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    routing.generation.quality = 'anthropic/claude-undeclared-model';
    const r = ConfigV3Schema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toContainEqual(expect.objectContaining({
        path: ['routing', 'generation', 'quality'],
        message: expect.stringContaining('model "claude-undeclared-model" not declared') as unknown as string,
      }));
    }
  });

  it('accepts when the model is declared with multi-segment id', () => {
    const r = ConfigV3Schema.parse(baseConfig());
    expect(r.routing.embeddings.text).toBe('openrouter/qwen/qwen3-embedding-8b');
  });
});

describe('ConfigV3Schema — transport capability checks', () => {
  it('rejects deliberation slot pointing to openai_compatible (no agentic)', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    // Mistral is openai_compatible — not agentic.
    const providers = cfg.providers as Record<string, { models: string[] }>;
    providers.mistral.models.push('mistral-large-latest');
    routing.generation.deliberation = 'mistral/mistral-large-latest';
    expect(() => ConfigV3Schema.parse(cfg)).toThrow(/agentic-capable transport/);
  });

  it('rejects embeddings slot pointing to claude_agent_sdk', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    routing.embeddings.code = 'anthropic/claude-sonnet-4-6';
    expect(() => ConfigV3Schema.parse(cfg)).toThrow(/embedding-capable transport/);
  });

  it('rejects single_turn slot pointing to onnxruntime_node', () => {
    const cfg = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
        },
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jina-v2-base-code', 'all-MiniLM-L6-v2'],
        },
      },
      routing: {
        generation: {
          quality: 'local-lite/all-MiniLM-L6-v2',  // wrong: ONNX is embeddings-only
          fast: 'anthropic/claude-haiku-4-5',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-haiku-4-5',
        },
        embeddings: {
          code: 'local-lite/jina-v2-base-code',
          text: 'local-lite/all-MiniLM-L6-v2',
        },
      },
    };
    expect(() => ConfigV3Schema.parse(cfg)).toThrow(/embeddings-only/);
  });
});

describe('ConfigV3Schema — multiple errors aggregated', () => {
  it('reports all provider-not-found errors at once (zod aggregates issues)', () => {
    const cfg = baseConfig() as Record<string, unknown>;
    const routing = cfg.routing as Record<string, Record<string, string>>;
    routing.generation.quality = 'unknown1/m';
    routing.embeddings.code = 'unknown2/m';
    const result = ConfigV3Schema.safeParse(cfg);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('"unknown1"'))).toBe(true);
      expect(messages.some((m) => m.includes('"unknown2"'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isV3Config
// ---------------------------------------------------------------------------

describe('isV3Config', () => {
  it('returns true for { version: 3 }', () => {
    expect(isV3Config({ version: 3 })).toBe(true);
  });
  it('returns false for v0/v1/v2 (no version or other version)', () => {
    expect(isV3Config({})).toBe(false);
    expect(isV3Config({ version: 1 })).toBe(false);
    expect(isV3Config({ version: 2 })).toBe(false);
    expect(isV3Config({ version: '3' })).toBe(false);
  });
  it('returns false for non-objects', () => {
    expect(isV3Config(null)).toBe(false);
    expect(isV3Config(undefined)).toBe(false);
    expect(isV3Config('string')).toBe(false);
    expect(isV3Config(3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke tests (ensure no inferred-any / never)
// ---------------------------------------------------------------------------

describe('type inference smoke', () => {
  it('ConfigV3Schema produces a typed object', () => {
    const r = ConfigV3Schema.parse(baseConfig());
    // Type assertion: the runtime object has all expected discriminated keys.
    const _: z.infer<typeof ConfigV3Schema> = r;
    expect(_).toBeDefined();
  });
});
