// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { reviewsDir as runReviewsDir } from '../../utils/run-layout.js';
import { ReviewFileSchema } from '../../schemas/review.js';
import type { ReviewFile, Verdict, Action, SymbolReview } from '../../schemas/review.js';

export interface TriageStats {
  total: number;
  skip: number;
  evaluate: number;
  estimatedTimeSaved: number;
}

/**
 * Aggregated statistics for a single audit run.
 * `axisStats` is keyed by {@link AxisId} strings; each value tracks LLM call counts,
 * timing, cost, and token usage (including prompt-cache read vs creation tokens).
 */
export interface RunStats {
  runId: string;
  durationMs: number;
  costUsd: number;
  /** Number of files actually evaluated (not cached). */
  evaluated?: number;
  /** Number of files skipped via SHA cache. */
  cached?: number;
  axisStats: Record<string, { calls: number; totalDurationMs: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number; totalCacheCreationTokens: number }>;
  phaseDurations: Record<string, number>;
  degradedReviews: number;
}

export interface ReportData {
  reviews: ReviewFile[];
  globalVerdict: Verdict;
  totalFiles: number;
  cleanFiles: ReviewFile[];
  findingFiles: ReviewFile[];
  errorFiles: string[];
  degradedFiles: ReviewFile[];
  counts: {
    dead: { high: number; medium: number; low: number };
    duplicate: { high: number; medium: number; low: number };
    overengineering: { high: number; medium: number; low: number };
    correction: { high: number; medium: number; low: number };
    tests: { high: number; medium: number; low: number };
    documentation: { high: number; medium: number; low: number };
    best_practices: { high: number; medium: number; low: number };
  };
  actions: Array<Action & { file: string }>;
}

export interface ShardInfo {
  index: number;
  files: ReviewFile[];
  actions: Array<Action & { file: string }>;
  criticalCount: number;
  refactorCount: number;
}

/** The sentinel substring injected by axis-merger when an axis crashes. */
export const CRASH_SENTINEL = 'axis crashed';

const SHARD_SIZE = 10;

/**
 * Load all .rev.json files from a reviews directory.
 * When runDir is provided, reads from the run-scoped reviews directory.
 * @param projectRoot - Absolute path to the project root (used to resolve the default `.anatoly/reviews` directory).
 * @param runDir - Optional run-scoped directory; when set, reviews are read from `<runDir>/reviews/` instead.
 * @returns Parsed review files sorted alphabetically by file path, skipping any malformed entries.
 */
export function loadReviews(projectRoot: string, runDir?: string): ReviewFile[] {
  const reviewsDir = runDir ? runReviewsDir(runDir) : anatolyPath(projectRoot, 'cache', 'reviews');
  let entries: string[];
  try {
    entries = readdirSync(reviewsDir);
  } catch {
    return [];
  }

  const reviews: ReviewFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.rev.json')) continue;
    const filePath = join(reviewsDir, entry);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const review = ReviewFileSchema.parse(raw);
      reviews.push(review);
    } catch {
      // Skip malformed review files
    }
  }

  return reviews.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Determine if a symbol has an actionable issue on any symbol-level axis.
 * Note: best_practices is file-level (not symbol-level) and is handled separately
 * via `review.best_practices?.rules` in computeFileVerdict and hasAxisFinding.
 */
function hasActionableIssue(s: SymbolReview): boolean {
  return (
    s.correction === 'NEEDS_FIX' ||
    s.correction === 'ERROR' ||
    s.utility === 'DEAD' ||
    s.duplication === 'DUPLICATE' ||
    s.overengineering === 'OVER' ||
    s.tests === 'WEAK' ||
    s.tests === 'NONE' ||
    (s.documentation === 'UNDOCUMENTED' && s.exported) ||
    s.documentation === 'PARTIAL'
  );
}

/**
 * Detect if a review has degraded results (one or more symbols with crash sentinels).
 */
