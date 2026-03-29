// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReviewFile } from '../../schemas/review.js';
import type { Config } from '../../schemas/config.js';
import type { UsageGraph } from '../usage-graph.js';
import type { PreResolvedRag } from '../axis-evaluator.js';
import type { ReclassificationEntry } from '../correction-memory.js';
import { applyTier1, type Tier1Context, type Tier1Stats } from './tier1.js';
import { applyTier2, detectCrossFilePatterns, type EscalatedFinding, type Tier2Stats } from './tier2.js';
import { buildShards, runTier3, type Tier3Context, type Tier3Result } from './tier3.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | 'tier1-start' | 'tier1-done'
  | 'tier2-start' | 'tier2-done'
  | 'tier3-start' | 'tier3-shard' | 'tier3-done';

export interface RefinementContext {
  projectRoot: string;
  runDir: string;
  config: Config;
  usageGraph: UsageGraph | undefined;
  fileContents: Map<string, string>;
  preResolvedRag: Map<string, PreResolvedRag>;
  abortController: AbortController;
  deliberation: boolean;
  plain: boolean;
  /** Progress callback for UI updates. */
  onProgress?: (event: ProgressEvent, detail?: string) => void;
  /** Injectable loadReviews for testability. */
  loadReviewsFn: (projectRoot: string, runDir: string) => ReviewFile[];
  /** Injectable writeReviewOutput for testability. */
  writeReviewFn: (review: ReviewFile) => void;
  /** Injectable query function for tier 3. */
  queryFn?: Tier3Context['queryFn'];
  /** Injectable record function for tier 3. */
  recordFn?: (projectRoot: string, entry: Omit<ReclassificationEntry, 'recorded_at'>) => void;
}

