// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReviewFile } from '../../schemas/review.js';
import type { Action } from '../../schemas/review.js';
import type { AxisId } from '../evaluation/contract.js';
import { AXIS_DEFAULT_MODELS } from '../evaluation/axes/index.js';
import { CRASH_SENTINEL, computeFileVerdict, sortFindingFiles } from './review-data.js';
import type { ReportData, ShardInfo } from './review-data.js';

const SHARD_SIZE = 10;

/** The 8 report axes and their filesystem directory names. */
export type ReportAxisId = 'correction' | 'utility' | 'duplication' | 'overengineering' | 'tests' | 'documentation' | 'best-practices' | 'flow';

/** All report axis IDs in display order. */
export const REPORT_AXIS_IDS: readonly ReportAxisId[] = [
  'correction',
  'utility',
  'duplication',
  'overengineering',
  'tests',
  'documentation',
  'best-practices',
  'flow',
] as const;

export interface AxisReport {
  axis: ReportAxisId;
  files: ReviewFile[];
  actions: Array<Action & { file: string }>;
  shards: ShardInfo[];
}

/** Map AxisId (with underscore) to ReportAxisId (with hyphen for filesystem). */
export function toReportAxisId(axisId: AxisId): ReportAxisId {
  return axisId === 'best_practices' ? 'best-practices' : axisId as ReportAxisId;
}

/** Map ReportAxisId back to AxisId. */
export function toAxisId(reportAxisId: ReportAxisId): AxisId {
  return reportAxisId === 'best-practices' ? 'best_practices' : reportAxisId as AxisId;
}

/** Human-readable display name for an axis. */
export function axisDisplayName(axis: ReportAxisId): string {
  const names: Record<ReportAxisId, string> = {
    correction: 'Correction',
    utility: 'Utility',
    duplication: 'Duplication',
    overengineering: 'Overengineering',
    tests: 'Tests',
    documentation: 'Documentation',
    'best-practices': 'Best Practices',
    flow: 'Flow',
  };
  return names[axis];
}

export function axisEmoji(axis: ReportAxisId): string {
  const emojis: Record<ReportAxisId, string> = {
    correction: '🐛',
    utility: '♻️',
    duplication: '📋',
    overengineering: '🏗️',
    tests: '🧪',
    documentation: '📝',
    'best-practices': '✅',
    flow: '🔀',
  };
  return emojis[axis];
}

export function axisIntro(axis: ReportAxisId): string {
  const intros: Record<ReportAxisId, string> = {
    correction: 'Bugs, logic errors, incorrect types, and unsafe operations. Only real correctness issues — not style.',
    utility: 'Dead and low-value code detected via import/usage graph analysis.',
    duplication: 'Code clones detected via RAG semantic vector search.',
    overengineering: 'Unnecessary complexity, premature abstractions, and over-engineering.',
    tests: 'Test coverage quality — missing tests, weak assertions, and untested edge cases.',
    documentation: 'Missing or incomplete doc comments on exported symbols.',
    'best-practices': 'Language-specific best practices and code quality standards.',
    flow: 'User-flow shape defects detected deterministically from the static flow graph: unwired, redundant, inconsistent-sibling, over-indirect, and effect-asymmetric flows.',
  };
  return intros[axis];
}

/**
 * Model tier used by each axis, derived from the evaluator's `defaultModel`
 * (single source of truth in {@link AXIS_DEFAULT_MODELS}). Previously a
 * hardcoded duplicate map that had drifted: it reported `haiku` for axes that
 * actually run on `sonnet` (overengineering, utility, duplication, tests,
 * documentation), which mislabelled every report.
 */
export function axisModel(axis: ReportAxisId): string {
  return AXIS_DEFAULT_MODELS[toAxisId(axis)];
}

/** Map language to its doc comment convention name. */
export function docCommentTerm(language?: string): string {
  switch (language) {
    case 'rust': return '`///` doc comment';
    case 'python': return 'docstring';
    case 'go': return 'Go doc comment';
    case 'java': case 'csharp': return 'Javadoc/XML doc comment';
    default: return 'JSDoc';
  }
}

/** Map language to its best-practices label. */
export function bestPracticesLabel(language?: string): string {
  switch (language) {
    case 'rust': return 'Rust';
    case 'python': return 'Python';
    case 'go': return 'Go';
    case 'java': return 'Java';
    case 'csharp': return 'C#';
    case 'bash': return 'Shell';
    default: return 'TypeScript';
  }
}