export function isDegradedReview(review: ReviewFile): boolean {
  return review.symbols.some((s) => s.detail.includes(CRASH_SENTINEL));
}

/**
 * Recompute file verdict from symbols — standardizes the LLM's verdict.
 * Low-confidence findings (< 60) are ignored for verdict purposes.
 * @param review - The review file to evaluate.
 * @returns `'CRITICAL'` if any high-confidence ERROR, `'NEEDS_REFACTOR'` if actionable issues or best-practices FAILs exist, otherwise `'CLEAN'`.
 */
export function computeFileVerdict(review: ReviewFile): Verdict {
  const symbols = review.symbols;

  if (symbols.some((s) => s.correction === 'ERROR' && s.confidence >= 60)) return 'CRITICAL';

  const hasConfirmedIssue = symbols.some(
    (s) => s.confidence >= 60 && hasActionableIssue(s),
  );
  if (hasConfirmedIssue) return 'NEEDS_REFACTOR';

  // Best practices FAILs also trigger NEEDS_REFACTOR
  if (review.best_practices?.rules.some((r) => r.status === 'FAIL')) return 'NEEDS_REFACTOR';

  return 'CLEAN';
}

/**
 * Compute the global verdict from all file verdicts.
 * Uses computeFileVerdict to recompute each file's verdict.
 */
export function computeGlobalVerdict(reviews: ReviewFile[]): Verdict {
  if (reviews.length === 0) return 'CLEAN';
  const verdicts = reviews.map((r) => computeFileVerdict(r));
  if (verdicts.includes('CRITICAL')) return 'CRITICAL';
  if (verdicts.includes('NEEDS_REFACTOR')) return 'NEEDS_REFACTOR';
  return 'CLEAN';
}

/**
 * Classify a symbol finding into a severity level based on the axes.
 */
function symbolSeverity(s: SymbolReview): 'high' | 'medium' | 'low' {
  if (s.correction === 'ERROR') return 'high';
  if (s.correction === 'NEEDS_FIX' && s.confidence >= 80) return 'high';
  if (s.utility === 'DEAD' && s.confidence >= 80) return 'high';
  if (s.duplication === 'DUPLICATE' && s.confidence >= 80) return 'high';
  if (s.correction === 'NEEDS_FIX') return 'medium';
  if (s.utility === 'DEAD') return 'medium';
  if (s.duplication === 'DUPLICATE') return 'medium';
  if (s.overengineering === 'OVER') return 'medium';
  if (s.utility === 'LOW_VALUE') return 'low';
  return 'low';
}

/**
 * Aggregate all reviews into a ReportData structure.
 * Counts findings by axis and severity, collects actions, and classifies files into clean/finding/degraded buckets.
 * @param reviews - All parsed review files for the run.
 * @param errorFiles - Optional list of file paths that failed evaluation entirely (e.g. parse errors).
 * @returns A fully populated {@link ReportData} with counts, sorted actions, and computed verdicts.
 */
