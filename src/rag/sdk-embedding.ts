// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Unified factory for Vercel AI SDK embedding models.
 *
 * Returns an `EmbeddingModelV3` for any known or custom embedding provider.
 * The call-site in `embeddings.ts` only sees a uniform API — all provider
 * routing is centralized here.
 */

import { createHash } from 'node:crypto';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { resolveEmbeddingProvider } from './known-embedding-providers.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import type { EmbeddingsReadyFlag } from './hardware-detect.js';
import type { EmbeddingModelV1 } from 'ai';

/** Minimal config shape needed to resolve an embedding provider. */
export interface EmbeddingModelConfig {
  provider: string;
  model?: string;
  base_url?: string;
  env_key?: string;
}

/**
 * Create a Vercel AI SDK embedding model for the given provider and model.
 *
 * - For `type: 'native'` + `provider === 'openai'` → uses `@ai-sdk/openai`
 * - For `type: 'openai-compatible'` → uses `@ai-sdk/openai-compatible`
 * - If the provider has a `pre_hook`, the returned model wraps the SDK model
 *   so that `doEmbed` calls `pre_hook(kind)` before each embedding.
 *
 * @param kind - 'code' or 'nlp' (used to resolve per-axis URLs and hooks)
 * @param modelId - The embedding model identifier (e.g. 'text-embedding-3-large')
 * @param config - Provider configuration from .anatoly.yml embedding section
 * @throws AnatolyError if a required API key is missing
 */
export function getVercelEmbeddingModel(
  kind: 'code' | 'nlp',
  modelId: string,
  config: EmbeddingModelConfig,
): EmbeddingModelV1<string> {
  const resolved = resolveEmbeddingProvider(config.provider, {
    base_url: config.base_url,
    env_key: config.env_key,
  });

  // Resolve API key
  const envKey = resolved.env_key;
  const apiKey = envKey ? process.env[envKey] : null;

  if (envKey && !apiKey) {
    throw new AnatolyError(
      `No API key for embedding provider "${config.provider}". Set ${envKey} in your environment.`,
      ERROR_CODES.PROVIDER_AUTH_FAILED,
      false,
    );
  }

  // Resolve base URL (may be a function for anatoly-local)
  const baseUrl = typeof resolved.base_url === 'function'
    ? resolved.base_url(kind)
    : resolved.base_url;

  let sdkModel: EmbeddingModelV1<string>;

  if (resolved.type === 'native' && config.provider === 'openai') {
    sdkModel = openai.textEmbeddingModel(modelId);
  } else {
    const provider = createOpenAICompatible({
      baseURL: baseUrl!,
      name: config.provider,
      apiKey: apiKey ?? '',
    });
    sdkModel = provider.textEmbeddingModel(modelId);
  }

  // Wrap with pre_hook if the provider defines one
  if (resolved.pre_hook) {
    const hook = resolved.pre_hook;
    return wrapWithPreHook(sdkModel, kind, hook);
  }

  return sdkModel;
}

/**
 * Wrap an SDK embedding model so that `doEmbed` executes a pre-hook
 * before delegating to the underlying model.
 */
function wrapWithPreHook(
  inner: EmbeddingModelV1<string>,
  kind: 'code' | 'nlp',
  hook: (kind: 'code' | 'nlp') => Promise<void>,
): EmbeddingModelV1<string> {
  return {
    ...inner,
    // Override doEmbed to run the hook first
    doEmbed: async (params: Parameters<EmbeddingModelV1<string>['doEmbed']>[0]) => {
      await hook(kind);
      return inner.doEmbed(params);
    },
  };
}

// ---------------------------------------------------------------------------
// Embedding dimension probing
// ---------------------------------------------------------------------------

/**
 * Probe the output dimension of an embedding model by embedding a short test string.
 * Used when the model's dim is not in `MODEL_REGISTRY`.
 */
export async function probeEmbeddingDim(
  model: EmbeddingModelV1<string>,
  kind: 'code' | 'nlp',
): Promise<number> {
  const { embedding } = await embed({
    model,
    value: `anatoly probe ${kind}`,
  });
  return embedding.length;
}

// ---------------------------------------------------------------------------
// Embedding config signature
// ---------------------------------------------------------------------------

/**
 * Generate a short SHA256 hash (8 hex chars) that uniquely identifies the
 * current embedding configuration. Used to detect config changes that
 * require re-probing dimensions.
 */
export function getEmbeddingSignature(
  provider: string,
  codeModel: string,
  nlpModel: string,
): string {
  const input = `${provider}|${codeModel}|${nlpModel}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Cached dimension resolution
// ---------------------------------------------------------------------------

/** Context for ensureEmbeddingDims — injection points for testing. */
export interface EnsureDimsContext {
  readyFlag?: EmbeddingsReadyFlag | null;
  getCodeModel?: () => EmbeddingModelV1<string>;
  getNlpModel?: () => EmbeddingModelV1<string>;
  onLog?: (message: string) => void;
}

/** Minimal resolved shape needed for dim resolution. */
export interface ResolvedForDims {
  codeProvider: string;
  codeModel: string;
  nlpProvider: string;
  nlpModel: string;
  codeDim: number;
  nlpDim: number;
}

/**
 * Ensure embedding dimensions are resolved, either from a cached flag file
 * or by probing the models at runtime.
 *
 * When the `embedding_signature` in the flag matches the current config,
 * cached `dim_code`/`dim_nlp` are used (skip probe). Otherwise, the models
 * are probed and the returned dims reflect the actual model output.
 */
export async function ensureEmbeddingDims(
  resolved: ResolvedForDims,
  ctx: EnsureDimsContext,
): Promise<{ codeDim: number; nlpDim: number; signature: string }> {
  const sig = getEmbeddingSignature(
    resolved.codeProvider,
    resolved.codeModel,
    resolved.nlpModel,
  );

  // Check if cached dims match the current config signature
  const flag = ctx.readyFlag;
  if (
    flag &&
    (flag as any).embedding_signature === sig &&
    flag.dim_code != null &&
    flag.dim_nlp != null
  ) {
    return { codeDim: flag.dim_code, nlpDim: flag.dim_nlp, signature: sig };
  }

  // Need to probe — get SDK models from context
  const codeModel = ctx.getCodeModel?.();
  const nlpModel = ctx.getNlpModel?.();

  if (!codeModel || !nlpModel) {
    // If no model getters provided, return sentinel dims (caller must handle)
    return { codeDim: resolved.codeDim, nlpDim: resolved.nlpDim, signature: sig };
  }

  const codeDim = await probeEmbeddingDim(codeModel, 'code');
  const nlpDim = await probeEmbeddingDim(nlpModel, 'nlp');

  ctx.onLog?.(`embedding dims probed: code=${codeDim}, nlp=${nlpDim} (signature=${sig})`);

  return { codeDim, nlpDim, signature: sig };
}
