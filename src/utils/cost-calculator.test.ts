// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { calculateCost } from './cost-calculator.js';
import { PRICING_PATHS, _resetPricingCache } from './pricing-cache.js';

// ---------------------------------------------------------------------------
// `calculateCost` is a thin sync facade over `pricing-cache.lookupPrice`.
// We seed `.anatoly/pricing.json` directly to avoid mocking fetch — that
// path is exercised by pricing-cache.test.ts.
// ---------------------------------------------------------------------------

let projectRoot: string;

function seedPricing(models: Record<string, { input: number; output: number; source?: string }>): void {
  mkdirSync(resolve(projectRoot, '.anatoly'), { recursive: true });
  writeFileSync(
    resolve(projectRoot, PRICING_PATHS.normalized),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      models: Object.fromEntries(
        Object.entries(models).map(([k, v]) => [k, { ...v, source: v.source ?? 'litellm' }]),
      ),
    }),
  );
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-cost-'));
  _resetPricingCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('calculateCost', () => {
  it('computes cost for a known model from the on-disk registry', () => {
    seedPricing({
      'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
    });
    // 100K input * $3/M + 50K output * $15/M = 0.3 + 0.75 = 1.05
    const cost = calculateCost('anthropic/claude-sonnet-4-6', 100_000, 50_000, projectRoot);
    expect(cost).toBeCloseTo(1.05, 6);
  });

  it('returns 0 when the model is not in the registry', () => {
    seedPricing({ 'anthropic/claude-sonnet-4-6': { input: 3, output: 15 } });
    expect(calculateCost('unknown/whatever', 1_000, 1_000, projectRoot)).toBe(0);
  });

  it('returns 0 when no registry file exists yet (cold first call)', () => {
    expect(calculateCost('anthropic/claude-sonnet-4-6', 100_000, 50_000, projectRoot)).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    seedPricing({ 'anthropic/claude-sonnet-4-6': { input: 3, output: 15 } });
    expect(calculateCost('anthropic/claude-sonnet-4-6', 0, 0, projectRoot)).toBe(0);
  });

  it('handles a stripped-prefix call when the registry holds the prefixed key', () => {
    seedPricing({ 'anthropic/claude-sonnet-4-6': { input: 3, output: 15 } });
    // calculateCost with the bare name should still resolve via lookupPrice's prefix-tolerant fallback.
    const bare = calculateCost('claude-sonnet-4-6', 100_000, 50_000, projectRoot);
    const prefixed = calculateCost('anthropic/claude-sonnet-4-6', 100_000, 50_000, projectRoot);
    expect(bare).toBe(prefixed);
  });

  it('computes cost for an embedding model (output_per_mtok = 0)', () => {
    seedPricing({ 'voyage/voyage-code-3': { input: 0.18, output: 0 } });
    // 1M input tokens * $0.18/M + 0 output * $0/M = $0.18
    expect(calculateCost('voyage/voyage-code-3', 1_000_000, 0, projectRoot)).toBeCloseTo(0.18, 6);
  });

  it('computes cost for an OpenRouter model fetched from the openrouter source', () => {
    seedPricing({
      'openrouter/qwen/qwen3-embedding-8b': { input: 0.01, output: 0, source: 'openrouter' },
    });
    expect(
      calculateCost('openrouter/qwen/qwen3-embedding-8b', 1_000_000, 0, projectRoot),
    ).toBeCloseTo(0.01, 6);
  });
});
