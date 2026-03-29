// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { calculateCost, MODEL_PRICING } from './cost-calculator.js';

// ---------------------------------------------------------------------------
// MODEL_PRICING registry
// ---------------------------------------------------------------------------

describe('MODEL_PRICING', () => {
  it('should contain Gemini models consolidated from gemini-genai-transport', () => {
    expect(MODEL_PRICING['gemini-2.5-flash-lite']).toEqual({ input: 0.075, output: 0.30 });
    expect(MODEL_PRICING['gemini-2.5-flash']).toEqual({ input: 0.15, output: 0.60 });
    expect(MODEL_PRICING['gemini-2.5-pro']).toEqual({ input: 1.25, output: 10.00 });
  });

  it('should contain Anthropic models', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-20250514']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-20250514']).toBeDefined();
  });

  it('should have input and output pricing for every entry', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(typeof pricing.input).toBe('number');
      expect(typeof pricing.output).toBe('number');
      expect(pricing.input).toBeGreaterThanOrEqual(0);
      expect(pricing.output).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('should calculate cost for a known Gemini model', () => {
    // gemini-2.5-flash: $0.15/M input, $0.60/M output
    const cost = calculateCost('gemini-2.5-flash', 1_000_000, 500_000);
    // (1M * 0.15 + 500K * 0.60) / 1M = 0.15 + 0.30 = 0.45
    expect(cost).toBeCloseTo(0.45, 6);
  });

  it('should calculate cost for a known Anthropic model', () => {
    // claude-sonnet-4-6: $3/M input, $15/M output
    const cost = calculateCost('claude-sonnet-4-6', 100_000, 50_000);
    // (100K * 3 + 50K * 15) / 1M = 0.3 + 0.75 = 1.05
    expect(cost).toBeCloseTo(1.05, 6);
  });

  it('should return 0 for an unknown model', () => {
    expect(calculateCost('unknown-model-xyz', 100_000, 50_000)).toBe(0);
  });

  it('should return 0 for zero tokens', () => {
    expect(calculateCost('gemini-2.5-flash', 0, 0)).toBe(0);
  });

  it('should handle prefixed model names by stripping provider prefix', () => {
    const bare = calculateCost('gemini-2.5-flash', 1_000_000, 500_000);
    const prefixed = calculateCost('google/gemini-2.5-flash', 1_000_000, 500_000);
    expect(prefixed).toBe(bare);
  });

  it('should handle Anthropic prefixed model names', () => {
    const bare = calculateCost('claude-sonnet-4-6', 100_000, 50_000);
    const prefixed = calculateCost('anthropic/claude-sonnet-4-6', 100_000, 50_000);
    expect(prefixed).toBe(bare);
  });
});
