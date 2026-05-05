// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadConfig, getV3Source } from './config-loader.js';
import { AnatolyError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return defaults when no config file exists', () => {
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.scan.include).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(config.scan.exclude).toContain('node_modules/**');
    expect(config.coverage.enabled).toBe(true);
    expect(config.runtime.timeout_per_file).toBe(600);
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should accept a custom config path', () => {
    const customPath = join(tempDir, 'custom-config.yml');
    writeFileSync(customPath, 'project:\n  name: custom\n');
    const config = loadConfig(tempDir, customPath);
    expect(config.project.name).toBe('custom');
  });

  it('should return defaults for an empty YAML file', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '');
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should throw CONFIG_INVALID for malformed YAML', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '  bad:\n- yaml: [unclosed');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
      expect((err as AnatolyError).recoverable).toBe(false);
    }
  });

  it('should throw CONFIG_INVALID for invalid config values', () => {
    // runtime.timeout_per_file: 0 is invalid (min 1)
    writeFileSync(join(tempDir, '.anatoly.yml'), 'runtime:\n  timeout_per_file: 0\n');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
    }
  });

  it('should throw CONFIG_INVALID for non-object YAML content', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '"just a string"');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
  });

  it('should load v2-prefixed config without providers.google', () => {
    const yml = `
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
providers:
  anthropic:
    concurrency: 24
runtime:
  concurrency: 8
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.providers.google).toBeUndefined();
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.fast).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(config.providers.anthropic!.concurrency).toBe(24);
    expect(config.models.code_summary).toBeUndefined();
  });

  it('should load the project anatoly.yml without errors', () => {
    // Load from the actual project root
    const projectRoot = join(__dirname, '..', '..');
    const config = loadConfig(projectRoot);
    expect(config.providers.anthropic).toBeDefined();
    expect(config.models.quality).toContain('/');
  });

  it('should parse a v2-prefixed config with new sections directly', () => {
    const yml = `
models:
  quality: anthropic/claude-opus-4-6
  fast: anthropic/claude-haiku-4-5-20251001
providers:
  anthropic:
    concurrency: 16
  google:
    mode: api
    concurrency: 8
runtime:
  timeout_per_file: 300
  concurrency: 4
agents:
  enabled: true
  deliberation: anthropic/claude-opus-4-6
axes:
  correction:
    model: anthropic/claude-opus-4-6
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.models.quality).toBe('anthropic/claude-opus-4-6');
    expect(config.providers.anthropic!.concurrency).toBe(16);
    expect(config.providers.google?.mode).toBe('api');
    expect(config.providers.google?.concurrency).toBe(8);
    expect(config.runtime.timeout_per_file).toBe(300);
    expect(config.agents.deliberation).toBe('anthropic/claude-opus-4-6');
    expect(config.axes.correction?.model).toBe('anthropic/claude-opus-4-6');
  });
});

