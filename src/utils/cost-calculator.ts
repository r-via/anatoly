// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralized LLM cost calculator.
 *
 * Pricing is per 1M tokens (USD). Consolidated from the former per-transport
 * pricing tables (GEMINI_PRICING, etc.) into a single registry.
 */

export interface ModelPricing {
  /** Cost per 1M input tokens (USD). */
  readonly input: number;
  /** Cost per 1M output tokens (USD). */
  readonly output: number;
}

/**
 * Static pricing table for known models.
 * Sources: provider pricing pages as of 2025-06.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // --- Gemini (Google) ---
  'gemini-2.5-flash-lite':  { input: 0.075,  output: 0.30 },
  'gemini-2.5-flash':       { input: 0.15,   output: 0.60 },
  'gemini-2.5-pro':         { input: 1.25,   output: 10.00 },
  'gemini-3-flash-preview': { input: 0.15,   output: 0.60 },

  // --- Anthropic ---
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00 },
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },

  // --- OpenAI ---
  'gpt-4o':      { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1':     { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
};

/**
 * Calculate the cost of an LLM call in USD.
 *
 * @param modelId - Model identifier (may be prefixed like `anthropic/claude-sonnet-4-6`)
 * @param inputTokens - Number of input/prompt tokens
 * @param outputTokens - Number of output/completion tokens
 * @returns Cost in USD, or 0 if the model is not in the pricing table
 */
export function calculateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  // Strip provider prefix if present (e.g. "google/gemini-2.5-flash" → "gemini-2.5-flash")
  const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  const pricing = MODEL_PRICING[bareModel];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
