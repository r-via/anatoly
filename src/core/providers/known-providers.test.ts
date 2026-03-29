// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  KNOWN_PROVIDERS,
  resolveProvider,
  type KnownProviderEntry,
} from './known-providers.js';

// --- AC: KNOWN_PROVIDERS registry contents ---

describe('KNOWN_PROVIDERS registry', () => {
  const expectedIds = [
    'anthropic',
    'google',
    'openai',
    'qwen',
    'groq',
    'deepseek',
    'mistral',
    'openrouter',
    'ollama',
  ];

  it('should contain all 9 expected provider entries', () => {
    for (const id of expectedIds) {
      expect(KNOWN_PROVIDERS).toHaveProperty(id);
    }
    expect(Object.keys(KNOWN_PROVIDERS)).toHaveLength(9);
  });

  it('should have base_url, env_key, and type on every entry', () => {
    for (const [id, entry] of Object.entries(KNOWN_PROVIDERS)) {
      expect(entry).toHaveProperty('base_url');
      expect(entry).toHaveProperty('env_key');
      expect(entry).toHaveProperty('type');
      expect(['native', 'openai-compatible']).toContain(entry.type);
      expect(typeof entry.env_key).toBe('string');
      // base_url is null for native, string for openai-compatible
      if (entry.type === 'native') {
        expect(entry.base_url).toBeNull();
      } else {
        expect(typeof entry.base_url).toBe('string');
      }
    }
  });

  it('should mark anthropic, google, openai as native', () => {
    expect(KNOWN_PROVIDERS.anthropic.type).toBe('native');
    expect(KNOWN_PROVIDERS.google.type).toBe('native');
    expect(KNOWN_PROVIDERS.openai.type).toBe('native');
  });

  it('should mark qwen, groq, deepseek, mistral, openrouter, ollama as openai-compatible', () => {
    expect(KNOWN_PROVIDERS.qwen.type).toBe('openai-compatible');
    expect(KNOWN_PROVIDERS.groq.type).toBe('openai-compatible');
    expect(KNOWN_PROVIDERS.deepseek.type).toBe('openai-compatible');
    expect(KNOWN_PROVIDERS.mistral.type).toBe('openai-compatible');
    expect(KNOWN_PROVIDERS.openrouter.type).toBe('openai-compatible');
    expect(KNOWN_PROVIDERS.ollama.type).toBe('openai-compatible');
  });

  it('should have correct env_key for each provider', () => {
    expect(KNOWN_PROVIDERS.anthropic.env_key).toBe('ANTHROPIC_API_KEY');
    expect(KNOWN_PROVIDERS.google.env_key).toBe('GOOGLE_API_KEY');
    expect(KNOWN_PROVIDERS.openai.env_key).toBe('OPENAI_API_KEY');
    expect(KNOWN_PROVIDERS.groq.env_key).toBe('GROQ_API_KEY');
    expect(KNOWN_PROVIDERS.deepseek.env_key).toBe('DEEPSEEK_API_KEY');
    expect(KNOWN_PROVIDERS.mistral.env_key).toBe('MISTRAL_API_KEY');
    expect(KNOWN_PROVIDERS.openrouter.env_key).toBe('OPENROUTER_API_KEY');
    expect(KNOWN_PROVIDERS.ollama.env_key).toBe('OLLAMA_API_KEY');
    expect(KNOWN_PROVIDERS.qwen.env_key).toBe('DASHSCOPE_API_KEY');
  });
});

// --- AC: resolveProvider — known provider resolution ---

describe('resolveProvider', () => {
  it('should return registry entry for a known provider with no config overrides', () => {
    const result = resolveProvider('anthropic', {});
    expect(result.type).toBe('native');
    expect(result.env_key).toBe('ANTHROPIC_API_KEY');
    expect(result.base_url).toBeNull();
  });

  it('should return registry entry for openai-compatible provider', () => {
    const result = resolveProvider('groq', {});
    expect(result.type).toBe('openai-compatible');
    expect(result.env_key).toBe('GROQ_API_KEY');
    expect(typeof result.base_url).toBe('string');
  });

  // --- AC: config YAML overrides take precedence ---

  it('should allow config to override base_url for a known provider', () => {
    const result = resolveProvider('anthropic', { base_url: 'https://custom-proxy.example.com' });
    expect(result.base_url).toBe('https://custom-proxy.example.com');
    expect(result.env_key).toBe('ANTHROPIC_API_KEY'); // env_key unchanged
  });

  it('should allow config to override env_key for a known provider', () => {
    const result = resolveProvider('groq', { env_key: 'MY_CUSTOM_GROQ_KEY' });
    expect(result.env_key).toBe('MY_CUSTOM_GROQ_KEY');
    expect(result.type).toBe('openai-compatible'); // type unchanged
  });

  it('should allow config to override both base_url and env_key', () => {
    const result = resolveProvider('openai', {
      base_url: 'https://proxy.example.com/v1',
      env_key: 'CUSTOM_OPENAI_KEY',
    });
    expect(result.base_url).toBe('https://proxy.example.com/v1');
    expect(result.env_key).toBe('CUSTOM_OPENAI_KEY');
    expect(result.type).toBe('native');
  });

  // --- AC: unknown provider with base_url → openai-compatible ---

  it('should treat unknown provider with base_url as openai-compatible', () => {
    const result = resolveProvider('my-custom-llm', {
      base_url: 'https://my-llm.example.com/v1',
      env_key: 'MY_LLM_KEY',
    });
    expect(result.type).toBe('openai-compatible');
    expect(result.base_url).toBe('https://my-llm.example.com/v1');
    expect(result.env_key).toBe('MY_LLM_KEY');
  });

  // --- AC: unknown provider without base_url → error ---

  it('should throw for unknown provider without base_url', () => {
    expect(() => resolveProvider('unknown-provider', {})).toThrow(
      'Unknown provider "unknown-provider" — add base_url in .anatoly.yml',
    );
  });

  it('should throw for unknown provider with only env_key but no base_url', () => {
    expect(() => resolveProvider('unknown-provider', { env_key: 'SOME_KEY' })).toThrow(
      'Unknown provider "unknown-provider" — add base_url in .anatoly.yml',
    );
  });
});
