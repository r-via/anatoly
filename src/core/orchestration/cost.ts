// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralised in-memory LLM-cost reconciliation (relocated verbatim from
 * commands/run.ts in PR 4, doc 11). Every phase that adds to
 * `ctx.totalCostUsd` goes through this so the three buckets
 * (`totalCostUsd`, `providerStats[provider]`, `phaseStats[phase]`) stay
 * reconciled; `axisStats` is rolled up too when `axis` is given.
 *
 * It lives here (not run.ts) so the extracted phases can record cost without
 * importing back into the commands layer. Distinct from the per-call D.4
 * ndjson sink (utils/llm-calls-sink.ts): that is the on-disk ledger, this is
 * the in-memory run rollup. `RunContext` is type-only (erased).
 */

import type { RunContext } from '../../commands/run.js';
import type { AxisTiming } from '../evaluation/index.js';

export function recordLlmCost(
  ctx: RunContext,
  entry: {
    provider: 'anthropic' | 'gemini';
    phase: string;
    axis?: string;
    costUsd: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    calls?: number;
  },
): void {
  const calls = entry.calls ?? 1;
  const durationMs = entry.durationMs ?? 0;
  const inputTokens = entry.inputTokens ?? 0;
  const outputTokens = entry.outputTokens ?? 0;
  const cacheReadTokens = entry.cacheReadTokens ?? 0;
  const cacheCreationTokens = entry.cacheCreationTokens ?? 0;

  ctx.totalCostUsd += entry.costUsd;

  const ps = ctx.providerStats[entry.provider];
  ps.calls += calls;
  ps.costUsd += entry.costUsd;

  const phs = ctx.phaseStats[entry.phase] ??= {
    calls: 0, totalDurationMs: 0, totalCostUsd: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
  };
  phs.calls += calls;
  phs.totalDurationMs += durationMs;
  phs.totalCostUsd += entry.costUsd;
  phs.totalInputTokens += inputTokens;
  phs.totalOutputTokens += outputTokens;
  phs.totalCacheReadTokens += cacheReadTokens;
  phs.totalCacheCreationTokens += cacheCreationTokens;

  if (entry.axis) {
    const axs = ctx.axisStats[entry.axis] ??= {
      calls: 0, totalDurationMs: 0, totalCostUsd: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
    };
    axs.calls += calls;
    axs.totalDurationMs += durationMs;
    axs.totalCostUsd += entry.costUsd;
    axs.totalInputTokens += inputTokens;
    axs.totalOutputTokens += outputTokens;
    axs.totalCacheReadTokens += cacheReadTokens;
    axs.totalCacheCreationTokens += cacheCreationTokens;
  }
}

/**
 * doc 14 PR 2b: the per-axis (agent-grain) cost fold for the review phase.
 *
 * This is the `for (const at of result.axisTiming) recordLlmCost(...)` loop
 * relocated **verbatim** out of the review phase body into this harness-owned
 * cost module. Behaviour is byte-identical (same per-axis grain, same entry
 * shape, same hardcoded `phase: 'review'`): `cost.test.ts` proves the rollup
 * is identical to the inline loop.
 *
 * Grain note: `axisTiming` is one entry per axis (file-evaluator aggregates
 * each axis's internal single-turn queries into one `AxisResult`, so e.g.
 * `correction`'s two passes are already summed). Recording here is therefore
 * per-axis, NOT per single-turn query: that is exactly why the fold could not
 * go into `runUnit` (the single-turn-query grain, PR 2a). The true
 * agent-grain capture (harness wrapping `AxisEvaluator.evaluate`, with
 * provider attribution moved off file-evaluator) is deferred to PR 3/4;
 * `phase: 'review'` stays hardcoded here because review is the sole
 * agent-grain caller (the 4 phase-grain sites are PR 4).
 */
export function recordAgentCosts(ctx: RunContext, axisTiming: readonly AxisTiming[]): void {
  for (const at of axisTiming) {
    recordLlmCost(ctx, {
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
}
