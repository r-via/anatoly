// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';
import { ConfigV3Schema } from './config-v3.js';
import { adaptV3ToV2 } from './config-v3-adapter.js';

/**
 * Build a fully-valid v3 config and run it through the adapter. Returns the
 * raw adapter output (v2-shape), as well as the result of feeding that output
 * back through `ConfigSchema.parse()` so tests can verify both the raw mapping
 * and that the result is shape-compatible with v2.
 */
function adapt(v3Input: unknown): { v2: ReturnType<typeof adaptV3ToV2>; parsed: unknown } {
  const v3 = ConfigV3Schema.parse(v3Input);
  const v2 = adaptV3ToV2(v3);
  const parsed = ConfigSchema.parse(v2);
  return { v2, parsed };
}

function fullV3(): unknown {
  return {
    version: 3,
    providers: {
      anthropic: {
        transport: 'claude_agent_sdk',
        auth: 'oauth',
        concurrency: 24,
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
    evaluation: {
      axes: {
        utility: true,
        duplication: true,
        overengineering: false,
        tests: true,
        best_practices: true,
        correction: { enabled: true, model: 'anthropic/claude-opus-4-6' },
        documentation: {
          enabled: true,
          docs_path: 'site/docs',
          module_mapping: { 'site/docs/auth.md': ['src/auth/**/*.ts'] },
        },
      },
    },
    runtime: {
      concurrency: 16,
      timeout_per_file: 900,
      max_retries: 5,
      min_confidence: 80,
      max_stop_iterations: 4,
      agents: { max_turns: 50 },
      rag: { code_share: 0.7 },
      output: { max_runs: 30 },
      logging: { level: 'info', pretty: false, file: '/tmp/anatoly.log' },
    },
  };
}

// ---------------------------------------------------------------------------
// Providers mapping
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — providers', () => {
  it('maps anthropic claude_agent_sdk + oauth → mode: subscription', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.providers.anthropic).toEqual({ mode: 'subscription', concurrency: 24 });
  });

  it('maps anthropic claude_agent_sdk + api_key → mode: api with env_key', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.providers.anthropic.auth = 'api_key';
    delete v3.providers.anthropic.concurrency;
    v3.providers.anthropic.env_key = 'ANTHROPIC_API_KEY';
    const { v2 } = adapt(v3);
    expect(v2.providers.anthropic).toEqual({ mode: 'api', env_key: 'ANTHROPIC_API_KEY' });
  });

  it('maps openai_compatible providers as catchall mode: api', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.providers.mistral).toEqual({
      mode: 'api',
      env_key: 'MISTRAL_API_KEY',
    });
    expect(v2.providers.openrouter).toEqual({
      mode: 'api',
      env_key: 'OPENROUTER_API_KEY',
    });
  });

  it('drops onnxruntime_node providers from v2.providers', () => {
    const v3 = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
        },
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jinaai/jina-embeddings-v2-base-code', 'Xenova/all-MiniLM-L6-v2'],
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
          code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
          text: 'local-lite/Xenova/all-MiniLM-L6-v2',
        },
      },
    };
    const { v2 } = adapt(v3);
    expect(v2.providers).not.toHaveProperty('local-lite');
    expect(v2.providers).toHaveProperty('anthropic');
  });

  it('preserves base_url for openai_compatible providers', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.providers.mistral.base_url = 'https://api.mistral.ai/v1';
    const { v2 } = adapt(v3);
    expect(v2.providers.mistral).toEqual({
      mode: 'api',
      env_key: 'MISTRAL_API_KEY',
      base_url: 'https://api.mistral.ai/v1',
    });
  });

  it('clamps concurrency above 32 to v2 max', () => {
    const v3 = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          concurrency: 100,
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
        },
      },
      routing: {
        generation: {
          quality: 'anthropic/claude-sonnet-4-6',
          fast: 'anthropic/claude-haiku-4-5',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-haiku-4-5',
        },
        embeddings: { code: 'anthropic/claude-sonnet-4-6', text: 'anthropic/claude-sonnet-4-6' },
      },
    };
    // Note: routing.embeddings pointing to claude_agent_sdk would normally fail
    // capability validation — work around by using a separate ONNX provider
    // for the embedding-only test of clamping.
    const v3b = {
      ...v3,
      providers: {
        ...v3.providers,
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jinaai/jina-embeddings-v2-base-code'],
        },
      },
      routing: {
        ...v3.routing,
        embeddings: {
          code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
          text: 'local-lite/jinaai/jina-embeddings-v2-base-code',
        },
      },
    };
    const { v2 } = adapt(v3b);
    expect(v2.providers.anthropic.concurrency).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Models / agents / runtime
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — models', () => {
  it('maps generation slots to v2 models keys (summarization → code_summary)', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.models).toEqual({
      quality: 'anthropic/claude-sonnet-4-6',
      fast: 'anthropic/claude-haiku-4-5-20251001',
      deliberation: 'anthropic/claude-opus-4-6',
      code_summary: 'anthropic/claude-haiku-4-5-20251001',
    });
  });
});