describe('loadConfig — embedding section (Story 50.1)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-embed-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load YAML with embedding.code only', () => {
    const yml = `
models:
  quality: anthropic/claude-sonnet-4-6
providers:
  anthropic:
    concurrency: 24
rag:
  embedding:
    code:
      provider: openai
      model: text-embedding-3-large
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.rag.embedding!.code!.provider).toBe('openai');
    expect(config.rag.embedding!.code!.model).toBe('text-embedding-3-large');
    expect(config.rag.embedding!.nlp).toBeUndefined();
  });

  it('should load YAML with best-of-breed embedding combo', () => {
    const yml = `
models:
  quality: anthropic/claude-sonnet-4-6
providers:
  anthropic:
    concurrency: 24
rag:
  embedding:
    code:
      provider: voyage
      model: voyage-code-3
    nlp:
      provider: qwen
      model: text-embedding-v4
      env_key: DASHSCOPE_API_KEY
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.rag.embedding!.code!.provider).toBe('voyage');
    expect(config.rag.embedding!.code!.model).toBe('voyage-code-3');
    expect(config.rag.embedding!.nlp!.provider).toBe('qwen');
    expect(config.rag.embedding!.nlp!.env_key).toBe('DASHSCOPE_API_KEY');
  });

  it('should load YAML without embedding section (backward compat)', () => {
    const yml = `
models:
  quality: anthropic/claude-sonnet-4-6
providers:
  anthropic:
    concurrency: 24
rag:
  code_model: auto
  nlp_model: auto
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.rag.embedding).toBeUndefined();
    expect(config.rag.code_model).toBe('auto');
    expect(config.rag.nlp_model).toBe('auto');
  });
});


// ---------------------------------------------------------------------------
// v3 config (declarative `version: 3` schema with providers/routing/...)
// ---------------------------------------------------------------------------

describe('loadConfig — v3 schema', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-v3-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeV3(yml: string): void {
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
  }

  const minimalV3Yaml = `
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    concurrency: 24
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

  it('loads a valid v3 YAML and returns a v2-shape Config', () => {
    writeV3(minimalV3Yaml);
    const config = loadConfig(tempDir);
    expect(config.providers.anthropic).toMatchObject({ mode: 'subscription' });
    expect(config.providers.mistral).toMatchObject({ mode: 'api', env_key: 'MISTRAL_API_KEY' });
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.code_summary).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(config.rag.embedding?.code).toMatchObject({
      provider: 'mistral',
      model: 'mistral-embed',
      env_key: 'MISTRAL_API_KEY',
    });
    expect(config.rag.embedding?.nlp).toMatchObject({
      provider: 'openrouter',
      model: 'qwen/qwen3-embedding-8b',
    });
  });

  it('falls through to v2 path when no version key is present', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), `
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
`);
    const config = loadConfig(tempDir);
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
  });

  it('rejects v3 with a missing provider in routing', () => {
    writeV3(`
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
    code: ghost/some-embed-model
    text: local-lite/Xenova/all-MiniLM-L6-v2
`);
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    expect(() => loadConfig(tempDir)).toThrow(/Invalid v3 configuration/);
    expect(() => loadConfig(tempDir)).toThrow(/provider "ghost" not declared/);
  });

  it('rejects v3 with a model not declared under its provider', () => {
    writeV3(`
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
    quality: anthropic/claude-undeclared
    fast: anthropic/claude-haiku-4-5
    deliberation: anthropic/claude-opus-4-6
    summarization: anthropic/claude-haiku-4-5
  embeddings:
    code: local-lite/jinaai/jina-embeddings-v2-base-code
    text: local-lite/Xenova/all-MiniLM-L6-v2
`);
    expect(() => loadConfig(tempDir)).toThrow(/model "claude-undeclared" not declared/);
  });

  it('rejects v3 with an embedding-incapable transport pointed at by routing.embeddings', () => {
    writeV3(`
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    models: [claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6]
routing:
  generation:
    quality: anthropic/claude-sonnet-4-6
    fast: anthropic/claude-haiku-4-5
    deliberation: anthropic/claude-opus-4-6
    summarization: anthropic/claude-haiku-4-5
  embeddings:
    code: anthropic/claude-sonnet-4-6
    text: anthropic/claude-haiku-4-5
`);
    expect(() => loadConfig(tempDir)).toThrow(/embedding-capable transport/);
  });

  it('routes a v3 ONNX-only embeddings config to rag.{code,nlp}_model', () => {
    writeV3(`
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
    const config = loadConfig(tempDir);
    expect(config.rag.code_model).toBe('jinaai/jina-embeddings-v2-base-code');
    expect(config.rag.nlp_model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(config.rag.embedding).toBeUndefined();
  });

  it('lifts evaluation.axes.documentation extras into top-level documentation', () => {
    writeV3(`
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
evaluation:
  axes:
    documentation:
      enabled: true
      docs_path: site/docs
      module_mapping:
        site/docs/auth.md:
          - src/auth/**/*.ts
`);
    const config = loadConfig(tempDir);
    expect(config.documentation.docs_path).toBe('site/docs');
    expect(config.documentation.module_mapping).toEqual({
      'site/docs/auth.md': ['src/auth/**/*.ts'],
    });
  });

  it('exposes the v3 source via getV3Source when the YAML is v3', () => {
    writeV3(minimalV3Yaml);
    const config = loadConfig(tempDir);
    const v3 = getV3Source(config);
    expect(v3).toBeDefined();
    expect(v3?.version).toBe(3);
    expect(v3?.providers.anthropic.models).toContain('claude-sonnet-4-6');
    expect(v3?.routing.embeddings.code).toBe('mistral/mistral-embed');
  });

  it('returns undefined from getV3Source for legacy (non-v3) YAML', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), `
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
`);
    const config = loadConfig(tempDir);
    expect(getV3Source(config)).toBeUndefined();
  });

  it('hides v3 source from Object.keys / JSON.stringify', () => {
    writeV3(minimalV3Yaml);
    const config = loadConfig(tempDir);
    const keys = Object.keys(config);
    expect(keys).not.toContain('v3Source');
    const json = JSON.stringify(config);
    expect(json).not.toContain('"version":3');  // v3 source not serialized
  });

  it('preserves runtime.agents.max_turns and runtime.rag.code_share', () => {
    writeV3(`
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
runtime:
  agents:
    max_turns: 75
  rag:
    code_share: 0.8
`);
    const config = loadConfig(tempDir);
    expect(config.agents.max_turns).toBe(75);
    expect(config.rag.code_weight).toBe(0.8);
  });
});
