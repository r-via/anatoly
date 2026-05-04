// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  KNOWN_EMBEDDING_PROVIDERS,
  resolveEmbeddingProvider,
  findExternalConfigIssues,
  type KnownEmbeddingProviderEntry,
} from './known-embedding-providers.js';

// ---------------------------------------------------------------------------
// AC: KNOWN_EMBEDDING_PROVIDERS registry contents
// ---------------------------------------------------------------------------

describe('KNOWN_EMBEDDING_PROVIDERS registry', () => {
  const expectedIds = ['openai', 'voyage', 'openrouter', 'cohere', 'mistral', 'anatoly-local'];

  it('should contain all 6 expected embedding provider entries', () => {
    for (const id of expectedIds) {
      expect(KNOWN_EMBEDDING_PROVIDERS).toHaveProperty(id);
    }
    expect(Object.keys(KNOWN_EMBEDDING_PROVIDERS)).toHaveLength(6);
  });

  it('should have required fields on every entry', () => {
    for (const [id, entry] of Object.entries(KNOWN_EMBEDDING_PROVIDERS)) {
      expect(entry).toHaveProperty('base_url');
      expect(entry).toHaveProperty('env_key');
      expect(entry).toHaveProperty('type');
      expect(['native', 'openai-compatible']).toContain(entry.type);
      // env_key is null or string
      if (entry.env_key !== null) {
        expect(typeof entry.env_key).toBe('string');
      }
      // base_url is null, string, or function
      if (entry.base_url !== null && typeof entry.base_url !== 'function') {
        expect(typeof entry.base_url).toBe('string');
      }
      // default models should be present
      expect(typeof entry.default_code_model).toBe('string');
      expect(typeof entry.default_nlp_model).toBe('string');
      // Validate: if entry has a pre_hook, it must be a function
      if (entry.pre_hook) {
        expect(typeof entry.pre_hook).toBe('function');
      }
    }
  });

  // --- env_key format validation ---
  it('should have env_key values containing only [A-Z0-9_]', () => {
    for (const [, entry] of Object.entries(KNOWN_EMBEDDING_PROVIDERS)) {
      if (entry.env_key !== null) {
        expect(entry.env_key).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  // --- base_url validation (non-null, non-function strings must end with /v1) ---
  it('should have valid base_url strings ending with /v1', () => {
    for (const [, entry] of Object.entries(KNOWN_EMBEDDING_PROVIDERS)) {
      if (typeof entry.base_url === 'string') {
        expect(entry.base_url).toMatch(/\/v1$/);
        // Must be a valid URL
        expect(() => new URL(entry.base_url as string)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC: Individual provider entries
// ---------------------------------------------------------------------------

describe('openai embedding provider', () => {
  it('should have correct configuration', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS.openai;
    expect(entry.base_url).toBeNull();
    expect(entry.env_key).toBe('OPENAI_API_KEY');
    expect(entry.type).toBe('native');
    expect(entry.default_code_model).toBe('text-embedding-3-large');
    expect(entry.default_nlp_model).toBe('text-embedding-3-large');
    expect(entry.max_per_call).toBeUndefined();
    expect(entry.supports_parallel).toBeUndefined();
  });
});

describe('voyage embedding provider', () => {
  it('should have correct configuration', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS.voyage;
    expect(entry.base_url).toBe('https://api.voyageai.com/v1');
    expect(entry.env_key).toBe('VOYAGE_API_KEY');
    expect(entry.type).toBe('openai-compatible');
    expect(entry.default_code_model).toBe('voyage-code-3');
    expect(entry.default_nlp_model).toBe('voyage-3-large');
  });
});

describe('openrouter embedding provider', () => {
  it('should route Qwen3-Embedding-8B via OpenRouter aggregator', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS.openrouter;
    expect(entry.base_url).toBe('https://openrouter.ai/api/v1');
    expect(entry.env_key).toBe('OPENROUTER_API_KEY');
    expect(entry.type).toBe('openai-compatible');
    expect(entry.default_code_model).toBe('qwen/qwen3-embedding-8b');
    expect(entry.default_nlp_model).toBe('qwen/qwen3-embedding-8b');
  });
});

describe('cohere embedding provider', () => {
  it('should have correct configuration', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS.cohere;
    expect(entry.env_key).toBe('COHERE_API_KEY');
    expect(entry.type).toBe('openai-compatible');
    expect(typeof entry.default_code_model).toBe('string');
    expect(typeof entry.default_nlp_model).toBe('string');
  });
});

describe('mistral embedding provider', () => {
  it('should have correct configuration', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS.mistral;
    expect(entry.base_url).toBe('https://api.mistral.ai/v1');
    expect(entry.env_key).toBe('MISTRAL_API_KEY');
    expect(entry.type).toBe('openai-compatible');
    expect(typeof entry.default_code_model).toBe('string');
    expect(typeof entry.default_nlp_model).toBe('string');
  });
});

describe('anatoly-local embedding provider', () => {
  it('should have base_url as a function returning different URLs per kind', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(typeof entry.base_url).toBe('function');
    const baseUrlFn = entry.base_url as (kind: 'code' | 'nlp') => string;
    expect(baseUrlFn('code')).toBe('http://127.0.0.1:11437/v1');
    expect(baseUrlFn('nlp')).toBe('http://127.0.0.1:11438/v1');
  });

  it('should have env_key as null (no API key required)', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(entry.env_key).toBeNull();
  });

  it('should be openai-compatible', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(entry.type).toBe('openai-compatible');
  });

  it('should have max_per_call=16 and supports_parallel=false', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(entry.max_per_call).toBe(16);
    expect(entry.supports_parallel).toBe(false);
  });

  it('should have correct default models', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(entry.default_code_model).toBe('nomic-embed-code');
    expect(entry.default_nlp_model).toBe('qwen3-embedding-8b');
  });

  it('should have a pre_hook function', () => {
    const entry = KNOWN_EMBEDDING_PROVIDERS['anatoly-local'];
    expect(entry.pre_hook).toBeDefined();
    expect(typeof entry.pre_hook).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC: resolveEmbeddingProvider — known provider resolution
// ---------------------------------------------------------------------------

describe('resolveEmbeddingProvider', () => {
  it('should return registry entry for a known provider with no config overrides', () => {
    const result = resolveEmbeddingProvider('openai', {});
    expect(result.type).toBe('native');
    expect(result.env_key).toBe('OPENAI_API_KEY');
    expect(result.base_url).toBeNull();
    expect(result.default_code_model).toBe('text-embedding-3-large');
  });

  it('should merge config overrides with registry defaults (config wins)', () => {
    const result = resolveEmbeddingProvider('voyage', {
      base_url: 'https://custom-voyage.example.com/v1',
      env_key: 'MY_VOYAGE_KEY',
    });
    expect(result.base_url).toBe('https://custom-voyage.example.com/v1');
    expect(result.env_key).toBe('MY_VOYAGE_KEY');
    expect(result.type).toBe('openai-compatible');
    expect(result.default_code_model).toBe('voyage-code-3');
  });

  it('should treat unknown provider with base_url as openai-compatible', () => {
    const result = resolveEmbeddingProvider('my-custom-embed', {
      base_url: 'https://embed.example.com/v1',
      env_key: 'MY_EMBED_KEY',
    });
    expect(result.type).toBe('openai-compatible');
    expect(result.base_url).toBe('https://embed.example.com/v1');
    expect(result.env_key).toBe('MY_EMBED_KEY');
  });

  it('should derive env_key for unknown provider without explicit env_key', () => {
    const result = resolveEmbeddingProvider('my-custom-embed', {
      base_url: 'https://embed.example.com/v1',
    });
    expect(result.env_key).toBe('MY_CUSTOM_EMBED_API_KEY');
  });

  it('should throw for unknown provider without base_url', () => {
    expect(() => resolveEmbeddingProvider('unknown-embed', {})).toThrow(
      'Unknown embedding provider "unknown-embed" — add base_url in .anatoly.yml',
    );
  });

  it('should throw for unknown provider with only env_key but no base_url', () => {
    expect(() => resolveEmbeddingProvider('unknown-embed', { env_key: 'SOME_KEY' })).toThrow(
      'Unknown embedding provider "unknown-embed" — add base_url in .anatoly.yml',
    );
  });
});

// ---------------------------------------------------------------------------
// findExternalConfigIssues — runtime guard for the external embedding tier
// ---------------------------------------------------------------------------

describe('findExternalConfigIssues', () => {
  const PROVIDER_KEYS = ['MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'HF_INTERNAL_TOKEN'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('flags the missing embedding section when nothing is configured', () => {
    const issues = findExternalConfigIssues(undefined);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('missing-section');
    expect(issues[0]!.message).toContain('rag.embedding');
  });

  it('flags an empty embedding section the same way (both axes missing)', () => {
    const issues = findExternalConfigIssues({});
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('missing-section');
  });

  it('flags an axis that is configured but with empty provider/model', () => {
    process.env.MISTRAL_API_KEY = 'present';
    process.env.OPENROUTER_API_KEY = 'present';
    const issues = findExternalConfigIssues({
      code: { provider: '', model: '' },
      nlp: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
    });
    const codeProvider = issues.find((i) => i.message.includes('code.provider'));
    const codeModel = issues.find((i) => i.message.includes('code.model'));
    expect(codeProvider?.kind).toBe('empty-field');
    expect(codeModel?.kind).toBe('empty-field');
  });

  it('flags missing env vars resolved from the registry default', () => {
    const issues = findExternalConfigIssues({
      code: { provider: 'mistral', model: 'mistral-embed' },
      nlp: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
    });
    expect(issues.find((i) => i.message.includes('MISTRAL_API_KEY'))?.kind).toBe('missing-env');
    expect(issues.find((i) => i.message.includes('OPENROUTER_API_KEY'))?.kind).toBe('missing-env');
  });

  it('returns [] when reference combo is fully ready', () => {
    process.env.MISTRAL_API_KEY = 'present';
    process.env.OPENROUTER_API_KEY = 'present';
    const issues = findExternalConfigIssues({
      code: { provider: 'mistral', model: 'mistral-embed' },
      nlp: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
    });
    expect(issues).toEqual([]);
  });

  it('honours an explicit env_key override on the axis (custom provider case)', () => {
    process.env.HF_INTERNAL_TOKEN = 'present';
    const issues = findExternalConfigIssues({
      code: { provider: 'hf-internal', model: 'nomic-embed-code', env_key: 'HF_INTERNAL_TOKEN' },
      nlp: { provider: 'hf-internal', model: 'nomic-embed-code', env_key: 'HF_INTERNAL_TOKEN' },
    });
    expect(issues).toEqual([]);
  });
});
