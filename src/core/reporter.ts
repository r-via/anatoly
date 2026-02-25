import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReviewFileSchema } from '../schemas/review.js';
import type { ReviewFile, Verdict, Action, SymbolReview, Category } from '../schemas/review.js';
import { toOutputName } from '../utils/cache.js';

export interface TriageStats {
  total: number;
  skip: number;
  fast: number;
  deep: number;
  estimatedTimeSaved: number;
}

export interface ReportData {
  reviews: ReviewFile[];
  globalVerdict: Verdict;
  totalFiles: number;
  cleanFiles: ReviewFile[];
  findingFiles: ReviewFile[];
  errorFiles: string[];
  counts: {
    dead: { high: number; medium: number; low: number };
    duplicate: { high: number; medium: number; low: number };
    overengineering: { high: number; medium: number; low: number };
    correction: { high: number; medium: number; low: number };
  };
  actions: Array<Action & { file: string }>;
}

/**
 * Load all .rev.json files from a reviews directory.
 * When runDir is provided, reads from the run-scoped reviews directory.
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
 * Determine if a symbol has an actionable issue (excluding tests-only).
 */
function hasActionableIssue(s: SymbolReview): boolean {
  return (
    s.correction === 'NEEDS_FIX' ||
    s.correction === 'ERROR' ||
    s.utility === 'DEAD' ||
    s.duplication === 'DUPLICATE' ||
    s.overengineering === 'OVER'
  );
}

/**
 * Recompute file verdict from symbols — standardizes the LLM's verdict.
 * tests: NONE alone never triggers NEEDS_REFACTOR.
 * Low-confidence findings (< 60) are ignored for verdict purposes.
 */