describe('adaptV3ToV2 — agents', () => {
  it('lifts max_turns from runtime.agents into agents top-level', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.agents).toEqual({ enabled: true, max_turns: 50 });
  });
});

describe('adaptV3ToV2 — runtime', () => {
  it('copies runtime numeric knobs to v2.runtime', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.runtime).toEqual({
      concurrency: 10, // clamped from v3's 16 to v2's max=10
      timeout_per_file: 900,
      max_retries: 5,
      min_confidence: 80,
      max_stop_iterations: 4,
    });
  });

  it('clamps runtime.concurrency to v2 max=10', () => {
    const v3 = fullV3() as Record<string, Record<string, unknown>>;
    (v3.runtime as Record<string, unknown>).concurrency = 64;
    const { v2 } = adapt(v3);
    expect(v2.runtime.concurrency).toBe(10);
  });

  it('does not raise concurrency below the v3 value', () => {
    const v3 = fullV3() as Record<string, Record<string, unknown>>;
    (v3.runtime as Record<string, unknown>).concurrency = 4;
    const { v2 } = adapt(v3);
    expect(v2.runtime.concurrency).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// RAG / embeddings
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — rag (network embeddings)', () => {
  it('builds rag.embedding.code/nlp from network providers', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.rag.code_model).toBe('auto');
    expect(v2.rag.nlp_model).toBe('auto');
    expect(v2.rag.embedding.code).toEqual({
      provider: 'mistral',
      model: 'mistral-embed',
      env_key: 'MISTRAL_API_KEY',
    });
    expect(v2.rag.embedding.nlp).toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3-embedding-8b',
      env_key: 'OPENROUTER_API_KEY',
    });
  });

  it('carries code_share into code_weight', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.rag.code_weight).toBe(0.7);
  });

  it('preserves base_url when set on the network provider', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.providers.mistral.base_url = 'https://api.mistral.ai/v1';
    const { v2 } = adapt(v3);
    expect(v2.rag.embedding.code.base_url).toBe('https://api.mistral.ai/v1');
  });
});

