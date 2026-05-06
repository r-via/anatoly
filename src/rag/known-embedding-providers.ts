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
   * - `string` for fixed-URL providers (voyage, openrouter, cohere, mistral).
   * - `(kind) => string` for providers with per-axis URLs (local-advanced).
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
  openrouter: {
    // OpenRouter is the canonical aggregator route for Qwen3-Embedding-8B
    // (dim 4096, parity with the local advanced GGUF tier). Empirically
    // verified 2026-05-04: response is OpenAI-strict, batch ordering preserved,
    // pricing ~$0.01/1M tokens. Reuses the same base_url + env_key as the LLM
    // KNOWN_PROVIDERS.openrouter entry from Epic 43.
    base_url: 'https://openrouter.ai/api/v1',
    env_key: 'OPENROUTER_API_KEY',
    type: 'openai-compatible',
    default_code_model: 'qwen/qwen3-embedding-8b',
    default_nlp_model: 'qwen/qwen3-embedding-8b',
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
  'local-advanced': {
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
    // Trust the YAML: if no env_key was declared, the provider needs no key
    // (e.g. system-local sidecar with auth: none). The schema enforces the
    // env_key/auth correspondence — no fallback synthesis here.
    env_key: configOverrides.env_key ?? null,
    default_code_model: '',
    default_nlp_model: '',
  };
}

/**
 * One reason an external embedding setup is not ready to run. Used to drive
 * a single actionable error message at the top of `anatoly run`.
 */
export interface ExternalConfigIssue {
  /** Discriminator for callers that want to format issues differently. */
  kind: 'missing-section' | 'missing-axis' | 'empty-field' | 'missing-env';
  /** Human-readable description, embedded as-is in the run-blocking notice. */
  message: string;
}

/**
 * Validate a `rag.embedding` block for the external backend, surfacing every
 * reason it isn't ready to run: section missing entirely, an axis missing,
 * an empty `provider`/`model`, or a required API-key env var absent from
 * `process.env`. The first-run wizard writes a commented reference block;
 * this helper is what halts the run until the user uncomments + fills it
 * in and exports the keys in `.env`.
 *
 * Returns `[]` when the block is fully ready.
 */
export function findExternalConfigIssues(
  embedding: {
    code?: { provider?: string; model?: string; env_key?: string };
    nlp?: { provider?: string; model?: string; env_key?: string };
  } | undefined,
): ExternalConfigIssue[] {
  if (!embedding || (!embedding.code && !embedding.nlp)) {
    return [{
      kind: 'missing-section',
      message:
        '`rag.embedding` is missing — uncomment the reference block in ' +
        '.anatoly.yml (Mistral + OpenRouter Qwen3) or write your own.',
    }];
  }

  const issues: ExternalConfigIssue[] = [];
  for (const axis of ['code', 'nlp'] as const) {
    const cfg = embedding[axis];
    if (!cfg) {
      issues.push({
        kind: 'missing-axis',
        message: `\`rag.embedding.${axis}\` is missing — both code and nlp axes must be configured.`,
      });
      continue;
    }
    if (!cfg.provider) {
      issues.push({
        kind: 'empty-field',
        message: `\`rag.embedding.${axis}.provider\` is empty — set it to mistral / openrouter / voyage / openai / cohere / <custom>.`,
      });
    }
    if (!cfg.model) {
      issues.push({
        kind: 'empty-field',
        message: `\`rag.embedding.${axis}.model\` is empty — pick a model name supported by the provider.`,
      });
    }
    if (!cfg.provider) continue; // can't resolve env_key without a provider

    const envKey = cfg.env_key ?? KNOWN_EMBEDDING_PROVIDERS[cfg.provider]?.env_key ?? null;
    if (envKey && !process.env[envKey]) {
      issues.push({
        kind: 'missing-env',
        message: `${envKey} is missing — add it to the project \`.env\` file (auto-loaded by Anatoly).`,
      });
    }
  }
  return issues;
}
