// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReviewFileSchema } from '../schemas/review.js';
import type { ReviewFile, Verdict, Action, SymbolReview, Category } from '../schemas/review.js';
import type { AxisId } from './axis-evaluator.js';
import { toOutputName } from '../utils/cache.js';


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

/**
 * Load all .rev.json files from a reviews directory.
 * When runDir is provided, reads from the run-scoped reviews directory.
 * @param projectRoot - Absolute path to the project root (used to resolve the default `.anatoly/reviews` directory).
 * @param runDir - Optional run-scoped directory; when set, reviews are read from `<runDir>/reviews/` instead.
 * @returns Parsed review files sorted alphabetically by file path, skipping any malformed entries.
 */
export function loadReviews(projectRoot: string, runDir?: string): ReviewFile[] {
  const reviewsDir = runDir ? join(runDir, 'reviews') : resolve(projectRoot, '.anatoly', 'reviews');
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

/** The sentinel substring injected by axis-merger when an axis crashes. */
const CRASH_SENTINEL = 'axis crashed';

/**
 * Detect if a review has degraded results (one or more symbols with crash sentinels).
 */
function isDegradedReview(review: ReviewFile): boolean {
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
 * Generate a deterministic action ID for checkbox matching.
 * Format: ACT-{6-char file hash}-{action id}
 */
export function makeActId(file: string, actionId: number): string {
  const hash = createHash('sha256').update(file).digest('hex').slice(0, 6);
  return `ACT-${hash}-${actionId}`;
}

function renderAction(lines: string[], a: Action & { file: string }): void {
  const effort = a.effort ?? 'small';
  const src = a.source ? `${a.source} · ` : '';
  const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
  const loc = a.target_lines ? ` [${a.target_lines}]` : '';
  const actId = makeActId(a.file, a.id);
  lines.push(`- [ ] <!-- ${actId} --> **[${src}${a.severity} · ${effort}]** \`${a.file}\`: ${a.description}${target}${loc}`);
}

const SHARD_SIZE = 10;

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

export interface ShardInfo {
  index: number;
  files: ReviewFile[];
  actions: Array<Action & { file: string }>;
  criticalCount: number;
  refactorCount: number;
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

// ---------------------------------------------------------------------------
// Axis-based report types
// ---------------------------------------------------------------------------

/** The 7 report axes and their filesystem directory names. */
export type ReportAxisId = 'correction' | 'utility' | 'duplication' | 'overengineering' | 'tests' | 'documentation' | 'best-practices';

/** All report axis IDs in display order. */
export const REPORT_AXIS_IDS: readonly ReportAxisId[] = [
  'correction',
  'utility',
  'duplication',
  'overengineering',
  'tests',
  'documentation',
  'best-practices',
] as const;

/** Map AxisId (with underscore) to ReportAxisId (with hyphen for filesystem). */
export function toReportAxisId(axisId: AxisId): ReportAxisId {
  return axisId === 'best_practices' ? 'best-practices' : axisId as ReportAxisId;
}

/** Map ReportAxisId back to AxisId. */
export function toAxisId(reportAxisId: ReportAxisId): AxisId {
  return reportAxisId === 'best-practices' ? 'best_practices' : reportAxisId as AxisId;
}

/** Human-readable display name for an axis. */
function axisDisplayName(axis: ReportAxisId): string {
  const names: Record<ReportAxisId, string> = {
    correction: 'Correction',
    utility: 'Utility',
    duplication: 'Duplication',
    overengineering: 'Overengineering',
    tests: 'Tests',
    documentation: 'Documentation',
    'best-practices': 'Best Practices',
  };
  return names[axis];
}

/** Model used by each axis. */
function axisModel(axis: ReportAxisId): string {
  const models: Record<ReportAxisId, string> = {
    correction: 'sonnet',
    utility: 'haiku',
    duplication: 'haiku',
    overengineering: 'haiku',
    tests: 'haiku',
    documentation: 'haiku',
    'best-practices': 'sonnet',
  };
  return models[axis];
}

export interface AxisReport {
  axis: ReportAxisId;
  files: ReviewFile[];
  actions: Array<Action & { file: string }>;
  shards: ShardInfo[];
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
    const files = data.reviews.filter((r) => hasAxisFinding(r, axis));
    if (files.length === 0) continue;

    const axisId = toAxisId(axis);
    const actions = data.actions.filter((a) => a.source === axisId);
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

// ---------------------------------------------------------------------------
// Axis methodology — one per axis
// ---------------------------------------------------------------------------

function renderAxisMethodology(axis: ReportAxisId): string[] {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push(`**Model:** ${axisModel(axis)}`);
  lines.push('');

  switch (axis) {
    case 'utility':
      lines.push('Detects dead or low-value code using a pre-computed import/usage graph.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **USED**: The symbol is imported or referenced by at least one other file (exported) or used locally (non-exported).');
      lines.push('- **DEAD**: The symbol is exported but imported by 0 files, or is a non-exported symbol with no local references. Likely safe to remove.');
      lines.push('- **LOW_VALUE**: The symbol is used but provides negligible value (trivial wrapper, identity function, unnecessary indirection).');
      break;

    case 'duplication':
      lines.push('Identifies code clones via RAG semantic vector search against the codebase index.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **UNIQUE**: No semantically similar function found, or similarity score < 0.75.');
      lines.push('- **DUPLICATE**: Similarity score >= 0.85 with matching logic/behavior. The duplicate target file and symbol are reported.');
      break;

    case 'correction':
      lines.push('Finds bugs, logic errors, incorrect types, and unsafe operations. Only flags real correctness issues, not style.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **OK**: No bugs or correctness issues found.');
      lines.push('- **NEEDS_FIX**: A real bug, logic error, or type mismatch that would cause incorrect behavior at runtime.');
      lines.push('- **ERROR**: A critical bug that would cause a crash, data loss, or security breach.');
      break;

    case 'overengineering':
      lines.push('Evaluates whether complexity is justified by actual requirements.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **LEAN**: Implementation is minimal and appropriate for its purpose. A long function doing one thing well is still LEAN.');
      lines.push('- **OVER**: Unnecessary abstractions, premature generalization, factory patterns for single use, excessive configuration for simple behavior.');
      lines.push('- **ACCEPTABLE**: Some complexity present but justified by requirements.');
      break;

    case 'tests':
      lines.push('Assesses test coverage quality using coverage data (when available) and test file analysis.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **GOOD**: Meaningful unit tests covering happy path and edge cases.');
      lines.push('- **WEAK**: Tests exist but are superficial, missing edge cases, or testing implementation details rather than behavior.');
      lines.push('- **NONE**: No test file or test cases found for this symbol. Types/interfaces with no runtime behavior default to GOOD.');
      break;

    case 'documentation':
      lines.push('Evaluates JSDoc coverage on exported symbols and optional /docs/ concept coverage.');
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('- **DOCUMENTED**: Symbol has a complete JSDoc comment covering description, params, and return type.');
      lines.push('- **PARTIAL**: JSDoc exists but is incomplete (missing params, outdated description, or lacking return type).');
      lines.push('- **UNDOCUMENTED**: No JSDoc documentation found for an exported symbol. Types and interfaces default to DOCUMENTED.');
      break;

    case 'best-practices':
      lines.push('File-level evaluation against 17 TypeGuard v2 rules. Starts at 10/10, penalties subtracted per violation:');
      lines.push('');
      lines.push('| # | Rule | Severity | Penalty |');
      lines.push('|---|------|----------|---------|');
      lines.push('| 1 | Strict mode (tsconfig strict: true) | HIGH | -1 pt |');
      lines.push('| 2 | No `any` (explicit or implicit) | CRITICAL | -3 pts |');
      lines.push('| 3 | Discriminated unions over type assertions | MEDIUM | -0.5 pt |');
      lines.push('| 4 | Utility types (Pick, Omit, Partial, Record) | MEDIUM | -0.5 pt |');
      lines.push('| 5 | Immutability (readonly, as const) | MEDIUM | -0.5 pt |');
      lines.push('| 6 | Interface vs Type consistency | MEDIUM | -0.5 pt |');
      lines.push('| 7 | File size < 300 lines | HIGH | -1 pt |');
      lines.push('| 8 | ESLint compliance | HIGH | -1 pt |');
      lines.push('| 9 | JSDoc on public exports | MEDIUM | -0.5 pt |');
      lines.push('| 10 | Modern 2026 practices | MEDIUM | -0.5 pt |');
      lines.push('| 11 | Import organization | MEDIUM | -0.5 pt |');
      lines.push('| 12 | Async/Promises/Error handling | HIGH | -1 pt |');
      lines.push('| 13 | Security (no secrets, eval, injection) | CRITICAL | -4 pts |');
      lines.push('| 14 | Performance (no N+1, sync I/O) | MEDIUM | -0.5 pt |');
      lines.push('| 15 | Testability (DI, low coupling) | MEDIUM | -0.5 pt |');
      lines.push('| 16 | TypeScript 5.5+ features | MEDIUM | -0.5 pt |');
      lines.push('| 17 | Context-adapted rules | MEDIUM | -0.5 pt |');
      break;
  }

  lines.push('');
  return lines;
}

// ---------------------------------------------------------------------------
// Axis index renderer
// ---------------------------------------------------------------------------

/**
 * Render the index for a single axis: stats, shard links, methodology.
 * @param report - The axis report containing files, actions, and shards to render.
 * @returns A complete markdown string for the axis index page.
 */
export function renderAxisIndex(report: AxisReport): string {
  const lines: string[] = [];
  const name = axisDisplayName(report.axis);

  lines.push(`# ${name}`);
  lines.push('');

  // Stats
  lines.push(`- **Files with findings:** ${report.files.length}`);
  lines.push(`- **Actions:** ${report.actions.length}`);
  lines.push('');

  // Shard links
  if (report.shards.length > 0) {
    lines.push('## Shards');
    lines.push('');
    for (const shard of report.shards) {
      const composition: string[] = [];
      if (shard.criticalCount > 0) composition.push(`${shard.criticalCount} CRITICAL`);
      if (shard.refactorCount > 0) composition.push(`${shard.refactorCount} NEEDS_REFACTOR`);
      const desc = composition.length > 0 ? ` — ${composition.join(', ')}` : '';
      lines.push(`- [ ] [shard.${shard.index}.md](./shard.${shard.index}.md) (${shard.files.length} files${desc})`);
    }
    lines.push('');
  }

  // Axis-specific verdict distribution
  lines.push(...renderAxisVerdictDistribution(report));

  // Methodology
  lines.push(...renderAxisMethodology(report.axis));

  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Render verdict distribution for a specific axis.
 */
function renderAxisVerdictDistribution(report: AxisReport): string[] {
  const lines: string[] = [];
  const reliable = report.files.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));
  if (reliable.length === 0) return lines;

  lines.push('## Verdict Distribution');
  lines.push('');

  switch (report.axis) {
    case 'utility': {
      const used = reliable.filter((s) => s.utility === 'USED').length;
      const dead = reliable.filter((s) => s.utility === 'DEAD').length;
      const low = reliable.filter((s) => s.utility === 'LOW_VALUE').length;
      const total = used + dead + low;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (used > 0) lines.push(`| USED | ${used} | ${((used / total) * 100).toFixed(0)}% |`);
        if (dead > 0) lines.push(`| DEAD | ${dead} | ${((dead / total) * 100).toFixed(0)}% |`);
        if (low > 0) lines.push(`| LOW_VALUE | ${low} | ${((low / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'duplication': {
      const unique = reliable.filter((s) => s.duplication === 'UNIQUE').length;
      const dup = reliable.filter((s) => s.duplication === 'DUPLICATE').length;
      const total = unique + dup;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (unique > 0) lines.push(`| UNIQUE | ${unique} | ${((unique / total) * 100).toFixed(0)}% |`);
        if (dup > 0) lines.push(`| DUPLICATE | ${dup} | ${((dup / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'correction': {
      const ok = reliable.filter((s) => s.correction === 'OK').length;
      const fix = reliable.filter((s) => s.correction === 'NEEDS_FIX').length;
      const err = reliable.filter((s) => s.correction === 'ERROR').length;
      const total = ok + fix + err;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (ok > 0) lines.push(`| OK | ${ok} | ${((ok / total) * 100).toFixed(0)}% |`);
        if (fix > 0) lines.push(`| NEEDS_FIX | ${fix} | ${((fix / total) * 100).toFixed(0)}% |`);
        if (err > 0) lines.push(`| ERROR | ${err} | ${((err / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'overengineering': {
      const lean = reliable.filter((s) => s.overengineering === 'LEAN').length;
      const acc = reliable.filter((s) => s.overengineering === 'ACCEPTABLE').length;
      const over = reliable.filter((s) => s.overengineering === 'OVER').length;
      const total = lean + acc + over;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (lean > 0) lines.push(`| LEAN | ${lean} | ${((lean / total) * 100).toFixed(0)}% |`);
        if (acc > 0) lines.push(`| ACCEPTABLE | ${acc} | ${((acc / total) * 100).toFixed(0)}% |`);
        if (over > 0) lines.push(`| OVER | ${over} | ${((over / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'tests': {
      const good = reliable.filter((s) => s.tests === 'GOOD').length;
      const weak = reliable.filter((s) => s.tests === 'WEAK').length;
      const none = reliable.filter((s) => s.tests === 'NONE').length;
      const total = good + weak + none;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (good > 0) lines.push(`| GOOD | ${good} | ${((good / total) * 100).toFixed(0)}% |`);
        if (weak > 0) lines.push(`| WEAK | ${weak} | ${((weak / total) * 100).toFixed(0)}% |`);
        if (none > 0) lines.push(`| NONE | ${none} | ${((none / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'documentation': {
      const doc = reliable.filter((s) => s.documentation === 'DOCUMENTED').length;
      const partial = reliable.filter((s) => s.documentation === 'PARTIAL').length;
      const undoc = reliable.filter((s) => s.documentation === 'UNDOCUMENTED').length;
      const total = doc + partial + undoc;
      if (total > 0) {
        lines.push('| Verdict | Count | % |');
        lines.push('|---------|-------|---|');
        if (doc > 0) lines.push(`| DOCUMENTED | ${doc} | ${((doc / total) * 100).toFixed(0)}% |`);
        if (partial > 0) lines.push(`| PARTIAL | ${partial} | ${((partial / total) * 100).toFixed(0)}% |`);
        if (undoc > 0) lines.push(`| UNDOCUMENTED | ${undoc} | ${((undoc / total) * 100).toFixed(0)}% |`);
        lines.push('');
      }
      break;
    }
    case 'best-practices': {
      const bpReviews = report.files.filter((r) => r.best_practices);
      if (bpReviews.length > 0) {
        const scores = bpReviews.map((r) => r.best_practices!.score);
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        lines.push('| Metric | Value |');
        lines.push('|--------|-------|');
        lines.push(`| Average score | ${avg.toFixed(1)}/10 |`);
        lines.push(`| Min / Max | ${min.toFixed(1)} / ${max.toFixed(1)} |`);
        lines.push('');
      }
      break;
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Axis shard renderer
// ---------------------------------------------------------------------------

/**
 * Render a shard for a specific axis — only shows findings relevant to that axis.
 * @param axis - The report axis this shard belongs to.
 * @param shard - The shard info containing the files and actions to render.
 * @returns A markdown string with findings table, action items, and per-file details.
 */
export function renderAxisShard(axis: ReportAxisId, shard: ShardInfo): string {
  const lines: string[] = [];
  const name = axisDisplayName(axis);

  lines.push(`# ${name} — Shard ${shard.index}`);
  lines.push('');

  // Findings table — axis-specific columns
  lines.push('## Findings');
  lines.push('');

  if (axis === 'best-practices') {
    lines.push('| File | Verdict | BP Score | Details |');
    lines.push('|------|---------|----------|---------|');
    for (const review of shard.files) {
      const bpScore = review.best_practices ? `${review.best_practices.score}/10` : '-';
      const outputName = toOutputName(review.file);
      const link = `[details](../reviews/${outputName}.rev.md)`;
      const fileVerdict = computeFileVerdict(review);
      lines.push(`| \`${review.file}\` | ${fileVerdict} | ${bpScore} | ${link} |`);
    }
  } else {
    const header = axisShardHeader(axis);
    lines.push(header.columns);
    lines.push(header.separator);
    for (const review of shard.files) {
      const reliable = review.symbols.filter((s) => s.confidence >= 30);
      const count = axisShardCount(axis, reliable);
      const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
      const outputName = toOutputName(review.file);
      const link = `[details](../reviews/${outputName}.rev.md)`;
      const fileVerdict = computeFileVerdict(review);
      lines.push(`| \`${review.file}\` | ${fileVerdict} | ${count} | ${maxConf}% | ${link} |`);
    }
  }
  lines.push('');

  // Symbol-level details
  const filesWithAxisFindings = shard.files.filter((r) => hasAxisFinding(r, axis));
  if (filesWithAxisFindings.length > 0 && axis !== 'best-practices') {
    lines.push('## Symbol Details');
    lines.push('');
    for (const review of filesWithAxisFindings) {
      const actionable = review.symbols.filter((s) => s.confidence >= 30 && hasAxisSymbolFinding(s, axis));
      if (actionable.length === 0) continue;
      lines.push(`### \`${review.file}\``);
      lines.push('');
      lines.push(`| Symbol | Lines | ${axisDisplayName(axis)} | Conf. | Detail |`);
      lines.push(`|--------|-------|${'-'.repeat(axisDisplayName(axis).length + 2)}|-------|--------|`);
      for (const s of actionable) {
        const value = axisSymbolValue(s, axis);
        const detail = s.detail.length > 80 ? s.detail.slice(0, 77) + '...' : s.detail;
        lines.push(`| \`${s.name}\` | L${s.line_start}–L${s.line_end} | ${value} | ${s.confidence}% | ${detail} |`);
      }
      lines.push('');
    }
  }

  // Best practices details
  if (axis === 'best-practices') {
    const bpReviews = shard.files.filter((r) => r.best_practices && r.best_practices.suggestions.length > 0);
    if (bpReviews.length > 0) {
      lines.push('## Details');
      lines.push('');
      for (const review of bpReviews) {
        const bp = review.best_practices!;
        lines.push(`### \`${review.file}\` — ${bp.score}/10`);
        lines.push('');
        // Failed rules
        const failed = bp.rules.filter((r) => r.status === 'FAIL');
        if (failed.length > 0) {
          lines.push('**Failed rules:**');
          lines.push('');
          for (const r of failed) {
            lines.push(`- Rule ${r.rule_id}: ${r.rule_name} (${r.severity})`);
          }
          lines.push('');
        }
        // Suggestions
        for (const s of bp.suggestions) {
          lines.push(`- ${s.description}`);
          if (s.before && s.after) {
            lines.push(`  - Before: \`${s.before}\``);
            lines.push(`  - After: \`${s.after}\``);
          }
        }
        lines.push('');
      }
    }
  }

  // Actions by category (scoped to this axis)
  if (shard.actions.length > 0) {
    const byCategory: Record<Category, Array<Action & { file: string }>> = {
      quickwin: [],
      refactor: [],
      hygiene: [],
    };
    for (const a of shard.actions) {
      const cat = a.category ?? 'refactor';
      byCategory[cat].push(a);
    }

    if (byCategory.quickwin.length > 0) {
      lines.push('## Quick Wins');
      lines.push('');
      for (const a of byCategory.quickwin) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.refactor.length > 0) {
      lines.push('## Refactors');
      lines.push('');
      for (const a of byCategory.refactor) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.hygiene.length > 0) {
      lines.push('## Hygiene');
      lines.push('');
      for (const a of byCategory.hygiene) renderAction(lines, a);
      lines.push('');
    }
  }

  // Tests section (only in tests axis)
  if (axis === 'tests') {
    const testReviews = shard.files.filter((r) =>
      r.symbols.some((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE')),
    );
    if (testReviews.length > 0) {
      lines.push('## Test Improvements');
      lines.push('');
      for (const review of testReviews) {
        const testSymbols = review.symbols.filter((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE'));
        const noneSymbols = testSymbols.filter((s) => s.tests === 'NONE');
        const weakSymbols = testSymbols.filter((s) => s.tests === 'WEAK');
        const summary = [noneSymbols.length > 0 ? `${noneSymbols.length} untested` : '', weakSymbols.length > 0 ? `${weakSymbols.length} weak` : ''].filter(Boolean).join(', ');

        const extMatch = review.file.match(/(\.\w+)$/);
        const testFile = extMatch ? review.file.replace(extMatch[0], `.test${extMatch[0]}`) : `${review.file}.test.ts`;
        const hasTestFile = review.symbols.some((s) => s.tests === 'GOOD' || s.tests === 'WEAK');
        const action = hasTestFile ? `Improve \`${testFile}\`` : `Create \`${testFile}\``;

        lines.push(`- [ ] \`${review.file}\` — ${summary}`);
        lines.push(`  ${action} covering: ${testSymbols.map((s) => s.name).join(', ')}`);

        for (const s of weakSymbols) {
          lines.push(`  - ${s.name}: ${s.detail.replace(/^\[WEAK\]\s*/, '')}`);
        }
        lines.push('');
      }
    }
  }

  // Documentation Coverage section (only in documentation axis)
  if (axis === 'documentation') {
    const docReviews = shard.files.filter((r) =>
      r.docs_coverage?.concepts.some((c) => c.status !== 'COVERED'),
    );
    if (docReviews.length > 0) {
      lines.push('## Documentation Coverage');
      lines.push('');
      for (const review of docReviews) {
        const dc = review.docs_coverage;
        if (!dc) continue;
        const issues = dc.concepts.filter((c) => c.status !== 'COVERED');
        lines.push(`### \`${review.file}\` — ${dc.score_pct}% covered`);
        lines.push('');
        for (const c of issues) {
          const docRef = c.doc_path ? ` → \`${c.doc_path}\`` : '';
          lines.push(`- [ ] **${c.name}** — ${c.status}${docRef}: ${c.detail}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function axisShardHeader(axis: ReportAxisId): { columns: string; separator: string } {
  const name = axisDisplayName(axis);
  return {
    columns: `| File | Verdict | ${name} | Conf. | Details |`,
    separator: `|------|---------|${'-'.repeat(name.length + 2)}|-------|---------|`,
  };
}

function axisShardCount(axis: ReportAxisId, reliable: SymbolReview[]): string {
  switch (axis) {
    case 'correction':
      return String(reliable.filter((s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR').length);
    case 'utility':
      return String(reliable.filter((s) => s.utility === 'DEAD' || s.utility === 'LOW_VALUE').length);
    case 'duplication':
      return String(reliable.filter((s) => s.duplication === 'DUPLICATE').length);
    case 'overengineering':
      return String(reliable.filter((s) => s.overengineering === 'OVER').length);
    case 'tests':
      return String(reliable.filter((s) => s.tests === 'WEAK' || s.tests === 'NONE').length);
    case 'documentation':
      return String(reliable.filter((s) => s.documentation === 'PARTIAL' || (s.documentation === 'UNDOCUMENTED' && s.exported)).length);
    case 'best-practices':
      return '-';
  }
}

function hasAxisSymbolFinding(s: SymbolReview, axis: ReportAxisId): boolean {
  switch (axis) {
    case 'correction': return s.correction === 'NEEDS_FIX' || s.correction === 'ERROR';
    case 'utility': return s.utility === 'DEAD' || s.utility === 'LOW_VALUE';
    case 'duplication': return s.duplication === 'DUPLICATE';
    case 'overengineering': return s.overengineering === 'OVER';
    case 'tests': return s.tests === 'WEAK' || s.tests === 'NONE';
    case 'documentation': return s.documentation === 'PARTIAL' || (s.documentation === 'UNDOCUMENTED' && s.exported);
    case 'best-practices': return false;
  }
}

function axisSymbolValue(s: SymbolReview, axis: ReportAxisId): string {
  switch (axis) {
    case 'correction': return s.correction;
    case 'utility': return s.utility;
    case 'duplication': return s.duplication;
    case 'overengineering': return s.overengineering;
    case 'tests': return s.tests;
    case 'documentation': return s.documentation;
    case 'best-practices': return '-';
  }
}

// ---------------------------------------------------------------------------
// Render Axis Summary for master index (compact)
// ---------------------------------------------------------------------------

function renderAxisSummary(data: ReportData): string[] {
  const reliable = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));
  const totalSymbols = reliable.length;
  const minEvaluated = Math.max(1, Math.round(totalSymbols * 0.1));

  // Single-pass counting across all axes
  const counts = {
    utility: { USED: 0, DEAD: 0, LOW_VALUE: 0 },
    duplication: { UNIQUE: 0, DUPLICATE: 0 },
    correction: { OK: 0, NEEDS_FIX: 0, ERROR: 0 },
    overengineering: { LEAN: 0, ACCEPTABLE: 0, OVER: 0 },
    tests: { GOOD: 0, WEAK: 0, NONE: 0 },
    documentation: { DOCUMENTED: 0, PARTIAL: 0, UNDOCUMENTED: 0 },
  };
  for (const s of reliable) {
    if (s.utility in counts.utility) counts.utility[s.utility as keyof typeof counts.utility]++;
    if (s.duplication in counts.duplication) counts.duplication[s.duplication as keyof typeof counts.duplication]++;
    if (s.correction in counts.correction) counts.correction[s.correction as keyof typeof counts.correction]++;
    if (s.overengineering in counts.overengineering) counts.overengineering[s.overengineering as keyof typeof counts.overengineering]++;
    if (s.tests in counts.tests) counts.tests[s.tests as keyof typeof counts.tests]++;
    if (s.documentation in counts.documentation) counts.documentation[s.documentation as keyof typeof counts.documentation]++;
  }

  const lines: string[] = [];
  const axisSections: string[] = [];

  const renderAxis = (name: string, verdicts: { label: string; count: number }[]) => {
    const evalTotal = verdicts.reduce((sum, v) => sum + v.count, 0);
    if (evalTotal < minEvaluated) return;
    axisSections.push(`**${name}** — ${evalTotal} symbols evaluated`);
    axisSections.push('');
    axisSections.push('| Verdict | Count | % |');
    axisSections.push('|---------|-------|---|');
    for (const v of verdicts) {
      if (v.count > 0) {
        axisSections.push(`| ${v.label} | ${v.count} | ${((v.count / evalTotal) * 100).toFixed(0)}% |`);
      }
    }
    axisSections.push('');
  };

  renderAxis('Utility', [
    { label: 'USED', count: counts.utility.USED },
    { label: 'DEAD', count: counts.utility.DEAD },
    { label: 'LOW_VALUE', count: counts.utility.LOW_VALUE },
  ]);
  renderAxis('Duplication', [
    { label: 'UNIQUE', count: counts.duplication.UNIQUE },
    { label: 'DUPLICATE', count: counts.duplication.DUPLICATE },
  ]);
  renderAxis('Correction', [
    { label: 'OK', count: counts.correction.OK },
    { label: 'NEEDS_FIX', count: counts.correction.NEEDS_FIX },
    { label: 'ERROR', count: counts.correction.ERROR },
  ]);
  renderAxis('Overengineering', [
    { label: 'LEAN', count: counts.overengineering.LEAN },
    { label: 'ACCEPTABLE', count: counts.overengineering.ACCEPTABLE },
    { label: 'OVER', count: counts.overengineering.OVER },
  ]);
  renderAxis('Tests', [
    { label: 'GOOD', count: counts.tests.GOOD },
    { label: 'WEAK', count: counts.tests.WEAK },
    { label: 'NONE', count: counts.tests.NONE },
  ]);
  renderAxis('Documentation', [
    { label: 'DOCUMENTED', count: counts.documentation.DOCUMENTED },
    { label: 'PARTIAL', count: counts.documentation.PARTIAL },
    { label: 'UNDOCUMENTED', count: counts.documentation.UNDOCUMENTED },
  ]);

  // Best Practices (file-level, separate logic)
  const bpReviews = data.reviews.filter((r) => r.best_practices);
  if (bpReviews.length > 0) {
    const scores = bpReviews.map((r) => r.best_practices!.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    axisSections.push(`**Best Practices** — ${bpReviews.length} files evaluated`);
    axisSections.push('');
    axisSections.push('| Metric | Value |');
    axisSections.push('|--------|-------|');
    axisSections.push(`| Average score | ${avg.toFixed(1)}/10 |`);
    axisSections.push(`| Min / Max | ${min.toFixed(1)} / ${max.toFixed(1)} |`);
    axisSections.push('');
  }

  if (axisSections.length > 0) {
    lines.push('## Axis Summary');
    lines.push('');
    lines.push(...axisSections);
  }

  return lines;
}

/**
 * Render the Deliberation summary section.
 */
function renderDeliberationSummary(data: ReportData): string[] {
  const lines: string[] = [];
  const deliberated = data.reviews.filter((r) => r.deliberation);
  if (deliberated.length === 0) return lines;

  const totalReclassified = deliberated.reduce((sum, r) => sum + r.deliberation!.reclassified, 0);
  const totalActionsRemoved = deliberated.reduce((sum, r) => sum + r.deliberation!.actions_removed, 0);
  const verdictChanges = deliberated.filter((r) => r.deliberation!.verdict_before !== r.deliberation!.verdict_after);

  lines.push('## Deliberation');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Files deliberated | ${deliberated.length} |`);
  lines.push(`| Symbols reclassified | ${totalReclassified} |`);
  lines.push(`| Actions removed | ${totalActionsRemoved} |`);
  lines.push(`| Verdict changes | ${verdictChanges.length} |`);
  lines.push('');

  if (verdictChanges.length > 0) {
    lines.push('**Verdict changes:**');
    lines.push('');
    for (const r of verdictChanges) {
      lines.push(`- \`${r.file}\`: ${r.deliberation!.verdict_before} → ${r.deliberation!.verdict_after}`);
    }
    lines.push('');
  }

  if (totalReclassified > 0) {
    lines.push('**Reclassified files:**');
    lines.push('');
    for (const r of deliberated.filter((r) => r.deliberation!.reclassified > 0)) {
      lines.push(`- \`${r.file}\`: ${r.deliberation!.reclassified} symbol(s) — ${r.deliberation!.reasoning}`);
    }
    lines.push('');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Master index renderer
// ---------------------------------------------------------------------------

/**
 * Render the master index (report.md) — navigation hub pointing to per-axis reports.
 * @param data - Aggregated report data (verdicts, counts, actions).
 * @param axisReports - Per-axis reports used to render axis navigation links.
 * @param triageStats - Optional triage statistics (files scanned vs skipped).
 * @param runStats - Optional run-level timing, cost, and token statistics.
 * @param docReferenceSection - Optional markdown section listing referenced documentation.
 * @returns The full markdown string for the master report index page.
 */
export function renderIndex(data: ReportData, axisReports: AxisReport[], triageStats?: TriageStats, runStats?: RunStats, docReferenceSection?: string): string {
  const lines: string[] = [];

  lines.push('<p align="center">');
  lines.push('  <img src="https://raw.githubusercontent.com/r-via/anatoly/main/assets/imgs/logo.jpg" width="400" alt="Anatoly" />');
  lines.push('</p>');
  lines.push('');
  lines.push('# Anatoly Audit Report');
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- **Files reviewed:** ${data.totalFiles}`);
  lines.push(`- **Global verdict:** ${data.globalVerdict}`);
  lines.push(`- **Clean files:** ${data.cleanFiles.length}`);
  lines.push(`- **Files with findings:** ${data.findingFiles.length}`);
  if (data.errorFiles.length > 0) {
    lines.push(`- **Files in error:** ${data.errorFiles.length}`);
  }
  if (data.degradedFiles.length > 0) {
    lines.push(`- **Degraded reviews (axis crashes):** ${data.degradedFiles.length}`);
  }
  lines.push('');

  // Severity table
  const dc = data.counts.dead;
  const dup = data.counts.duplicate;
  const ov = data.counts.overengineering;
  const cor = data.counts.correction;
  const tst = data.counts.tests;
  const doc = data.counts.documentation;
  const bp = data.counts.best_practices;
  const totalDead = dc.high + dc.medium + dc.low;
  const totalDup = dup.high + dup.medium + dup.low;
  const totalOver = ov.high + ov.medium + ov.low;
  const totalCorr = cor.high + cor.medium + cor.low;
  const totalTests = tst.high + tst.medium + tst.low;
  const totalDocs = doc.high + doc.medium + doc.low;
  const totalBp = bp.high + bp.medium + bp.low;

  if (totalDead + totalDup + totalOver + totalCorr + totalTests + totalDocs + totalBp > 0) {
    lines.push('| Category | High | Medium | Low | Total |');
    lines.push('|----------|------|--------|-----|-------|');
    if (totalCorr > 0) lines.push(`| Correction errors | ${cor.high} | ${cor.medium} | ${cor.low} | ${totalCorr} |`);
    if (totalDead > 0) lines.push(`| Utility | ${dc.high} | ${dc.medium} | ${dc.low} | ${totalDead} |`);
    if (totalDup > 0) lines.push(`| Duplicates | ${dup.high} | ${dup.medium} | ${dup.low} | ${totalDup} |`);
    if (totalOver > 0) lines.push(`| Over-engineering | ${ov.high} | ${ov.medium} | ${ov.low} | ${totalOver} |`);
    if (totalTests > 0) lines.push(`| Test coverage gaps | ${tst.high} | ${tst.medium} | ${tst.low} | ${totalTests} |`);
    if (totalBp > 0) lines.push(`| Best practices | ${bp.high} | ${bp.medium} | ${bp.low} | ${totalBp} |`);
    if (totalDocs > 0) lines.push(`| Documentation gaps | ${doc.high} | ${doc.medium} | ${doc.low} | ${totalDocs} |`);
    lines.push('');
  }

  // Documentation Reference section (Epic 29)
  if (docReferenceSection) {
    lines.push(docReferenceSection);
    lines.push('');
  }

  // Axes navigation or "all clean"
  if (axisReports.length === 0) {
    lines.push('All files clean.');
    lines.push('');
  } else {
    lines.push('## Axes');
    lines.push('');
    lines.push('| Axis | Files | Shards | Link |');
    lines.push('|------|-------|--------|------|');
    for (const report of axisReports) {
      const name = axisDisplayName(report.axis);
      const link = `[axes/${report.axis}/index.md](./axes/${report.axis}/index.md)`;
      lines.push(`| ${name} | ${report.files.length} | ${report.shards.length} | ${link} |`);
    }
    lines.push('');
  }

  // Error files (compact)
  if (data.errorFiles.length > 0) {
    lines.push('## Files in Error');
    lines.push('');
    for (const f of data.errorFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // Degraded reviews (axis crashes produced incomplete results)
  if (data.degradedFiles.length > 0) {
    lines.push('## Degraded Reviews');
    lines.push('');
    lines.push('> One or more axis evaluators crashed for these files. Verdicts may be unreliable — re-run recommended.');
    lines.push('');
    for (const r of data.degradedFiles) {
      lines.push(`- \`${r.file}\``);
    }
    lines.push('');
  }

  // Performance & Triage section (only when triage was active)
  if (triageStats) {
    lines.push('## Performance & Triage');
    lines.push('');
    const skipPct = triageStats.total > 0 ? ((triageStats.skip / triageStats.total) * 100).toFixed(0) : '0';
    const evalPct = triageStats.total > 0 ? ((triageStats.evaluate / triageStats.total) * 100).toFixed(0) : '0';
    lines.push(`| Tier | Files | % |`);
    lines.push(`|------|-------|---|`);
    lines.push(`| Skip | ${triageStats.skip} | ${skipPct}% |`);
    lines.push(`| Evaluate | ${triageStats.evaluate} | ${evalPct}% |`);
    lines.push('');
    lines.push(`Estimated time saved: **${triageStats.estimatedTimeSaved.toFixed(1)} min**`);
    lines.push('');
  }

  // Run Statistics
  if (runStats) {
    lines.push('## Run Statistics');
    lines.push('');
    const durationMin = (runStats.durationMs / 60_000).toFixed(1);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Run ID | \`${runStats.runId}\` |`);
    lines.push(`| Duration | ${durationMin} min |`);
    lines.push(`| API cost | $${runStats.costUsd.toFixed(2)} |`);
    if (runStats.degradedReviews > 0) {
      lines.push(`| Degraded reviews | ${runStats.degradedReviews} |`);
    }
    lines.push('');

    // Phase durations
    const phases = Object.entries(runStats.phaseDurations);
    if (phases.length > 0) {
      lines.push('**Phase durations:**');
      lines.push('');
      lines.push('| Phase | Duration |');
      lines.push('|-------|----------|');
      for (const [phase, ms] of phases) {
        const dur = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        lines.push(`| ${phase} | ${dur} |`);
      }
      lines.push('');
    }

    // Per-axis stats
    const axes = Object.entries(runStats.axisStats);
    if (axes.length > 0) {
      lines.push('**Per-axis breakdown:**');
      lines.push('');
      lines.push('| Axis | Calls | Duration | Cost | Tokens (in/out) |');
      lines.push('|------|-------|----------|------|-----------------|');
      for (const [axisKey, s] of axes) {
        const dur = (s.totalDurationMs / 60000).toFixed(1);
        const totalIn = s.totalInputTokens;
        lines.push(`| ${axisKey} | ${s.calls} | ${dur}m | $${s.totalCostUsd.toFixed(2)} | ${totalIn} / ${s.totalOutputTokens} |`);
      }
      lines.push('');
    }
  }

  lines.push(...renderAxisSummary(data));
  lines.push(...renderDeliberationSummary(data));

  // --- Compact methodology reference (axis details are in per-axis indexes) ---
  lines.push('---');
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push('Each file is evaluated through 7 independent axis evaluators running in parallel.');
  lines.push('Every symbol (function, class, variable, type) is analysed individually and receives a rating per axis along with a confidence score (0–100).');
  lines.push('Findings with confidence < 30 are discarded; those with confidence < 60 are excluded from verdict computation.');
  lines.push('');
  lines.push('| Axis | Model | Ratings | Description |');
  lines.push('|------|-------|---------|-------------|');
  lines.push('| Utility | haiku | USED / DEAD / LOW_VALUE | Is this symbol actually used in the codebase? |');
  lines.push('| Duplication | haiku | UNIQUE / DUPLICATE | Is this symbol a copy of logic that exists elsewhere? |');
  lines.push('| Correction | sonnet | OK / NEEDS_FIX / ERROR | Does this symbol contain bugs or correctness issues? |');
  lines.push('| Overengineering | haiku | LEAN / OVER / ACCEPTABLE | Is the implementation unnecessarily complex? |');
  lines.push('| Tests | haiku | GOOD / WEAK / NONE | Does this symbol have adequate test coverage? |');
  lines.push('| Best Practices | sonnet | Score 0–10 (17 rules) | Does the file follow TypeScript best practices? |');
  lines.push('| Documentation | haiku | DOCUMENTED / PARTIAL / UNDOCUMENTED | Are exported symbols properly documented with JSDoc? |');
  lines.push('');
  lines.push('See each axis folder for detailed rating criteria and methodology.');
  lines.push('');
  lines.push('### Severity Classification');
  lines.push('');
  lines.push('- **High**: ERROR corrections, or NEEDS_FIX / DEAD / DUPLICATE with confidence >= 80%.');
  lines.push('- **Medium**: NEEDS_FIX / DEAD / DUPLICATE with confidence < 80%, or OVER (any confidence).');
  lines.push('- **Low**: LOW_VALUE utility or remaining minor findings.');
  lines.push('');
  lines.push('### Verdict Rules');
  lines.push('');
  lines.push('- **CLEAN**: No actionable findings with confidence >= 60%.');
  lines.push('- **NEEDS_REFACTOR**: At least one confirmed finding (DEAD, DUPLICATE, OVER, or NEEDS_FIX) with confidence >= 60%.');
  lines.push('- **CRITICAL**: At least one ERROR correction found.');
  lines.push('');
  lines.push('### Inter-axis Coherence');
  lines.push('');
  lines.push('After individual evaluation, coherence rules reconcile contradictions:');
  lines.push('');
  lines.push('- If utility = DEAD, tests is forced to NONE (no point testing dead code).');
  lines.push('- If utility = DEAD, documentation is forced to UNDOCUMENTED (no point documenting dead code).');
  lines.push('- If correction = ERROR, overengineering is forced to ACCEPTABLE (complexity is secondary to correctness).');
  lines.push('');

  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public report renderer (user-facing, polished)
// ---------------------------------------------------------------------------

/**
 * Compute a "health" percentage for an axis based on the "good" verdict ratio.
 */
function axisHealthPercent(data: ReportData, axis: ReportAxisId): { pct: number; label: string } {
  const reliable = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));

  switch (axis) {
    case 'correction': {
      const total = reliable.filter((s) => s.correction !== '-').length;
      const ok = reliable.filter((s) => s.correction === 'OK').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'OK' };
    }
    case 'utility': {
      const total = reliable.filter((s) => s.utility !== '-').length;
      const ok = reliable.filter((s) => s.utility === 'USED').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'used' };
    }
    case 'duplication': {
      const total = reliable.filter((s) => s.duplication !== '-').length;
      const ok = reliable.filter((s) => s.duplication === 'UNIQUE').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'unique' };
    }
    case 'overengineering': {
      const total = reliable.filter((s) => s.overengineering !== '-').length;
      const ok = reliable.filter((s) => s.overengineering === 'LEAN').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'lean' };
    }
    case 'tests': {
      const total = reliable.filter((s) => s.tests !== '-').length;
      const ok = reliable.filter((s) => s.tests === 'GOOD').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'covered' };
    }
    case 'documentation': {
      const total = reliable.filter((s) => s.documentation !== '-').length;
      const ok = reliable.filter((s) => s.documentation === 'DOCUMENTED').length;
      return { pct: total > 0 ? Math.round((ok / total) * 100) : 100, label: 'documented' };
    }
    case 'best-practices': {
      const bpReviews = data.reviews.filter((r) => r.best_practices);
      if (bpReviews.length === 0) return { pct: 100, label: '/ 10' };
      const avg = bpReviews.reduce((sum, r) => sum + r.best_practices!.score, 0) / bpReviews.length;
      return { pct: Math.round(avg * 10), label: `avg ${avg.toFixed(1)} / 10` };
    }
  }
}

/**
 * Build an ASCII health bar: `████████░░` (10 chars wide).
 */
function healthBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/**
 * Extract the correction-relevant snippet from a combined multi-axis detail string.
 * Looks for `[ERROR] ...` or `[NEEDS_FIX] ...` segments.
 */
function extractCorrectionDetail(detail: string, correction: string): string {
  // Try to find the tagged section: [ERROR] ... or [NEEDS_FIX] ...
  const tag = correction === 'ERROR' ? 'ERROR' : 'NEEDS_FIX';
  const regex = new RegExp(`\\[${tag}\\]\\s*(.+?)(?:\\s*\\||$)`);
  const match = detail.match(regex);
  if (match) return match[1].trim();

  // Fallback: take first sentence, stripping leading axis tags
  return detail.replace(/^\[.*?\]\s*/g, '').split(/\.\s/)[0].trim();
}

/**
 * Extract the top critical/high findings for the "Critical Findings" section.
 * Returns a sorted list of { file, symbol, detail } tuples.
 */
function extractTopFindings(data: ReportData, limit: number): Array<{ file: string; symbol: string; severity: 'high' | 'medium'; detail: string; correction: string }> {
  const findings: Array<{ file: string; symbol: string; severity: 'high' | 'medium'; detail: string; correction: string }> = [];

  for (const review of data.reviews) {
    for (const s of review.symbols.filter((sym) => sym.confidence >= 30)) {
      if (s.correction === 'ERROR') {
        const snippet = extractCorrectionDetail(s.detail, 'ERROR');
        findings.push({ file: review.file, symbol: s.name, severity: 'high', detail: snippet, correction: 'ERROR' });
      } else if (s.correction === 'NEEDS_FIX' && s.confidence >= 60) {
        const snippet = extractCorrectionDetail(s.detail, 'NEEDS_FIX');
        findings.push({ file: review.file, symbol: s.name, severity: s.confidence >= 80 ? 'high' : 'medium', detail: snippet, correction: 'NEEDS_FIX' });
      }
    }
  }

  // Sort: ERROR first, then high-confidence NEEDS_FIX
  findings.sort((a, b) => {
    if (a.correction === 'ERROR' && b.correction !== 'ERROR') return -1;
    if (b.correction === 'ERROR' && a.correction !== 'ERROR') return 1;
    if (a.severity === 'high' && b.severity !== 'high') return -1;
    if (b.severity === 'high' && a.severity !== 'high') return 1;
    return 0;
  });

  return findings.slice(0, limit);
}

/**
 * Render the public-facing report (public_report.md).
 * Designed for readability: hero block with value KPIs, health scorecard,
 * top findings, and compact run details in a cold zone.
 */
export function renderPublicIndex(data: ReportData, axisReports: AxisReport[], triageStats?: TriageStats, runStats?: RunStats, docReferenceSection?: string): string {
  const lines: string[] = [];

  // ── 1. HERO BLOCK ──────────────────────────────────────────────────────
  lines.push('<p align="center">');
  lines.push('  <img src="https://raw.githubusercontent.com/r-via/anatoly/main/assets/imgs/logo.jpg" width="400" alt="Anatoly" />');
  lines.push('</p>');
  lines.push('');
  lines.push('# Anatoly Audit Report');
  lines.push('');

  // Value one-liner
  const durationMin = runStats ? (runStats.durationMs / 60_000).toFixed(0) : '?';
  const costUsd = runStats ? `$${runStats.costUsd.toFixed(2)}` : '?';
  const findingCount = data.findingFiles.length;
  const errorSymbols = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30 && s.correction === 'ERROR'));

  lines.push(`> **${data.totalFiles} files** reviewed in **${durationMin} min** — **${costUsd}** in AI analysis so you don't have to.`);

  const verdictParts = [`Verdict: **${data.globalVerdict}**`];
  if (errorSymbols.length > 0) verdictParts.push(`${errorSymbols.length} critical bug${errorSymbols.length > 1 ? 's' : ''} found`);
  verdictParts.push(`${findingCount} file${findingCount !== 1 ? 's' : ''} with findings`);
  lines.push(`> ${verdictParts.join(' · ')}`);
  lines.push('');

  // ── 2. EXECUTIVE SUMMARY ───────────────────────────────────────────────
  const dc = data.counts.dead;
  const dup = data.counts.duplicate;
  const ov = data.counts.overengineering;
  const cor = data.counts.correction;
  const tst = data.counts.tests;
  const doc = data.counts.documentation;
  const bp = data.counts.best_practices;
  const totalDead = dc.high + dc.medium + dc.low;
  const totalDup = dup.high + dup.medium + dup.low;
  const totalOver = ov.high + ov.medium + ov.low;
  const totalCorr = cor.high + cor.medium + cor.low;
  const totalTests = tst.high + tst.medium + tst.low;
  const totalDocs = doc.high + doc.medium + doc.low;
  const totalBp = bp.high + bp.medium + bp.low;

  if (totalDead + totalDup + totalOver + totalCorr + totalTests + totalDocs + totalBp > 0) {
    lines.push('## Findings Summary');
    lines.push('');
    lines.push('| Category | High | Medium | Low | Total |');
    lines.push('|----------|------|--------|-----|-------|');
    if (totalCorr > 0) lines.push(`| Correction errors | ${cor.high} | ${cor.medium} | ${cor.low} | ${totalCorr} |`);
    if (totalDead > 0) lines.push(`| Dead code | ${dc.high} | ${dc.medium} | ${dc.low} | ${totalDead} |`);
    if (totalDup > 0) lines.push(`| Duplicates | ${dup.high} | ${dup.medium} | ${dup.low} | ${totalDup} |`);
    if (totalOver > 0) lines.push(`| Over-engineering | ${ov.high} | ${ov.medium} | ${ov.low} | ${totalOver} |`);
    if (totalTests > 0) lines.push(`| Test coverage gaps | ${tst.high} | ${tst.medium} | ${tst.low} | ${totalTests} |`);
    if (totalBp > 0) lines.push(`| Best practices | ${bp.high} | ${bp.medium} | ${bp.low} | ${totalBp} |`);
    if (totalDocs > 0) lines.push(`| Documentation gaps | ${doc.high} | ${doc.medium} | ${doc.low} | ${totalDocs} |`);
    lines.push('');
  }

  // ── 3. CRITICAL FINDINGS ───────────────────────────────────────────────
  const topFindings = extractTopFindings(data, 10);
  if (topFindings.length > 0) {
    lines.push('## Critical Findings');
    lines.push('');
    for (const f of topFindings) {
      const icon = f.correction === 'ERROR' ? '🔴' : '🟡';
      const oneLiner = f.detail.length > 120 ? f.detail.slice(0, 117) + '...' : f.detail;
      lines.push(`- ${icon} **${f.file}** \`${f.symbol}\` — ${oneLiner}`);
    }
    lines.push('');
  }

  // ── 4. AXES OVERVIEW (fused: navigation + health + findings) ───────────
  if (axisReports.length === 0) {
    lines.push('All files clean.');
    lines.push('');
  } else {
    lines.push('## Axes');
    lines.push('');
    lines.push('| Axis | Health | Findings | Details |');
    lines.push('|------|--------|----------|---------|');
    for (const report of axisReports) {
      const name = axisDisplayName(report.axis);
      const { pct, label } = axisHealthPercent(data, report.axis);
      const bar = healthBar(pct);
      const link = `[View →](./axes/${report.axis}/index.md)`;

      // Inline severity counts for this axis — map ReportAxisId to counts key
      const countsKeyMap: Record<ReportAxisId, keyof typeof data.counts> = {
        correction: 'correction',
        utility: 'dead',
        duplication: 'duplicate',
        overengineering: 'overengineering',
        tests: 'tests',
        documentation: 'documentation',
        'best-practices': 'best_practices',
      };
      const c = data.counts[countsKeyMap[report.axis]];
      const parts: string[] = [];
      if (c.high > 0) parts.push(`${c.high} high`);
      if (c.medium > 0) parts.push(`${c.medium} med`);
      if (c.low > 0) parts.push(`${c.low} low`);
      const findingsStr = parts.join(' · ') || '—';

      const healthLabel = report.axis === 'best-practices' ? `\`${bar}\` ${label}` : `\`${bar}\` ${pct}% ${label}`;
      lines.push(`| ${name} | ${healthLabel} | ${findingsStr} | ${link} |`);
    }
    lines.push('');
  }

  // ── 5. DOCUMENTATION REFERENCE ─────────────────────────────────────────
  if (docReferenceSection) {
    lines.push(docReferenceSection);
    lines.push('');
  }

  // ── 6. ERROR / DEGRADED FILES ──────────────────────────────────────────
  if (data.errorFiles.length > 0) {
    lines.push('## Files in Error');
    lines.push('');
    for (const f of data.errorFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }
  if (data.degradedFiles.length > 0) {
    lines.push('## Degraded Reviews');
    lines.push('');
    lines.push('> One or more axis evaluators crashed for these files. Verdicts may be unreliable — re-run recommended.');
    lines.push('');
    for (const r of data.degradedFiles) {
      lines.push(`- \`${r.file}\``);
    }
    lines.push('');
  }

  // ── 7. RUN DETAILS (cold zone) ────────────────────────────────────────
  if (runStats) {
    lines.push('---');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary><strong>Run Details</strong></summary>');
    lines.push('');
    const dMin = (runStats.durationMs / 60_000).toFixed(1);
    lines.push(`Run \`${runStats.runId}\` · ${dMin} min · $${runStats.costUsd.toFixed(2)}`);
    if (runStats.degradedReviews > 0) {
      lines.push(` · ${runStats.degradedReviews} degraded reviews`);
    }
    lines.push('');

    // Per-axis breakdown (the "proof")
    const axes = Object.entries(runStats.axisStats);
    if (axes.length > 0) {
      lines.push('| Axis | Calls | Duration | Cost | Tokens (in/out) |');
      lines.push('|------|-------|----------|------|-----------------|');
      for (const [axKey, s] of axes) {
        const dur = (s.totalDurationMs / 60000).toFixed(1);
        lines.push(`| ${axKey} | ${s.calls} | ${dur}m | $${s.totalCostUsd.toFixed(2)} | ${s.totalInputTokens} / ${s.totalOutputTokens} |`);
      }
      lines.push('');
    }

    // Phase durations
    const phases = Object.entries(runStats.phaseDurations);
    if (phases.length > 0) {
      lines.push('**Phase durations:**');
      lines.push('');
      lines.push('| Phase | Duration |');
      lines.push('|-------|----------|');
      for (const [phase, ms] of phases) {
        const dur = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        lines.push(`| ${phase} | ${dur} |`);
      }
      lines.push('');
    }

    lines.push('</details>');
    lines.push('');
  }

  // ── 8. METHODOLOGY (compact) ──────────────────────────────────────────
  lines.push('<details>');
  lines.push('<summary><strong>Methodology</strong></summary>');
  lines.push('');
  lines.push('Each file is evaluated through 7 independent axis evaluators running in parallel.');
  lines.push('Every symbol is analysed individually with a confidence score (0–100).');
  lines.push('Findings below 30% confidence are discarded; those below 60% are excluded from verdicts.');
  lines.push('');
  lines.push('**Verdicts:** CLEAN (no findings) · NEEDS_REFACTOR (confirmed findings) · CRITICAL (ERROR-level bugs)');
  lines.push('');
  lines.push('**Severity:** High = ERROR or high-confidence NEEDS_FIX/DEAD/DUPLICATE · Medium = lower confidence or OVER · Low = minor');
  lines.push('');
  lines.push('See each axis folder for detailed rating criteria.');
  lines.push('');
  lines.push('</details>');
  lines.push('');

  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Legacy API — renderShard kept for backward compatibility with tests
// ---------------------------------------------------------------------------

/**
 * Render a single shard (legacy flat format).
 * @deprecated Use renderAxisShard instead. Remove once clean-run is migrated to axis-based reports.
 */
export function renderShard(shard: ShardInfo): string {
  const lines: string[] = [];

  lines.push(`# Shard ${shard.index}`);
  lines.push('');

  // Findings table
  lines.push('## Findings');
  lines.push('');
  lines.push('| File | Verdict | Utility | Duplicate | Over Eng. | Errors | Tests | Doc | BP Score | Conf. | Details |');
  lines.push('|------|---------|---------|-----------|-----------|--------|-------|-----|----------|-------|---------|');

  const axisCount = (reliable: SymbolReview[], axis: keyof SymbolReview, ...values: string[]) => {
    const allSkipped = reliable.every((s) => s[axis] === '-');
    if (allSkipped) return '-';
    return String(reliable.filter((s) => values.includes(s[axis] as string)).length);
  };

  for (const review of shard.files) {
    const reliable = review.symbols.filter((s) => s.confidence >= 30);
    const dead = axisCount(reliable, 'utility', 'DEAD');
    const dupCount = axisCount(reliable, 'duplication', 'DUPLICATE');
    const over = axisCount(reliable, 'overengineering', 'OVER');
    const errors = axisCount(reliable, 'correction', 'NEEDS_FIX', 'ERROR');
    const testsCount = axisCount(reliable, 'tests', 'WEAK', 'NONE');
    const doc = axisCount(reliable, 'documentation', 'PARTIAL', 'UNDOCUMENTED');
    const bpScore = review.best_practices ? `${review.best_practices.score}/10` : '-';
    const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
    const outputName = toOutputName(review.file);
    const link = `[details](./reviews/${outputName}.rev.md)`;
    const fileVerdict = computeFileVerdict(review);
    lines.push(
      `| \`${review.file}\` | ${fileVerdict} | ${dead} | ${dupCount} | ${over} | ${errors} | ${testsCount} | ${doc} | ${bpScore} | ${maxConf}% | ${link} |`,
    );
  }
  lines.push('');

  // Symbol-level details
  const filesWithFindings = shard.files.filter((r) =>
    r.symbols.some((s) => s.confidence >= 30 && hasActionableIssue(s)),
  );
  if (filesWithFindings.length > 0) {
    lines.push('## Symbol Details');
    lines.push('');
    for (const review of filesWithFindings) {
      lines.push(`### \`${review.file}\``);
      lines.push('');
      lines.push('| Symbol | Lines | Correction | Utility | Duplication | Over-eng. | Tests | Doc | Conf. |');
      lines.push('|--------|-------|------------|---------|-------------|-----------|-------|-----|-------|');
      const actionable = review.symbols.filter((s) => s.confidence >= 30 && hasActionableIssue(s));
      for (const s of actionable) {
        lines.push(
          `| \`${s.name}\` | L${s.line_start}–L${s.line_end} | ${s.correction} | ${s.utility} | ${s.duplication} | ${s.overengineering} | ${s.tests} | ${s.documentation} | ${s.confidence}% |`,
        );
      }
      lines.push('');
    }
  }

  // Actions by category
  if (shard.actions.length > 0) {
    const byCategory: Record<Category, Array<Action & { file: string }>> = {
      quickwin: [],
      refactor: [],
      hygiene: [],
    };
    for (const a of shard.actions) {
      const cat = a.category ?? 'refactor';
      byCategory[cat].push(a);
    }

    if (byCategory.quickwin.length > 0) {
      lines.push('## Quick Wins');
      lines.push('');
      for (const a of byCategory.quickwin) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.refactor.length > 0) {
      lines.push('## Refactors');
      lines.push('');
      for (const a of byCategory.refactor) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.hygiene.length > 0) {
      lines.push('## Hygiene');
      lines.push('');
      for (const a of byCategory.hygiene) renderAction(lines, a);
      lines.push('');
    }
  }

  // Tests section
  const testReviews = shard.files.filter((r) =>
    r.symbols.some((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE')),
  );
  if (testReviews.length > 0) {
    lines.push('## Tests');
    lines.push('');
    for (const review of testReviews) {
      const testSymbols = review.symbols.filter((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE'));
      const noneSymbols = testSymbols.filter((s) => s.tests === 'NONE');
      const weakSymbols = testSymbols.filter((s) => s.tests === 'WEAK');
      const summary = [noneSymbols.length > 0 ? `${noneSymbols.length} untested` : '', weakSymbols.length > 0 ? `${weakSymbols.length} weak` : ''].filter(Boolean).join(', ');

      const extMatch = review.file.match(/(\.\w+)$/);
      const testFile = extMatch ? review.file.replace(extMatch[0], `.test${extMatch[0]}`) : `${review.file}.test.ts`;
      const hasTestFile = review.symbols.some((s) => s.tests === 'GOOD' || s.tests === 'WEAK');
      const action = hasTestFile ? `Improve \`${testFile}\`` : `Create \`${testFile}\``;

      lines.push(`- [ ] \`${review.file}\` — ${summary}`);
      lines.push(`  ${action} covering: ${testSymbols.map((s) => s.name).join(', ')}`);

      for (const s of weakSymbols) {
        lines.push(`  - ${s.name}: ${s.detail.replace(/^\[WEAK\]\s*/, '')}`);
      }
      lines.push('');
    }
  }

  // Documentation Coverage section
  const docReviews = shard.files.filter((r) =>
    r.docs_coverage?.concepts.some((c) => c.status !== 'COVERED'),
  );
  if (docReviews.length > 0) {
    lines.push('## Documentation Coverage');
    lines.push('');
    for (const review of docReviews) {
      const dc = review.docs_coverage;
      if (!dc) continue;
      const issues = dc.concepts.filter((c) => c.status !== 'COVERED');
      lines.push(`### \`${review.file}\` — ${dc.score_pct}% covered`);
      lines.push('');
      for (const c of issues) {
        const docRef = c.doc_path ? ` → \`${c.doc_path}\`` : '';
        lines.push(`- [ ] **${c.name}** — ${c.status}${docRef}: ${c.detail}`);
      }
      lines.push('');
    }
  }

  // Best Practices section
  const bpReviews = shard.files.filter((r) => r.best_practices && r.best_practices.suggestions.length > 0);
  if (bpReviews.length > 0) {
    lines.push('## Best Practices');
    lines.push('');
    for (const review of bpReviews) {
      const bp = review.best_practices!;
      lines.push(`### \`${review.file}\` — ${bp.score}/10`);
      lines.push('');
      for (const s of bp.suggestions) {
        lines.push(`- ${s.description}`);
        if (s.before && s.after) {
          lines.push(`  - Before: \`${s.before}\``);
          lines.push(`  - After: \`${s.after}\``);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generate report
// ---------------------------------------------------------------------------

/**
 * Generate the axis-based report: master index + per-axis folders with indexes and shards.
 * When runDir is provided, reads reviews from and writes report to the run directory.
 * @param projectRoot - Absolute path to the project root.
 * @param errorFiles - File paths that failed evaluation (included in the report as errors).
 * @param runDir - Optional run-scoped directory for reading reviews and writing the report.
 * @param triageStats - Optional triage statistics to include in the master index.
 * @param runStats - Optional run-level timing/cost statistics.
 * @param docReferenceSection - Optional markdown section for referenced documentation.
 * @returns An object with `reportPath`, aggregated `data`, legacy `shards`, and per-axis `axisReports`.
 */
export function generateReport(
  projectRoot: string,
  errorFiles?: string[],
  runDir?: string,
  triageStats?: TriageStats,
  runStats?: RunStats,
  docReferenceSection?: string,
): { reportPath: string; data: ReportData; shards: ShardInfo[]; axisReports: AxisReport[] } {
  const reviews = loadReviews(projectRoot, runDir);
  const data = aggregateReviews(reviews, errorFiles);
  const shards = buildShards(data);
  const axisReports = buildAxisReports(data);

  const baseDir = runDir ?? resolve(projectRoot, '.anatoly');
  const reportPath = join(baseDir, 'report.md');

  // Write master index (internal, full detail)
  writeFileSync(reportPath, renderIndex(data, axisReports, triageStats, runStats, docReferenceSection));

  // Write public report (user-facing, polished)
  const publicReportPath = join(baseDir, 'public_report.md');
  writeFileSync(publicReportPath, renderPublicIndex(data, axisReports, triageStats, runStats, docReferenceSection));

  // Write per-axis folders
  for (const report of axisReports) {
    const axisDir = join(baseDir, 'axes', report.axis);
    mkdirSync(axisDir, { recursive: true });

    // Write axis index
    writeFileSync(join(axisDir, 'index.md'), renderAxisIndex(report));

    // Write axis shards
    for (const shard of report.shards) {
      writeFileSync(join(axisDir, `shard.${shard.index}.md`), renderAxisShard(report.axis, shard));
    }
  }

  return { reportPath, data, shards, axisReports };
}
