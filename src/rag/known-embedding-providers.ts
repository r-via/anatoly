// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralized registry of known embedding providers.
 *
 * Adding a new embedding provider requires a single entry here —
 * no new transport file needed. The registry provides default URLs,
 * env vars, batch constraints, and optional lifecycle hooks.
 */

import { ensureModel } from './docker-gguf.js';

/** Shape of a known embedding provider entry. */
export interface KnownEmbeddingProviderEntry {
  /**
   * Base URL for the embedding API.
   * - `null` for native SDK providers (openai).
   * - `string` for fixed-URL providers (voyage, qwen, cohere, mistral).
   * - `(kind) => string` for providers with per-axis URLs (anatoly-local).
   */
  readonly base_url: string | null | ((kind: 'code' | 'nlp') => string);
  /** Environment variable name holding the API key. `null` if no key required. */
  readonly env_key: string | null;
  /** Transport strategy: `native` uses a dedicated SDK, `openai-compatible` uses createOpenAICompatible. */
  readonly type: 'native' | 'openai-compatible';
  /** Max embeddings per SDK call. Absent = SDK default (typically 2048). */
  readonly max_per_call?: number;
  /** Whether the provider supports parallel embedding requests. Absent = true. */
  readonly supports_parallel?: boolean;
  /** Default code embedding model for this provider. */
  readonly default_code_model: string;
  /** Default NLP embedding model for this provider. */
  readonly default_nlp_model: string;
  /** Optional lifecycle hook called before each embed call (e.g. hot-swap Docker model). */
  readonly pre_hook?: (kind: 'code' | 'nlp') => Promise<void>;
}

export const KNOWN_EMBEDDING_PROVIDERS: Readonly<Record<string, KnownEmbeddingProviderEntry>> = {
  openai: {
    base_url: null,
    env_key: 'OPENAI_API_KEY',
    type: 'native',
    default_code_model: 'text-embedding-3-large',
    default_nlp_model: 'text-embedding-3-large',
  },
  voyage: {
    base_url: 'https://api.voyageai.com/v1',
    env_key: 'VOYAGE_API_KEY',
    type: 'openai-compatible',
    default_code_model: 'voyage-code-3',
    default_nlp_model: 'voyage-3-large',
  },
  qwen: {
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    env_key: 'DASHSCOPE_API_KEY',
    type: 'openai-compatible',
    default_code_model: 'text-embedding-v4',
    default_nlp_model: 'text-embedding-v4',
  },
  cohere: {
    base_url: 'https://api.cohere.com/v1',
    env_key: 'COHERE_API_KEY',
    type: 'openai-compatible',
    default_code_model: 'embed-english-v3.0',
    default_nlp_model: 'embed-english-v3.0',
  },
  mistral: {
    base_url: 'https://api.mistral.ai/v1',
    env_key: 'MISTRAL_API_KEY',
    type: 'openai-compatible',
    default_code_model: 'mistral-embed',
    default_nlp_model: 'mistral-embed',
  },
  'anatoly-local': {
    base_url: (kind: 'code' | 'nlp') =>
      kind === 'code' ? 'http://127.0.0.1:11437/v1' : 'http://127.0.0.1:11438/v1',
    env_key: null,
    type: 'openai-compatible',
    max_per_call: 16,
    supports_parallel: false,
    default_code_model: 'nomic-embed-code',
    default_nlp_model: 'qwen3-embedding-8b',
    pre_hook: async (kind: 'code' | 'nlp') => ensureModel(kind),
  },
};

/**
 * Resolve the effective embedding provider configuration by merging registry
 * defaults with user-provided config overrides.
 *
 * @param providerId - Provider name (e.g. 'openai', 'voyage', 'my-custom-embed')
 * @param configOverrides - Optional overrides from .anatoly.yml embedding section
 * @returns Resolved provider entry with config overrides applied
 * @throws If the provider is unknown and no base_url is provided in config
 */
export function resolveEmbeddingProvider(
  providerId: string,
  configOverrides: { base_url?: string; env_key?: string },
): KnownEmbeddingProviderEntry {
  const known = KNOWN_EMBEDDING_PROVIDERS[providerId];

  if (known) {
    return {
      ...known,
      base_url: configOverrides.base_url ?? known.base_url,
      env_key: configOverrides.env_key ?? known.env_key,
    };
  }

  // Unknown provider — must have base_url from config
  if (!configOverrides.base_url) {
    throw new Error(
      `Unknown embedding provider "${providerId}" — add base_url in .anatoly.yml`,
    );
  }

  return {
    type: 'openai-compatible',
    base_url: configOverrides.base_url,
    env_key: configOverrides.env_key ?? `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`,
    default_code_model: '',
    default_nlp_model: '',
  };
}
