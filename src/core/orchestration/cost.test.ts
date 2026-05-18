// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc 14 PR 2-net: the missing regression net for the in-memory cost rollup.
 *
 * `recordLlmCost` ([cost.ts]) feeds `ctx.totalCostUsd` / `providerStats` /
 * `phaseStats` / `axisStats`, which surface in run-metrics.json and the
 * report. It is NOT the on-disk `costs/ledger.ndjson` (that is written by the
 * transport layer's recordLlmCall, covered by cost-integrity.test.ts). Before
 * doc 14 PR 2b folds the review.ts agent-grain cost call into the harness,
 * this test locks the exact bucket arithmetic so "byte-identical rollup" is
 * provable in-process.
 *
 * Pure synthetic: hand-built entries fed straight into `recordLlmCost`. Zero
 * LLM calls, zero I/O, milliseconds (per the no-LLM-in-tests constraint).
 */

import { describe, it, expect } from 'vitest';
import {
  recordLlmCost,
  recordAgentCosts,
  recordRagCost,
  recordDocGenerationCost,
  recordDocCoherenceCost,
  recordRefinementCost,
  recordDocConflictCost,
} from './cost.js';
import type { AxisTiming } from '../evaluation/index.js';

type CostCtx = Parameters<typeof recordLlmCost>[0];

type Bucket = {
  calls: number;
  totalDurationMs: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
};

/** Minimal structural ctx with exactly the buckets recordLlmCost touches. */
function makeCtx() {
  const ctx = {
    totalCostUsd: 0,
    providerStats: {
      anthropic: { calls: 0, costUsd: 0 },
      gemini: { calls: 0, costUsd: 0 },
    },
    phaseStats: {} as Record<string, Bucket>,
    axisStats: {} as Record<string, Bucket>,
  };
  return ctx as typeof ctx & CostCtx;
}

describe('recordLlmCost — in-memory rollup contract (doc 14 PR 2-net)', () => {
  it('a single anthropic entry without axis: total + provider + phase, axisStats untouched', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, {
      provider: 'anthropic',
      phase: 'review',
      costUsd: 0.005,
      durationMs: 1200,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
    });

    expect(ctx.totalCostUsd).toBeCloseTo(0.005, 10);
    expect(ctx.providerStats.anthropic).toEqual({ calls: 1, costUsd: 0.005 });
    expect(ctx.providerStats.gemini).toEqual({ calls: 0, costUsd: 0 });
    expect(ctx.phaseStats['review']).toEqual({
      calls: 1,
      totalDurationMs: 1200,
      totalCostUsd: 0.005,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 10,
      totalCacheCreationTokens: 20,
    });
    expect(Object.keys(ctx.axisStats)).toHaveLength(0);
  });

  it('omitted numeric fields default to 0 and calls defaults to 1', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, { provider: 'anthropic', phase: 'rag-index', costUsd: 0.01 });

    expect(ctx.providerStats.anthropic).toEqual({ calls: 1, costUsd: 0.01 });
    expect(ctx.phaseStats['rag-index']).toEqual({
      calls: 1,
      totalDurationMs: 0,
      totalCostUsd: 0.01,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
  });

  it('honors an explicit calls override on provider and phase buckets', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, { provider: 'anthropic', phase: 'refinement', costUsd: 0.02, calls: 4 });

    expect(ctx.providerStats.anthropic.calls).toBe(4);
    expect(ctx.phaseStats['refinement'].calls).toBe(4);
  });

  it('routes a gemini entry to the gemini provider bucket only', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, { provider: 'gemini', phase: 'review', costUsd: 0.003 });

    expect(ctx.providerStats.gemini).toEqual({ calls: 1, costUsd: 0.003 });
    expect(ctx.providerStats.anthropic).toEqual({ calls: 0, costUsd: 0 });
  });

  it('creates and then accumulates the axis bucket only when axis is given', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, {
      provider: 'anthropic', phase: 'review', axis: 'correction',
      costUsd: 0.004, durationMs: 100, inputTokens: 200, outputTokens: 80,
      cacheReadTokens: 1, cacheCreationTokens: 2,
    });
    recordLlmCost(ctx, {
      provider: 'anthropic', phase: 'review', axis: 'correction',
      costUsd: 0.006, durationMs: 50, inputTokens: 300, outputTokens: 20,
      cacheReadTokens: 3, cacheCreationTokens: 4,
    });

    expect(ctx.axisStats['correction']).toEqual({
      calls: 2,
      totalDurationMs: 150,
      totalCostUsd: 0.01,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      totalCacheReadTokens: 4,
      totalCacheCreationTokens: 6,
    });
  });

  it('accumulates repeated entries for the same phase and sums total cost', () => {
    const ctx = makeCtx();
    recordLlmCost(ctx, {
      provider: 'anthropic', phase: 'review', costUsd: 0.005,
      durationMs: 100, inputTokens: 1000, outputTokens: 500,
    });
    recordLlmCost(ctx, {
      provider: 'gemini', phase: 'review', costUsd: 0.002,
      durationMs: 200, inputTokens: 2000, outputTokens: 50,
    });

    expect(ctx.totalCostUsd).toBeCloseTo(0.007, 10);
    expect(ctx.phaseStats['review']).toEqual({
      calls: 2,
      totalDurationMs: 300,
      totalCostUsd: 0.007,
      totalInputTokens: 3000,
      totalOutputTokens: 550,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    expect(ctx.providerStats.anthropic).toEqual({ calls: 1, costUsd: 0.005 });
    expect(ctx.providerStats.gemini).toEqual({ calls: 1, costUsd: 0.002 });
  });

  it('mirrors the review.ts per-axis loop: N axisTiming entries roll up identically', () => {
    // Locks the exact shape doc 14 PR 2b will move into the harness: the
    // review.ts `for (const at of result.axisTiming) recordLlmCost(...)` loop.
    const ctx = makeCtx();
    const axisTiming = [
      { provider: 'anthropic' as const, axisId: 'correction', costUsd: 0.004, durationMs: 100, inputTokens: 200, outputTokens: 80, cacheReadTokens: 1, cacheCreationTokens: 2 },
      { provider: 'anthropic' as const, axisId: 'utility', costUsd: 0.003, durationMs: 90, inputTokens: 150, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { provider: 'gemini' as const, axisId: 'duplication', costUsd: 0.001, durationMs: 70, inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ];
    for (const at of axisTiming) {
      recordLlmCost(ctx, {
        provider: at.provider, phase: 'review', axis: at.axisId,
        costUsd: at.costUsd, durationMs: at.durationMs,
        inputTokens: at.inputTokens, outputTokens: at.outputTokens,
        cacheReadTokens: at.cacheReadTokens, cacheCreationTokens: at.cacheCreationTokens,
      });
    }

    expect(ctx.totalCostUsd).toBeCloseTo(0.008, 10);
    expect(ctx.phaseStats['review'].calls).toBe(3);
    expect(ctx.providerStats.anthropic).toEqual({ calls: 2, costUsd: 0.007 });
    expect(ctx.providerStats.gemini).toEqual({ calls: 1, costUsd: 0.001 });
    expect(Object.keys(ctx.axisStats).sort()).toEqual(['correction', 'duplication', 'utility']);
    expect(ctx.axisStats['utility'].totalCostUsd).toBeCloseTo(0.003, 10);
  });
});

describe('recordAgentCosts — byte-identical to the inline review.ts loop (doc 14 PR 2b)', () => {
  const axisTiming: AxisTiming[] = [
    { axisId: 'correction', provider: 'anthropic', costUsd: 0.004, durationMs: 100, inputTokens: 200, outputTokens: 80, cacheReadTokens: 1, cacheCreationTokens: 2 },
    { axisId: 'utility', provider: 'anthropic', costUsd: 0.003, durationMs: 90, inputTokens: 150, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { axisId: 'duplication', provider: 'gemini', costUsd: 0.001, durationMs: 70, inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ];

  it('produces a rollup identical to the pre-PR-2b manual per-axis loop', () => {
    // Reference: the exact loop that lived inline in review.ts:378.
    const ref = makeCtx();
    for (const at of axisTiming) {
      recordLlmCost(ref, {
        provider: at.provider,
        phase: 'review',
        axis: at.axisId,
        costUsd: at.costUsd,
        durationMs: at.durationMs,
        inputTokens: at.inputTokens,
        outputTokens: at.outputTokens,
        cacheReadTokens: at.cacheReadTokens,
        cacheCreationTokens: at.cacheCreationTokens,
      });
    }

    const viaHarness = makeCtx();
    recordAgentCosts(viaHarness, axisTiming);

    // Byte-identical: every bucket equal.
    expect(viaHarness.totalCostUsd).toBe(ref.totalCostUsd);
    expect(viaHarness.providerStats).toEqual(ref.providerStats);
    expect(viaHarness.phaseStats).toEqual(ref.phaseStats);
    expect(viaHarness.axisStats).toEqual(ref.axisStats);
  });

  it('an empty axisTiming records nothing', () => {
    const ctx = makeCtx();
    recordAgentCosts(ctx, []);
    expect(ctx.totalCostUsd).toBe(0);
    expect(ctx.providerStats).toEqual({ anthropic: { calls: 0, costUsd: 0 }, gemini: { calls: 0, costUsd: 0 } });
    expect(Object.keys(ctx.phaseStats)).toHaveLength(0);
    expect(Object.keys(ctx.axisStats)).toHaveLength(0);
  });
});

describe('phase-grain cost helpers — byte-identical to the inline calls (doc 14 PR 4a)', () => {
  it('recordRagCost == the rag.ts inline recordLlmCost', () => {
    const ref = makeCtx();
    recordLlmCost(ref, { provider: 'anthropic', phase: 'rag-index', costUsd: 0.012, durationMs: 4200 });
    const via = makeCtx();
    recordRagCost(via, { costUsd: 0.012, durationMs: 4200 });
    expect(via.totalCostUsd).toBe(ref.totalCostUsd);
    expect(via.providerStats).toEqual(ref.providerStats);
    expect(via.phaseStats).toEqual(ref.phaseStats);
    expect(via.axisStats).toEqual(ref.axisStats);
  });

  it('recordDocGenerationCost == the doc.ts inline recordLlmCost (phase = taskId)', () => {
    const ref = makeCtx();
    recordLlmCost(ref, { provider: 'anthropic', phase: 'bootstrap-doc', costUsd: 0.34, durationMs: 90_000, calls: 7 });
    const via = makeCtx();
    recordDocGenerationCost(via, 'bootstrap-doc', { costUsd: 0.34, durationMs: 90_000, calls: 7 });
    expect(via.totalCostUsd).toBe(ref.totalCostUsd);
    expect(via.providerStats).toEqual(ref.providerStats);
    expect(via.phaseStats).toEqual(ref.phaseStats);
    expect(via.axisStats).toEqual(ref.axisStats);
  });

  it('recordDocCoherenceCost == the doc.ts inline recordLlmCost', () => {
    const ref = makeCtx();
    recordLlmCost(ref, { provider: 'anthropic', phase: 'coherence-review', costUsd: 0.08, durationMs: 30_000 });
    const via = makeCtx();
    recordDocCoherenceCost(via, { costUsd: 0.08, durationMs: 30_000 });
    expect(via.totalCostUsd).toBe(ref.totalCostUsd);
    expect(via.providerStats).toEqual(ref.providerStats);
    expect(via.phaseStats).toEqual(ref.phaseStats);
    expect(via.axisStats).toEqual(ref.axisStats);
  });

  it('recordRefinementCost == the refinement.ts inline recordLlmCost (full token set)', () => {
    const ref = makeCtx();
    recordLlmCost(ref, {
      provider: 'anthropic', phase: 'refinement',
      costUsd: 0.21, durationMs: 60_000, calls: 5,
      inputTokens: 4000, outputTokens: 1500, cacheReadTokens: 200, cacheCreationTokens: 50,
    });
    const via = makeCtx();
    recordRefinementCost(via, {
      costUsd: 0.21, durationMs: 60_000, calls: 5,
      inputTokens: 4000, outputTokens: 1500, cacheReadTokens: 200, cacheCreationTokens: 50,
    });
    expect(via.totalCostUsd).toBe(ref.totalCostUsd);
    expect(via.providerStats).toEqual(ref.providerStats);
    expect(via.phaseStats).toEqual(ref.phaseStats);
    expect(via.axisStats).toEqual(ref.axisStats);
  });

  it('recordDocConflictCost == an equivalent recordLlmCost, for both phase names (doc 15 PR 1)', () => {
    const m = {
      costUsd: 0.09, durationMs: 12_000, calls: 2,
      inputTokens: 800, outputTokens: 300, cacheReadTokens: 10, cacheCreationTokens: 5,
    };
    for (const phase of ['doc-conflict-bootstrap', 'doc-conflict-update'] as const) {
      const ref = makeCtx();
      recordLlmCost(ref, { provider: 'anthropic', phase, ...m });
      const via = makeCtx();
      recordDocConflictCost(via, phase, m);
      expect(via.totalCostUsd).toBe(ref.totalCostUsd);
      expect(via.providerStats).toEqual(ref.providerStats);
      expect(via.phaseStats).toEqual(ref.phaseStats);
      expect(via.axisStats).toEqual(ref.axisStats);
    }
  });
});
