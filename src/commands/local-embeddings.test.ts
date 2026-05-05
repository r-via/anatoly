// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { patchConfigToAdvanced } from './local-embeddings.js';

describe('patchConfigToAdvanced', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const path = join(dir, '.anatoly.yml');
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  function readConfig(): Record<string, unknown> {
    return yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as Record<string, unknown>;
  }

  it('replaces routing.embeddings with local-advanced refs', () => {
    writeConfig(`
version: 3
providers:
  local-lite:
    transport: onnxruntime_node
    models: [jinaai/jina-embeddings-v2-base-code]
routing:
  generation:
    quality: anthropic/claude-opus-4-7
  embeddings:
    code: local-lite/jinaai/jina-embeddings-v2-base-code
    text: local-lite/Xenova/all-MiniLM-L6-v2
`);

    patchConfigToAdvanced(dir);

    const doc = readConfig();
    const routing = doc.routing as { embeddings: { code: string; text: string }; generation: unknown };
    expect(routing.embeddings.code).toBe('local-advanced/nomic-embed-code-gguf');
    expect(routing.embeddings.text).toBe('local-advanced/qwen3-embedding-8b-gguf');
    // Generation routing is preserved.
    expect(routing.generation).toEqual({ quality: 'anthropic/claude-opus-4-7' });
  });

  it('adds local-advanced provider while keeping existing providers', () => {
    writeConfig(`
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    models: [claude-opus-4-7]
  local-lite:
    transport: onnxruntime_node
    models: [jinaai/jina-embeddings-v2-base-code]
routing:
  embeddings:
    code: local-lite/jinaai/jina-embeddings-v2-base-code
    text: local-lite/Xenova/all-MiniLM-L6-v2
`);

    patchConfigToAdvanced(dir);

    const doc = readConfig();
    const providers = doc.providers as Record<string, Record<string, unknown>>;
    // Anthropic + local-lite preserved, local-advanced added.
    expect(providers.anthropic).toBeDefined();
    expect(providers['local-lite']).toBeDefined();
    expect(providers['local-advanced']).toMatchObject({
      transport: 'openai_compatible',
      auth: 'api_key',
      env_key: 'ANATOLY_LOCAL_DUMMY_KEY',
      base_url: 'http://localhost:8082/v1',
    });
    expect(providers['local-advanced']!.models).toEqual([
      'nomic-embed-code-gguf',
      'qwen3-embedding-8b-gguf',
    ]);
  });

  it('overwrites an existing external embedding setup (mistral/openrouter)', () => {
    writeConfig(`
version: 3
providers:
  mistral:
    transport: openai_compatible
    auth: api_key
    env_key: MISTRAL_API_KEY
    models: [mistral-embed]
  openrouter:
    transport: openai_compatible
    auth: api_key
    env_key: OPENROUTER_API_KEY
    models: [qwen/qwen3-embedding-8b]
routing:
  embeddings:
    code: mistral/mistral-embed
    text: openrouter/qwen/qwen3-embedding-8b
`);

    patchConfigToAdvanced(dir);

    const doc = readConfig();
    const routing = doc.routing as { embeddings: { code: string; text: string } };
    // Routing now points at local-advanced — external providers may still be
    // present in `providers`, but routing no longer references them.
    expect(routing.embeddings.code).toBe('local-advanced/nomic-embed-code-gguf');
    expect(routing.embeddings.text).toBe('local-advanced/qwen3-embedding-8b-gguf');
  });

  it('is idempotent — running twice yields the same config', () => {
    writeConfig(`
version: 3
providers: {}
routing: {}
`);

    patchConfigToAdvanced(dir);
    const first = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    patchConfigToAdvanced(dir);
    const second = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(second).toBe(first);
  });

  it('preserves unrelated top-level sections', () => {
    writeConfig(`
version: 3
project:
  name: my-project
scan:
  include: ['src/**/*.ts']
providers:
  local-lite:
    transport: onnxruntime_node
    models: [foo]
routing:
  embeddings:
    code: local-lite/foo
    text: local-lite/foo
runtime:
  concurrency: 8
`);

    patchConfigToAdvanced(dir);

    const doc = readConfig();
    expect(doc.project).toEqual({ name: 'my-project' });
    expect(doc.scan).toEqual({ include: ['src/**/*.ts'] });
    expect(doc.runtime).toEqual({ concurrency: 8 });
    expect(doc.version).toBe(3);
  });
});