export function computeFileVerdict(review: ReviewFile): Verdict {
  const symbols = review.symbols;

  if (symbols.some((s) => s.correction === 'ERROR')) return 'CRITICAL';

  const hasConfirmedIssue = symbols.some(
    (s) => s.confidence >= 60 && hasActionableIssue(s),
  );

  return hasConfirmedIssue ? 'NEEDS_REFACTOR' : 'CLEAN';
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
 * tests: NONE/WEAK is hygiene, not a severity finding.
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
 */
export function aggregateReviews(reviews: ReviewFile[], errorFiles?: string[]): ReportData {
  const counts = {
    dead: { high: 0, medium: 0, low: 0 },
    duplicate: { high: 0, medium: 0, low: 0 },
    overengineering: { high: 0, medium: 0, low: 0 },
    correction: { high: 0, medium: 0, low: 0 },
  };

  const allActions: Array<Action & { file: string }> = [];

  for (const review of reviews) {
    for (const s of review.symbols) {
      if (s.confidence < 30) continue; // Skip unreliable findings
      const sev = symbolSeverity(s);
      if (s.utility === 'DEAD') counts.dead[sev]++;
      if (s.duplication === 'DUPLICATE') counts.duplicate[sev]++;
      if (s.overengineering === 'OVER') counts.overengineering[sev]++;
      if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') counts.correction[sev]++;
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

  return {
    reviews,
    globalVerdict: computeGlobalVerdict(reviews),
    totalFiles: reviews.length,
    cleanFiles,
    findingFiles,
    errorFiles: errorFiles ?? [],
    counts,
    actions: allActions,
  };
}

function renderAction(lines: string[], a: Action & { file: string }): void {
  const effort = a.effort ?? 'small';
  const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
  const loc = a.target_lines ? ` [${a.target_lines}]` : '';
  lines.push(`- **[${a.severity} · ${effort}]** \`${a.file}\`: ${a.description}${target}${loc}`);
}

const SHARD_SIZE = 10;

/**
 * Sort finding files: CRITICAL first, then NEEDS_REFACTOR, then by finding
 * count descending, then by max confidence descending.
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

/**
 * Render the compact index (report.md) — always < ~100 lines.
 */
export function renderIndex(data: ReportData, shards: ShardInfo[], triageStats?: TriageStats): string {
  const lines: string[] = [];

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
  lines.push('');

  // Severity table
  const dc = data.counts.dead;
  const dup = data.counts.duplicate;
  const ov = data.counts.overengineering;
  const cor = data.counts.correction;
  const totalDead = dc.high + dc.medium + dc.low;
  const totalDup = dup.high + dup.medium + dup.low;
  const totalOver = ov.high + ov.medium + ov.low;
  const totalCorr = cor.high + cor.medium + cor.low;

  if (totalDead + totalDup + totalOver + totalCorr > 0) {
    lines.push('| Category | High | Medium | Low | Total |');
    lines.push('|----------|------|--------|-----|-------|');
    if (totalCorr > 0) lines.push(`| Correction errors | ${cor.high} | ${cor.medium} | ${cor.low} | ${totalCorr} |`);
    if (totalDead > 0) lines.push(`| Dead code | ${dc.high} | ${dc.medium} | ${dc.low} | ${totalDead} |`);
    if (totalDup > 0) lines.push(`| Duplicates | ${dup.high} | ${dup.medium} | ${dup.low} | ${totalDup} |`);
    if (totalOver > 0) lines.push(`| Over-engineering | ${ov.high} | ${ov.medium} | ${ov.low} | ${totalOver} |`);
    lines.push('');
  }

  // Shards or "all clean"
  if (shards.length === 0) {
    lines.push('All files clean.');
    lines.push('');
  } else {
    lines.push('## Shards');
    lines.push('');
    for (const shard of shards) {
      const composition: string[] = [];
      if (shard.criticalCount > 0) composition.push(`${shard.criticalCount} CRITICAL`);
      if (shard.refactorCount > 0) composition.push(`${shard.refactorCount} NEEDS_REFACTOR`);
      const desc = composition.length > 0 ? ` — ${composition.join(', ')}` : '';
      lines.push(`- [ ] [report.${shard.index}.md](./report.${shard.index}.md) (${shard.files.length} files${desc})`);
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

  // Performance & Triage section (only when triage was active)
  if (triageStats) {
    lines.push('## Performance & Triage');
    lines.push('');
    const skipPct = triageStats.total > 0 ? ((triageStats.skip / triageStats.total) * 100).toFixed(0) : '0';
    const fastPct = triageStats.total > 0 ? ((triageStats.fast / triageStats.total) * 100).toFixed(0) : '0';
    const deepPct = triageStats.total > 0 ? ((triageStats.deep / triageStats.total) * 100).toFixed(0) : '0';
    lines.push(`| Tier | Files | % |`);
    lines.push(`|------|-------|---|`);
    lines.push(`| Skip | ${triageStats.skip} | ${skipPct}% |`);
    lines.push(`| Fast | ${triageStats.fast} | ${fastPct}% |`);
    lines.push(`| Deep | ${triageStats.deep} | ${deepPct}% |`);
    lines.push('');
    lines.push(`Estimated time saved: **${triageStats.estimatedTimeSaved.toFixed(1)} min**`);
    lines.push('');
  }

  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Render a single shard (report.N.md) — findings + actions scoped to shard files.
 */
export function renderShard(shard: ShardInfo): string {
  const lines: string[] = [];

  lines.push(`# Shard ${shard.index}`);
  lines.push('');

  // Findings table
  lines.push('## Findings');
  lines.push('');
  lines.push('| File | Verdict | Dead Code | Duplicate | Over Engineered | Errors | Confidence | Details |');
  lines.push('|------|---------|-----------|-----------|-----------------|--------|------------|---------|');

  for (const review of shard.files) {
    const reliable = review.symbols.filter((s) => s.confidence >= 30);
    const dead = reliable.filter((s) => s.utility === 'DEAD').length;
    const dup = reliable.filter((s) => s.duplication === 'DUPLICATE').length;
    const over = reliable.filter((s) => s.overengineering === 'OVER').length;
    const errors = reliable.filter(
      (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
    ).length;
    const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
    const outputName = toOutputName(review.file);
    const link = `[details](./reviews/${outputName}.rev.md)`;
    const fileVerdict = computeFileVerdict(review);
    lines.push(
      `| \`${review.file}\` | ${fileVerdict} | ${dead} | ${dup} | ${over} | ${errors} | ${maxConf}% | ${link} |`,
    );
  }
  lines.push('');

  // Actions by category (scoped to shard)
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

  return lines.join('\n');
}


/**
 * Generate the sharded report: index (report.md) + shards (report.N.md).
 * When runDir is provided, reads reviews from and writes report to the run directory.
 * Returns the path to the index (always report.md) and the report data.
 */
export function generateReport(
  projectRoot: string,
  errorFiles?: string[],
  runDir?: string,
  triageStats?: TriageStats,
): { reportPath: string; data: ReportData } {
  const reviews = loadReviews(projectRoot, runDir);
  const data = aggregateReviews(reviews, errorFiles);
  const shards = buildShards(data);

  const baseDir = runDir ?? resolve(projectRoot, '.anatoly');
  const reportPath = join(baseDir, 'report.md');

  // Write index
  writeFileSync(reportPath, renderIndex(data, shards, triageStats));

  // Write shards
  for (const shard of shards) {
    writeFileSync(join(baseDir, `report.${shard.index}.md`), renderShard(shard));
  }

  return { reportPath, data };
}