describe('adaptV3ToV2 — rag (ONNX local embeddings)', () => {
  it('sets rag.code_model directly when code points to onnxruntime_node', () => {
    const v3 = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
        },
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jinaai/jina-embeddings-v2-base-code', 'Xenova/all-MiniLM-L6-v2'],
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
          code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
          text: 'local-lite/Xenova/all-MiniLM-L6-v2',
        },
      },
    };
    const { v2 } = adapt(v3);
    expect(v2.rag.code_model).toBe('jinaai/jina-embeddings-v2-base-code');
    expect(v2.rag.nlp_model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(v2.rag.embedding).toBeUndefined();
  });

  it('handles mixed local-code + network-text', () => {
    const v3 = {
      version: 3,
      providers: {
        anthropic: {
          transport: 'claude_agent_sdk',
          auth: 'oauth',
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
        },
        'local-lite': {
          transport: 'onnxruntime_node',
          models: ['jinaai/jina-embeddings-v2-base-code'],
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
          fast: 'anthropic/claude-haiku-4-5',
          deliberation: 'anthropic/claude-opus-4-6',
          summarization: 'anthropic/claude-haiku-4-5',
        },
        embeddings: {
          code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
          text: 'openrouter/qwen/qwen3-embedding-8b',
        },
      },
    };
    const { v2 } = adapt(v3);
    expect(v2.rag.code_model).toBe('jinaai/jina-embeddings-v2-base-code');
    expect(v2.rag.nlp_model).toBe('auto');
    expect(v2.rag.embedding).toEqual({
      nlp: {
        provider: 'openrouter',
        model: 'qwen/qwen3-embedding-8b',
        env_key: 'OPENROUTER_API_KEY',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — axes', () => {
  it('normalizes bool short forms into { enabled }', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.axes.utility).toEqual({ enabled: true });
    expect(v2.axes.duplication).toEqual({ enabled: true });
    expect(v2.axes.overengineering).toEqual({ enabled: false });
  });

  it('preserves model overrides on object-form axes', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.axes.correction).toEqual({
      enabled: true,
      model: 'anthropic/claude-opus-4-6',
    });
  });

  it('preserves skip globs', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.evaluation.axes.utility = { enabled: true, skip: ['legacy/**'] };
    const { v2 } = adapt(v3);
    expect(v2.axes.utility).toEqual({ enabled: true, skip: ['legacy/**'] });
  });

  it('does not retain docs_path / module_mapping inside axes.documentation', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.axes.documentation).toEqual({ enabled: true });
    expect(v2.axes.documentation).not.toHaveProperty('docs_path');
    expect(v2.axes.documentation).not.toHaveProperty('module_mapping');
  });
});

// ---------------------------------------------------------------------------
// Documentation lift-out
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — documentation', () => {
  it('lifts docs_path and module_mapping into top-level documentation', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.documentation).toEqual({
      docs_path: 'site/docs',
      module_mapping: { 'site/docs/auth.md': ['src/auth/**/*.ts'] },
    });
  });

  it('omits the documentation section when axis is bool', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.evaluation.axes.documentation = true as unknown as Record<string, unknown>;
    const { v2 } = adapt(v3);
    expect(v2.documentation).toBeUndefined();
  });

  it('emits the default docs_path when axis is in object form', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    v3.evaluation.axes.documentation = { enabled: true } as unknown as Record<string, unknown>;
    const { v2 } = adapt(v3);
    // DocumentationAxisSchema fills docs_path with 'docs' by default, so any
    // object-form axis carries docs_path even without explicit user input.
    expect(v2.documentation).toEqual({ docs_path: 'docs' });
  });
});

// ---------------------------------------------------------------------------
// Output / logging
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — output and logging', () => {
  it('passes max_runs to v2.output', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.output).toEqual({ max_runs: 30 });
  });

  it('omits v2.output when max_runs is unset', () => {
    const v3 = fullV3() as Record<string, Record<string, Record<string, unknown>>>;
    delete (v3.runtime.output as Record<string, unknown>).max_runs;
    const { v2 } = adapt(v3);
    expect(v2.output).toBeUndefined();
  });

  it('copies logging fields, including optional file sink', () => {
    const { v2 } = adapt(fullV3());
    expect(v2.logging).toEqual({
      level: 'info',
      pretty: false,
      file: '/tmp/anatoly.log',
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end shape compatibility
// ---------------------------------------------------------------------------

describe('adaptV3ToV2 — round-trip through ConfigSchema', () => {
  it('produces a v2-shape that ConfigSchema.parse() accepts', () => {
    const { parsed } = adapt(fullV3());
    expect(parsed).toBeDefined();
  });

  it('parsed config has the expected top-level keys', () => {
    const { parsed } = adapt(fullV3()) as { parsed: Record<string, unknown> };
    expect(parsed).toHaveProperty('providers');
    expect(parsed).toHaveProperty('models');
    expect(parsed).toHaveProperty('rag');
    expect(parsed).toHaveProperty('axes');
    expect(parsed).toHaveProperty('agents');
    expect(parsed).toHaveProperty('runtime');
  });
});