/** Derive the primary language from reviews (most common non-undefined language). */
export function derivePrimaryLanguage(reviews: ReviewFile[]): string | undefined {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    if (r.language) {
      counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Positional order of the symbol-level axes inside a merged symbol's
 * `detail` string (see mergeSymbol in axis-merger): segments are
 * joined `[VALUE] detail | [VALUE] detail | …` in this exact order.
 * `best-practices` is file-level, not a symbol detail segment.
 */
const CRASHED_AXIS_ORDER: readonly Exclude<ReportAxisId, 'best-practices'>[] = [
  'utility', 'duplication', 'correction', 'overengineering', 'tests', 'documentation', 'flow',
];

/**
 * The set of symbol-level axes that crashed for at least one symbol anywhere
 * in the run. Parsed from the per-axis crash sentinel embedded in each
 * symbol's `detail`. Used to render crashed axes as "not evaluated" instead
 * of silently borrowing the clean default and showing 100%.
 */
export function crashedAxisIds(data: ReportData): Set<ReportAxisId> {
  const crashed = new Set<ReportAxisId>();
  for (const r of data.reviews) {
    for (const s of r.symbols) {
      if (!s.detail.includes(CRASH_SENTINEL)) continue;
      const segments = s.detail.split(/\s*\|\s*/);
      for (let i = 0; i < segments.length && i < CRASHED_AXIS_ORDER.length; i++) {
        if (segments[i].includes(CRASH_SENTINEL)) crashed.add(CRASHED_AXIS_ORDER[i]);
      }
    }
  }
  return crashed;
}

/**
 * Determine if a review has a finding on a specific axis.
 * @param review - The review file to inspect.
 * @param axis - The report axis to check (e.g. `'correction'`, `'best-practices'`).
 * @returns `true` if any reliable symbol (confidence >= 30) has an actionable finding on the given axis.
 */
export function hasAxisFinding(review: ReviewFile, axis: ReportAxisId): boolean {
  const reliable = review.symbols.filter((s) => s.confidence >= 30);
  switch (axis) {
    case 'correction':
      return reliable.some((s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR');
    case 'utility':
      return reliable.some((s) => s.utility === 'DEAD' || s.utility === 'LOW_VALUE');
    case 'duplication':
      return reliable.some((s) => s.duplication === 'DUPLICATE');
    case 'overengineering':
      return reliable.some((s) => s.overengineering === 'OVER');
    case 'tests':
      return reliable.some((s) => s.tests === 'WEAK' || s.tests === 'NONE');
    case 'documentation':
      return reliable.some((s) => s.documentation === 'PARTIAL' || (s.documentation === 'UNDOCUMENTED' && s.exported));
    case 'best-practices':
      return review.best_practices?.rules.some((r) => r.status === 'FAIL') ?? false;
    case 'flow':
      return reliable.some((s) => s.flow === 'NEEDS_FIX');
  }
}

/**
 * Build axis-scoped reports: for each axis, filter files with findings on that axis,
 * scope actions by source, and shard the result.
 * @param data - The aggregated report data to partition by axis.
 * @returns One {@link AxisReport} per axis that has at least one finding, in display order.
 */
export function buildAxisReports(data: ReportData): AxisReport[] {
  const reports: AxisReport[] = [];

  for (const axis of REPORT_AXIS_IDS) {
    const axisId = toAxisId(axis);
    const actions = data.actions.filter((a) => a.source === axisId);
    const actionFiles = new Set(actions.map((a) => a.file));
    const files = data.reviews.filter((r) => hasAxisFinding(r, axis) || actionFiles.has(r.file));
    if (files.length === 0) continue;
    const sorted = sortFindingFiles(files);

    const shards: ShardInfo[] = [];
    for (let i = 0; i < sorted.length; i += SHARD_SIZE) {
      const chunk = sorted.slice(i, i + SHARD_SIZE);
      const chunkFileSet = new Set(chunk.map((f) => f.file));
      const shardActions = actions.filter((a) => chunkFileSet.has(a.file));
      const criticalCount = chunk.filter((f) => computeFileVerdict(f) === 'CRITICAL').length;
      const refactorCount = chunk.filter((f) => computeFileVerdict(f) === 'NEEDS_REFACTOR').length;
      shards.push({
        index: shards.length + 1,
        files: chunk,
        actions: shardActions,
        criticalCount,
        refactorCount,
      });
    }

    reports.push({ axis, files, actions, shards });
  }

  return reports;
}

/**
 * Compute a "health" percentage for an axis based on the "good" verdict ratio.
 *
 * `evaluated` is the number of reliable symbols (file-level reviews for
 * best-practices) that actually carry a verdict for this axis. When it is
 * `0` the percentage is meaningless: callers must treat the axis as "no
 * data" / "not evaluated" rather than rendering 100% — a crashed axis has
 * `evaluated === 0` and must never look clean. See {@link crashedAxisIds}.
 */
export function axisHealthPercent(data: ReportData, axis: ReportAxisId): { pct: number; label: string; evaluated: number } {
  const reliable = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));

  switch (axis) {
    case 'correction': {
      const total = reliable.filter((s) => s.correction !== '-').length;
      const ok = reliable.filter((s) => s.correction === 'OK').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'OK', evaluated: total };
    }
    case 'utility': {
      const total = reliable.filter((s) => s.utility !== '-').length;
      const ok = reliable.filter((s) => s.utility === 'USED').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'used', evaluated: total };
    }
    case 'duplication': {
      const total = reliable.filter((s) => s.duplication !== '-').length;
      const ok = reliable.filter((s) => s.duplication === 'UNIQUE').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'unique', evaluated: total };
    }
    case 'overengineering': {
      const total = reliable.filter((s) => s.overengineering !== '-').length;
      const ok = reliable.filter((s) => s.overengineering === 'LEAN').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'lean', evaluated: total };
    }
    case 'tests': {
      const total = reliable.filter((s) => s.tests !== '-').length;
      const ok = reliable.filter((s) => s.tests === 'GOOD').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'covered', evaluated: total };
    }
    case 'documentation': {
      const total = reliable.filter((s) => s.documentation !== '-').length;
      const ok = reliable.filter((s) => s.documentation === 'DOCUMENTED').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'documented', evaluated: total };
    }
    case 'flow': {
      const total = reliable.filter((s) => s.flow !== '-').length;
      const ok = reliable.filter((s) => s.flow === 'OK').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'wired', evaluated: total };
    }
    case 'best-practices': {
      const bpReviews = data.reviews.filter((r) => r.best_practices);
      if (bpReviews.length === 0) return { pct: 100, label: '/ 10', evaluated: 0 };
      const avg = bpReviews.reduce((sum, r) => sum + r.best_practices!.score, 0) / bpReviews.length;
      return { pct: Math.round(avg * 10), label: `avg ${avg.toFixed(1)} / 10`, evaluated: bpReviews.length };
    }
  }
}
