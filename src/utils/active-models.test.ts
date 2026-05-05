// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../schemas/config.js';
import { enumerateActiveModels } from './active-models.js';

describe('enumerateActiveModels', () => {
  it('returns the three default tier models when no overrides are set', () => {
    const config = ConfigSchema.parse({});
    const models = enumerateActiveModels(config);
    // Defaults from DEFAULT_MODELS
    expect(models).toContain('anthropic/claude-sonnet-4-6');
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('deduplicates identical model ids across sources', () => {
    const config = ConfigSchema.parse({
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-sonnet-4-6',
        deliberation: 'anthropic/claude-sonnet-4-6',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models.filter((m) => m === 'anthropic/claude-sonnet-4-6')).toHaveLength(1);
  });

  it('includes axis-level model overrides', () => {
    const config = ConfigSchema.parse({
      axes: {
        utility: { enabled: true, model: 'google/gemini-2.5-flash-lite' },
        duplication: { enabled: true, model: 'google/gemini-2.5-flash' },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('google/gemini-2.5-flash-lite');
    expect(models).toContain('google/gemini-2.5-flash');
  });

  it('includes optional models.code_summary', () => {
    const config = ConfigSchema.parse({
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        code_summary: 'google/gemini-2.5-flash-lite',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('google/gemini-2.5-flash-lite');
  });

  it('includes optional agents overrides', () => {
    const config = ConfigSchema.parse({
      agents: {
        enabled: true,
        scaffolding: 'anthropic/claude-haiku-4-5-20251001',
        review: 'google/gemini-2.5-pro',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(models).toContain('google/gemini-2.5-pro');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('includes embedding code/nlp model when configured', () => {
    const config = ConfigSchema.parse({
      rag: {
        enabled: true,
        code_model: 'auto',
        nlp_model: 'auto',
        code_weight: 0.6,
        embedding: {
          code: { provider: 'voyage', model: 'voyage-code-3' },
          nlp: { provider: 'openai', model: 'text-embedding-3-large' },
        },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('voyage-code-3');
    expect(models).toContain('text-embedding-3-large');
  });

  it('skips embedding entries without an explicit model', () => {
    const config = ConfigSchema.parse({
      rag: {
        enabled: true,
        code_model: 'auto',
        nlp_model: 'auto',
        code_weight: 0.6,
        embedding: {
          code: { provider: 'voyage' }, // no model
        },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models.find((m) => m.includes('voyage'))).toBeUndefined();
  });

  it('returns a stable sorted order so callers can hash it deterministically', () => {
    const config = ConfigSchema.parse({});
    const a = enumerateActiveModels(config);
    const b = enumerateActiveModels(config);
    expect(a).toEqual(b);
    // sorted ascending
    expect([...a].sort()).toEqual(a);
  });

  it('drops embedding models when enableRag is false', () => {
    const config = ConfigSchema.parse({
      rag: {
        enabled: true,
        code_model: 'auto',
        nlp_model: 'auto',
        code_weight: 0.6,
        embedding: {
          code: { provider: 'voyage', model: 'voyage-code-3' },
          nlp: { provider: 'openai', model: 'text-embedding-3-large' },
        },
      },
    });
    const models = enumerateActiveModels(config, { enableRag: false });
    expect(models).not.toContain('voyage-code-3');
    expect(models).not.toContain('text-embedding-3-large');
  });

  it('drops the deliberation tier when enableDeliberation is false', () => {
    const config = ConfigSchema.parse({
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
      },
      agents: {
        enabled: true,
        deliberation: 'google/gemini-2.5-pro',
      },
    });
    const models = enumerateActiveModels(config, { enableDeliberation: false });
    expect(models).not.toContain('anthropic/claude-opus-4-6');
    expect(models).not.toContain('google/gemini-2.5-pro');
    // Quality + fast tiers still present
    expect(models).toContain('anthropic/claude-sonnet-4-6');
  });

  it('restricts axis-model collection to the listed axesFilter', () => {
    const config = ConfigSchema.parse({
      axes: {
        utility: { enabled: true, model: 'google/gemini-2.5-flash-lite' },
        duplication: { enabled: true, model: 'google/gemini-2.5-flash' },
        tests: { enabled: true, model: 'anthropic/claude-haiku-4-5-20251001' },
      },
    });
    const models = enumerateActiveModels(config, { axesFilter: ['utility', 'tests'] });
    expect(models).toContain('google/gemini-2.5-flash-lite');
    expect(models).not.toContain('google/gemini-2.5-flash');
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// v3 path — exercised when the config carries a getV3Source() result
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config-loader.js';

describe('enumerateActiveModels — v3 path', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-active-models-v3-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function loadV3(yml: string): ReturnType<typeof loadConfig> {
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    return loadConfig(tempDir);
  }

  const baseV3 = `
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    models:
      - claude-sonnet-4-6
      - claude-haiku-4-5-20251001
      - claude-opus-4-6
  mistral:
    transport: openai_compatible
    auth: api_key
    env_key: MISTRAL_API_KEY
    models:
      - mistral-embed
  openrouter:
    transport: openai_compatible
    auth: api_key
    env_key: OPENROUTER_API_KEY
    models:
      - qwen/qwen3-embedding-8b
routing:
  generation:
    quality: anthropic/claude-sonnet-4-6
    fast: anthropic/claude-haiku-4-5-20251001
    deliberation: anthropic/claude-opus-4-6
    summarization: anthropic/claude-haiku-4-5-20251001
  embeddings:
    code: mistral/mistral-embed
    text: openrouter/qwen/qwen3-embedding-8b
`;

  it('returns generation slots, embeddings, and dedupes', () => {
    const config = loadV3(baseV3);
    const models = enumerateActiveModels(config);
    expect(models).toContain('anthropic/claude-sonnet-4-6');
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(models).toContain('anthropic/claude-opus-4-6');
    expect(models).toContain('mistral/mistral-embed');
    expect(models).toContain('openrouter/qwen/qwen3-embedding-8b');
    // Haiku appears in both fast and summarization — should be deduped.
    expect(models.filter((m) => m === 'anthropic/claude-haiku-4-5-20251001')).toHaveLength(1);
  });

  it('drops deliberation when enableDeliberation: false', () => {
    const config = loadV3(baseV3);
    const models = enumerateActiveModels(config, { enableDeliberation: false });
    expect(models).not.toContain('anthropic/claude-opus-4-6');
  });

  it('drops embedding refs when enableRag: false', () => {
    const config = loadV3(baseV3);
    const models = enumerateActiveModels(config, { enableRag: false });
    expect(models).not.toContain('mistral/mistral-embed');
    expect(models).not.toContain('openrouter/qwen/qwen3-embedding-8b');
  });

  it('excludes ONNX providers from embeddings (no pricing entry)', () => {
    const config = loadV3(`
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    models: [claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6]
  'local-lite':
    transport: onnxruntime_node
    models: [jinaai/jina-embeddings-v2-base-code, Xenova/all-MiniLM-L6-v2]
routing:
  generation:
    quality: anthropic/claude-sonnet-4-6
    fast: anthropic/claude-haiku-4-5
    deliberation: anthropic/claude-opus-4-6
    summarization: anthropic/claude-haiku-4-5
  embeddings:
    code: local-lite/jinaai/jina-embeddings-v2-base-code
    text: local-lite/Xenova/all-MiniLM-L6-v2
`);
    const models = enumerateActiveModels(config);
    expect(models).not.toContain('local-lite/jinaai/jina-embeddings-v2-base-code');
    expect(models).not.toContain('local-lite/Xenova/all-MiniLM-L6-v2');
    expect(models).toContain('anthropic/claude-sonnet-4-6');
  });

  it('includes per-axis model overrides when axes are in object form', () => {
    const config = loadV3(`${baseV3.trimEnd()}
evaluation:
  axes:
    correction:
      enabled: true
      model: anthropic/claude-opus-4-6
`);
    const models = enumerateActiveModels(config);
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('respects axesFilter for object-form overrides', () => {
    const config = loadV3(`${baseV3.trimEnd()}
evaluation:
  axes:
    correction:
      enabled: true
      model: anthropic/claude-opus-4-6
    tests:
      enabled: true
      model: anthropic/claude-haiku-4-5-20251001
`);
    const models = enumerateActiveModels(config, { axesFilter: ['correction'] });
    expect(models).toContain('anthropic/claude-opus-4-6');
    // tests override is filtered out — but haiku stays via routing.fast/summarization
    expect(models.filter((m) => m === 'anthropic/claude-haiku-4-5-20251001')).toHaveLength(1);
  });

  it('returns sorted results', () => {
    const config = loadV3(baseV3);
    const models = enumerateActiveModels(config);
    const sorted = [...models].sort();
    expect(models).toEqual(sorted);
  });
});