export interface RefinementResult {
  skipped: boolean;
  tier1Stats: Tier1Stats;
  tier2Stats: { resolved: number; escalated: number };
  tier3Stats: { investigated: number; confirmed: number; reclassified: number };
  totalDurationMs: number;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the 3-tier refinement pipeline on ReviewFiles written by the review phase.
 *
 * Tier 1: Deterministic auto-resolve (0 LLM calls)
 * Tier 2: Inter-axis coherence rules (0 LLM calls)
 * Tier 3: Agentic Opus investigation (LLM calls for escalated findings)
 *
 * Writes refined ReviewFiles back to disk so the report phase reads refined data.
 */
export async function runRefinementPhase(ctx: RefinementContext): Promise<RefinementResult> {
  const emptyResult: RefinementResult = {
    skipped: true,
    tier1Stats: { resolved: 0, confirmed: 0, breakdown: { deadToUsed: 0, duplicateToUnique: 0, overToLean: 0, undocToDoc: 0, fixtureSkipped: 0 } },
    tier2Stats: { resolved: 0, escalated: 0 },
    tier3Stats: { investigated: 0, confirmed: 0, reclassified: 0 },
    totalDurationMs: 0,
    totalCostUsd: 0,
  };

  // Skip when deliberation is disabled (--no-deliberation)
  if (!ctx.deliberation) {
    return emptyResult;
  }

  const phaseStart = Date.now();
  const reviews = ctx.loadReviewsFn(ctx.projectRoot, ctx.runDir);

  if (reviews.length === 0) {
    return { ...emptyResult, skipped: false };
  }

  // --- Tier 1: Deterministic auto-resolve ---
  ctx.onProgress?.('tier1-start', `${reviews.length} files`);

  const tier1Ctx: Tier1Context = {
    usageGraph: ctx.usageGraph ?? { usages: new Map(), typeOnlyUsages: new Map(), intraFileRefs: new Map(), noImportFiles: new Set() },
    preResolvedRag: ctx.preResolvedRag,
    fileContents: ctx.fileContents,
    projectRoot: ctx.projectRoot,
  };

  const tier1TotalStats: Tier1Stats = { resolved: 0, confirmed: 0, breakdown: { deadToUsed: 0, duplicateToUnique: 0, overToLean: 0, undocToDoc: 0, fixtureSkipped: 0 } };
  const tier1Reviews: ReviewFile[] = [];

  for (const review of reviews) {
    const result = applyTier1(review, tier1Ctx);
    if (result._tier1Stats) {
      tier1TotalStats.resolved += result._tier1Stats.resolved;
      tier1TotalStats.confirmed += result._tier1Stats.confirmed;
      for (const key of Object.keys(tier1TotalStats.breakdown) as Array<keyof typeof tier1TotalStats.breakdown>) {
        tier1TotalStats.breakdown[key] += result._tier1Stats.breakdown[key];
      }
    }
    // Strip internal stat marker before passing downstream
    const { _tier1Stats, ...clean } = result;
    tier1Reviews.push(clean as ReviewFile);
  }

  const bd = tier1TotalStats.breakdown;
  const parts: string[] = [];
  if (bd.deadToUsed) parts.push(`${bd.deadToUsed} DEAD→USED`);
  if (bd.duplicateToUnique) parts.push(`${bd.duplicateToUnique} DUP→UNIQUE`);
  if (bd.overToLean) parts.push(`${bd.overToLean} OVER→LEAN`);
  if (bd.undocToDoc) parts.push(`${bd.undocToDoc} UNDOC→DOC`);
  if (bd.fixtureSkipped) parts.push(`${bd.fixtureSkipped} fixture`);
  const breakdownStr = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  ctx.onProgress?.('tier1-done', `${tier1TotalStats.resolved} resolved${breakdownStr}`);

  // --- Tier 2: Inter-axis coherence ---
  ctx.onProgress?.('tier2-start', `${tier1Reviews.length} files`);

  const tier2TotalStats: Tier2Stats = { resolved: 0, escalated: 0 };
  const allEscalated: EscalatedFinding[] = [];
  const tier2Reviews: ReviewFile[] = [];

  for (const review of tier1Reviews) {
    const result = await applyTier2(review);
    tier2TotalStats.resolved += result.stats.resolved;
    tier2TotalStats.escalated += result.stats.escalated;
    allEscalated.push(...result.escalated);
    tier2Reviews.push(result.review);
  }

  // Cross-file pattern detection
  const crossFileFindings = detectCrossFilePatterns(tier2Reviews);
  allEscalated.push(...crossFileFindings);
  tier2TotalStats.escalated += crossFileFindings.length;

  const t2Detail = `${tier2TotalStats.resolved} resolved, ${tier2TotalStats.escalated} escalated` +
    (crossFileFindings.length > 0 ? ` (${crossFileFindings.length} systemic)` : '');
  ctx.onProgress?.('tier2-done', t2Detail);

  // --- Tier 3: Agentic investigation (only if there are escalated findings) ---
  ctx.onProgress?.('tier3-start', `${allEscalated.length} findings`);

  let tier3Stats = { investigated: 0, confirmed: 0, reclassified: 0 };
  let tier3CostUsd = 0;
  let tier3DurationMs = 0;
  const finalReviews = new Map(tier2Reviews.map((r) => [r.file, r]));

  if (allEscalated.length > 0 && ctx.queryFn) {
    const shards = buildShards(allEscalated);

    const tier3Ctx: Tier3Context = {
      projectRoot: ctx.projectRoot,
      runDir: ctx.runDir,
      model: ctx.config.llm.deliberation_model,
      abortController: ctx.abortController,
      reviewsByFile: finalReviews,
      budgetUsd: 30,
      queryFn: ctx.queryFn,
      recordFn: ctx.recordFn,
      onShardDone: (idx, total, result) => {
        const status = result.status === 'ok' ? `${result.confirmed} confirmed, ${result.reclassified} reclassified` : result.status;
        ctx.onProgress?.('tier3-shard', `shard ${idx}/${total} ${result.module} — ${status} (${(result.durationMs / 1000).toFixed(1)}s)`);
      },
    };

    const tier3Result = await runTier3(shards, tier3Ctx);
    tier3Stats = {
      investigated: tier3Result.investigated,
      confirmed: tier3Result.confirmed,
      reclassified: tier3Result.reclassified,
    };
    tier3CostUsd = tier3Result.totalCostUsd;
    tier3DurationMs = tier3Result.totalDurationMs;

    // Merge tier 3 updated reviews back
    for (const [file, updated] of tier3Result.updatedReviews) {
      finalReviews.set(file, updated);
    }
  }

  const t3Parts = [`${tier3Stats.investigated} investigated`];
  if (tier3Stats.confirmed) t3Parts.push(`${tier3Stats.confirmed} confirmed`);
  if (tier3Stats.reclassified) t3Parts.push(`${tier3Stats.reclassified} reclassified`);
  const t3Suffix = tier3DurationMs > 0 ? ` (${(tier3DurationMs / 1000).toFixed(1)}s)` : '';
  ctx.onProgress?.('tier3-done', t3Parts.join(', ') + t3Suffix);

  // --- Write refined ReviewFiles back to disk ---
  for (const review of finalReviews.values()) {
    ctx.writeReviewFn(review);
  }

  const totalDurationMs = Date.now() - phaseStart;

  return {
    skipped: false,
    tier1Stats: tier1TotalStats,
    tier2Stats: { resolved: tier2TotalStats.resolved, escalated: tier2TotalStats.escalated },
    tier3Stats,
    totalDurationMs,
    totalCostUsd: tier3CostUsd,
  };
}
