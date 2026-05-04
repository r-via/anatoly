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
 * @param inputTokens - Number of input/prompt tokens.
 * @param outputTokens - Number of output/completion tokens.
 * @param projectRoot - Optional override for the project root. Defaults to
 *   `process.cwd()`, which is correct for the standard run path; pass an
 *   explicit root from worktree-aware contexts.
 * @returns Cost in USD, or 0 if pricing cannot be resolved (no cache, model
 *   not in registry, or network failure on first run).
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  projectRoot?: string,
): number {
  const pricing = lookupPrice(modelId, projectRoot);
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
