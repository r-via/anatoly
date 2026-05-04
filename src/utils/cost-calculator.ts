// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralized LLM cost calculator.
 *
 * Pricing now flows from the runtime registry maintained by `pricing-cache`
 * (sourced from litellm + OpenRouter). The lookup is synchronous because
 * the registry is hydrated lazily from `.anatoly/pricing.json` on first use,
 * and the populating fetch happens once per run via `ensurePricing()`.
 */

import { lookupPrice, type ModelPricing } from './pricing-cache.js';

export type { ModelPricing };

/**
 * Calculate the cost of an LLM call in USD.
 *
 * @param modelId - Model identifier as passed to the transport (may be
 *   prefixed like `anthropic/claude-sonnet-4-6` or `openrouter/qwen/...`).
 * @param inputTokens - Number of *new* (uncached) input tokens. For Anthropic
 *   prompt caching this is the count returned by the SDK in `inputTokens`,
 *   which excludes both `cacheReadInputTokens` and `cacheCreationInputTokens`.
 * @param outputTokens - Number of output/completion tokens.
 * @param projectRoot - Optional override for the project root. Defaults to
 *   `process.cwd()`, which is correct for the standard run path; pass an
 *   explicit root from worktree-aware contexts.
 * @param cacheTokens - Optional cache-token counts. When the model has cache
 *   rates in the registry (typically Anthropic via litellm), they are applied;
 *   otherwise the input rate is used as a conservative fallback so the cache
 *   contribution isn't silently dropped.
 * @returns Cost in USD, or 0 if pricing cannot be resolved (no cache, model
 *   not in registry, or network failure on first run).
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  projectRoot?: string,
  cacheTokens?: { read?: number; creation?: number },
): number {
  const pricing = lookupPrice(modelId, projectRoot);
  if (!pricing) return 0;

  const cacheRead = cacheTokens?.read ?? 0;
  const cacheCreation = cacheTokens?.creation ?? 0;
  const cacheReadRate = pricing.cacheReadInput ?? pricing.input;
  const cacheCreationRate = pricing.cacheCreationInput ?? pricing.input;

  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output +
    cacheRead * cacheReadRate +
    cacheCreation * cacheCreationRate
  ) / 1_000_000;
}
