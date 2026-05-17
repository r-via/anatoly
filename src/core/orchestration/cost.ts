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
