// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { recordLlmCost, type RunContext } from './run.js';

function makeBookkeepingCtx(): Pick<RunContext, 'totalCostUsd' | 'providerStats' | 'phaseStats' | 'axisStats'> {
  return {
    totalCostUsd: 0,
    providerStats: { anthropic: { calls: 0, costUsd: 0 }, gemini: { calls: 0, costUsd: 0 } },
    phaseStats: {},
    axisStats: {},
  };
}

describe('recordLlmCost — three-bucket reconciliation invariant', () => {
  it('keeps totalCostUsd ≡ Σ providerStats[*].costUsd ≡ Σ phaseStats[*].totalCostUsd', () => {
    const ctx = makeBookkeepingCtx() as RunContext;
    const calls = [
      { provider: 'anthropic' as const, phase: 'review', axis: 'utility', costUsd: 0.10, inputTokens: 5, outputTokens: 100 },
      { provider: 'anthropic' as const, phase: 'review', axis: 'correction', costUsd: 1.50, inputTokens: 8, outputTokens: 4000 },
      { provider: 'anthropic' as const, phase: 'rag-index', costUsd: 0.05 },
      { provider: 'anthropic' as const, phase: 'coherence-review', costUsd: 0.20, durationMs: 12000 },
      { provider: 'anthropic' as const, phase: 'refinement', costUsd: 0.03, calls: 2 },
      { provider: 'gemini' as const, phase: 'review', axis: 'utility', costUsd: 0.01 },
    ];
    for (const c of calls) recordLlmCost(ctx, c);

    const providerSum = ctx.providerStats.anthropic.costUsd + ctx.providerStats.gemini.costUsd;
    const phaseSum = Object.values(ctx.phaseStats).reduce((s, p) => s + p.totalCostUsd, 0);
    const axisSum = Object.values(ctx.axisStats).reduce((s, a) => s + a.totalCostUsd, 0);

    expect(ctx.totalCostUsd).toBeCloseTo(1.89, 10);
    expect(providerSum).toBeCloseTo(ctx.totalCostUsd, 10);
    expect(phaseSum).toBeCloseTo(ctx.totalCostUsd, 10);
    // Axis sum only covers calls that carried an axis tag (the 3 review calls).
    expect(axisSum).toBeCloseTo(0.10 + 1.50 + 0.01, 10);
  });

  it('attributes calls per provider regardless of phase', () => {
    const ctx = makeBookkeepingCtx() as RunContext;
    recordLlmCost(ctx, { provider: 'anthropic', phase: 'review', axis: 'utility', costUsd: 0.5 });
    recordLlmCost(ctx, { provider: 'anthropic', phase: 'rag-index', costUsd: 0.2 });
    recordLlmCost(ctx, { provider: 'gemini', phase: 'review', axis: 'duplication', costUsd: 0.1 });

    expect(ctx.providerStats.anthropic.calls).toBe(2);
    expect(ctx.providerStats.gemini.calls).toBe(1);
    expect(ctx.phaseStats['rag-index']?.calls).toBe(1);
    expect(ctx.phaseStats.review?.calls).toBe(2);
    expect(ctx.axisStats.utility?.calls).toBe(1);
    expect(ctx.axisStats.duplication?.calls).toBe(1);
  });

  it('explicit calls=N (e.g. doc-generation rolls up multiple page calls)', () => {
    const ctx = makeBookkeepingCtx() as RunContext;
    recordLlmCost(ctx, { provider: 'anthropic', phase: 'bootstrap-doc', costUsd: 1.0, calls: 18, durationMs: 90000 });
    expect(ctx.providerStats.anthropic.calls).toBe(18);
    expect(ctx.phaseStats['bootstrap-doc']?.calls).toBe(18);
    expect(ctx.phaseStats['bootstrap-doc']?.totalDurationMs).toBe(90000);
  });
});

describe('picomatch glob matching (replaces matchGlob)', () => {
  it('should match exact paths', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/utils/helper.ts')).toBe(true);
  });

  it('should match * wildcard (single segment)', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/utils/*.ts')).toBe(true);
    expect(picomatch.isMatch('src/core/scanner.ts', 'src/utils/*.ts')).toBe(false);
  });

  it('should match ** wildcard (multiple segments)', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/**')).toBe(true);
    expect(picomatch.isMatch('src/core/deep/nested.ts', 'src/**')).toBe(true);
    expect(picomatch.isMatch('tests/foo.ts', 'src/**')).toBe(false);
  });

  it('should match ? wildcard (single character)', () => {
    expect(picomatch.isMatch('src/a.ts', 'src/?.ts')).toBe(true);
    expect(picomatch.isMatch('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('should match brace expansion', () => {
    expect(picomatch.isMatch('src/utils/foo.ts', 'src/{utils,core}/**')).toBe(true);
    expect(picomatch.isMatch('src/core/bar.ts', 'src/{utils,core}/**')).toBe(true);
    expect(picomatch.isMatch('src/hooks/baz.ts', 'src/{utils,core}/**')).toBe(false);
  });

  it('should handle dots in file extensions', () => {
    expect(picomatch.isMatch('src/foo.ts', 'src/foo.ts')).toBe(true);
    expect(picomatch.isMatch('src/fooxts', 'src/foo.ts')).toBe(false);
  });
});
