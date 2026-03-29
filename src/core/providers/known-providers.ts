// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralized registry of known LLM providers.
 *
 * Each entry provides default base_url, env_key, and transport type so that
 * users only need to specify the provider name in .anatoly.yml — no manual
 * URL or env var lookup required.
 */

export interface KnownProviderEntry {
  /** Base URL for the API. `null` for native SDK providers (anthropic, google, openai). */
  readonly base_url: string | null;
  /** Environment variable name holding the API key. */
  readonly env_key: string;
  /** Transport strategy: `native` uses a dedicated SDK, `openai-compatible` uses createOpenAICompatible. */
  readonly type: 'native' | 'openai-compatible';
}

export const KNOWN_PROVIDERS: Readonly<Record<string, KnownProviderEntry>> = {
  anthropic: {
    base_url: null,
    env_key: 'ANTHROPIC_API_KEY',
    type: 'native',
  },
  google: {
    base_url: null,
    env_key: 'GOOGLE_API_KEY',
    type: 'native',
  },
  openai: {
    base_url: null,
    env_key: 'OPENAI_API_KEY',
    type: 'native',
  },
  qwen: {
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    env_key: 'DASHSCOPE_API_KEY',
    type: 'openai-compatible',
  },
  groq: {
    base_url: 'https://api.groq.com/openai/v1',
    env_key: 'GROQ_API_KEY',
    type: 'openai-compatible',
  },
  deepseek: {
    base_url: 'https://api.deepseek.com/v1',
    env_key: 'DEEPSEEK_API_KEY',
    type: 'openai-compatible',
  },
  mistral: {
    base_url: 'https://api.mistral.ai/v1',
    env_key: 'MISTRAL_API_KEY',
    type: 'openai-compatible',
  },
  openrouter: {
    base_url: 'https://openrouter.ai/api/v1',
    env_key: 'OPENROUTER_API_KEY',
    type: 'openai-compatible',
  },
  ollama: {
    base_url: 'http://localhost:11434/v1',
    env_key: 'OLLAMA_API_KEY',
    type: 'openai-compatible',
  },
};

/**
 * Resolve the effective provider configuration by merging registry defaults
 * with user-provided config overrides.
 *
 * @param providerId - The provider name (e.g. 'anthropic', 'groq', 'my-custom-llm')
 * @param configOverrides - Optional overrides from the user's .anatoly.yml
 * @returns Resolved provider entry with config overrides applied
 * @throws If the provider is unknown and no base_url is provided in config
 */
export function resolveProvider(
  providerId: string,
  configOverrides: { base_url?: string; env_key?: string },
): KnownProviderEntry {
  const known = KNOWN_PROVIDERS[providerId];

  if (known) {
    return {
      type: known.type,
      base_url: configOverrides.base_url ?? known.base_url,
      env_key: configOverrides.env_key ?? known.env_key,
    };
  }

  // Unknown provider — must have base_url from config
  if (!configOverrides.base_url) {
    throw new Error(
      `Unknown provider "${providerId}" — add base_url in .anatoly.yml`,
    );
  }

  return {
    type: 'openai-compatible',
    base_url: configOverrides.base_url,
    env_key: configOverrides.env_key ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`,
  };
}