export function aggregateReviews(reviews: ReviewFile[], errorFiles?: string[]): ReportData {
  const counts = {
    dead: { high: 0, medium: 0, low: 0 },
    duplicate: { high: 0, medium: 0, low: 0 },
    overengineering: { high: 0, medium: 0, low: 0 },
    correction: { high: 0, medium: 0, low: 0 },
    tests: { high: 0, medium: 0, low: 0 },
    documentation: { high: 0, medium: 0, low: 0 },
    best_practices: { high: 0, medium: 0, low: 0 },
  };

  const bpSevMap: Record<string, 'high' | 'medium' | 'low'> = { CRITICAL: 'high', HIGH: 'high', MEDIUM: 'medium' };

  const allActions: Array<Action & { file: string }> = [];

  for (const review of reviews) {
    for (const s of review.symbols) {
      if (s.confidence < 30) continue; // Skip unreliable findings
      const sev = symbolSeverity(s);
      if (s.utility === 'DEAD') counts.dead[sev]++;
      if (s.duplication === 'DUPLICATE') counts.duplicate[sev]++;
      if (s.overengineering === 'OVER') counts.overengineering[sev]++;
      if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') counts.correction[sev]++;
      if (s.tests === 'WEAK' || s.tests === 'NONE') counts.tests[sev]++;
      if (s.documentation === 'PARTIAL' || (s.documentation === 'UNDOCUMENTED' && s.exported)) counts.documentation[sev]++;
    }
    if (review.best_practices) {
      for (const r of review.best_practices.rules) {
        if (r.status === 'FAIL') counts.best_practices[bpSevMap[r.severity] ?? 'low']++;
      }
    }
    for (const a of review.actions) {
      allActions.push({ ...a, file: review.file });
    }
  }

  // Sort actions by severity: high → medium → low
  const sevOrder = { high: 0, medium: 1, low: 2 };
  allActions.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  // Use computeFileVerdict for consistent verdict classification
  const cleanFiles = reviews.filter((r) => computeFileVerdict(r) === 'CLEAN');
  const findingFiles = reviews.filter((r) => computeFileVerdict(r) !== 'CLEAN');
  const degradedFiles = reviews.filter((r) => isDegradedReview(r));

  return {
    reviews,
    globalVerdict: computeGlobalVerdict(reviews),
    totalFiles: reviews.length,
    cleanFiles,
    findingFiles,
    errorFiles: errorFiles ?? [],
    degradedFiles,
    counts,
    actions: allActions,
  };
}

/**
 * Sort finding files: CRITICAL first, then NEEDS_REFACTOR, then by finding
 * count descending, then by max confidence descending.
 * @param files - Review files to sort (not mutated; a sorted copy is returned).
 * @returns A new array sorted by verdict severity, then finding count, then max confidence.
 */
export function sortFindingFiles(files: ReviewFile[]): ReviewFile[] {
  return [...files].sort((a, b) => {
    const vOrder: Record<Verdict, number> = { CRITICAL: 0, NEEDS_REFACTOR: 1, CLEAN: 2 };
    const vA = computeFileVerdict(a);
    const vB = computeFileVerdict(b);
    const vDiff = vOrder[vA] - vOrder[vB];
    if (vDiff !== 0) return vDiff;
    // Finding count descending
    const countA = a.symbols.filter((s) => s.confidence >= 30 && hasActionableIssue(s)).length;
    const countB = b.symbols.filter((s) => s.confidence >= 30 && hasActionableIssue(s)).length;
    if (countA !== countB) return countB - countA;
    // Max confidence descending
    const confA = Math.max(...a.symbols.map((s) => s.confidence), 0);
    const confB = Math.max(...b.symbols.map((s) => s.confidence), 0);
    return confB - confA;
  });
}

/**
 * Build shards from finding files, max SHARD_SIZE files per shard.
 * @param data - The aggregated report data whose `findingFiles` are sorted and chunked.
 * @returns An array of {@link ShardInfo} objects, each containing up to {@link SHARD_SIZE} files.
 */
export function buildShards(data: ReportData): ShardInfo[] {
  const sorted = sortFindingFiles(data.findingFiles);
  if (sorted.length === 0) return [];

  const shards: ShardInfo[] = [];
  for (let i = 0; i < sorted.length; i += SHARD_SIZE) {
    const files = sorted.slice(i, i + SHARD_SIZE);
    const shardFileSet = new Set(files.map((f) => f.file));
    const actions = data.actions.filter((a) => shardFileSet.has(a.file));
    const criticalCount = files.filter((f) => computeFileVerdict(f) === 'CRITICAL').length;
    const refactorCount = files.filter((f) => computeFileVerdict(f) === 'NEEDS_REFACTOR').length;
    shards.push({
      index: shards.length + 1,
      files,
      actions,
      criticalCount,
      refactorCount,
    });
  }
  return shards;
}

