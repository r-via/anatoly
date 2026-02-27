import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReviewFileSchema } from '../schemas/review.js';
import type { ReviewFile, Verdict, Action, SymbolReview, Category } from '../schemas/review.js';
import { toOutputName } from '../utils/cache.js';

export interface TriageStats {
  total: number;
  skip: number;
  evaluate: number;
  estimatedTimeSaved: number;
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
 * tests: NONE alone never triggers NEEDS_REFACTOR.
 * Low-confidence findings (< 60) are ignored for verdict purposes.
 */
export function computeFileVerdict(review: ReviewFile): Verdict {
  const symbols = review.symbols;

  if (symbols.some((s) => s.correction === 'ERROR' && s.confidence >= 60)) return 'CRITICAL';

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

function renderAction(lines: string[], a: Action & { file: string }): void {
  const effort = a.effort ?? 'small';
  const src = a.source ? `${a.source} · ` : '';
  const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
  const loc = a.target_lines ? ` [${a.target_lines}]` : '';
  lines.push(`- **[${src}${a.severity} · ${effort}]** \`${a.file}\`: ${a.description}${target}${loc}`);
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
  if (data.degradedFiles.length > 0) {
    lines.push(`- **Degraded reviews (axis crashes):** ${data.degradedFiles.length}`);
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
    if (totalDead > 0) lines.push(`| Utility | ${dc.high} | ${dc.medium} | ${dc.low} | ${totalDead} |`);
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

  // Methodology
  lines.push('## Methodology');
  lines.push('');
  lines.push('Each file is evaluated through 6 independent axis evaluators running in parallel.');
  lines.push('Every symbol (function, class, variable, type) is analysed individually and receives a rating per axis along with a confidence score (0–100).');
  lines.push('Findings with confidence < 30 are discarded; those with confidence < 60 are excluded from verdict computation.');
  lines.push('');
  lines.push('### Axis Reference');
  lines.push('');
  lines.push('| Axis | Model | Ratings | Description |');
  lines.push('|------|-------|---------|-------------|');
  lines.push('| Utility | haiku | USED / DEAD / LOW_VALUE | Is this symbol actually used in the codebase? |');
  lines.push('| Duplication | haiku | UNIQUE / DUPLICATE | Is this symbol a copy of logic that exists elsewhere? |');
  lines.push('| Correction | sonnet | OK / NEEDS_FIX / ERROR | Does this symbol contain bugs or correctness issues? |');
  lines.push('| Overengineering | haiku | LEAN / OVER / ACCEPTABLE | Is the implementation unnecessarily complex? |');
  lines.push('| Tests | haiku | GOOD / WEAK / NONE | Does this symbol have adequate test coverage? |');
  lines.push('| Best Practices | sonnet | Score 0–10 (17 rules) | Does the file follow TypeScript best practices? |');
  lines.push('');
  lines.push('### Rating Criteria');
  lines.push('');
  lines.push('**Utility** — Detects dead or low-value code using a pre-computed import/usage graph.');
  lines.push('');
  lines.push('- **USED**: The symbol is imported or referenced by at least one other file (exported) or used locally (non-exported).');
  lines.push('- **DEAD**: The symbol is exported but imported by 0 files, or is a non-exported symbol with no local references. Likely safe to remove.');
  lines.push('- **LOW_VALUE**: The symbol is used but provides negligible value (trivial wrapper, identity function, unnecessary indirection).');
  lines.push('');
  lines.push('**Duplication** — Identifies code clones via RAG semantic vector search against the codebase index.');
  lines.push('');
  lines.push('- **UNIQUE**: No semantically similar function found, or similarity score < 0.75.');
  lines.push('- **DUPLICATE**: Similarity score >= 0.85 with matching logic/behavior. The duplicate target file and symbol are reported.');
  lines.push('');
  lines.push('**Correction** — Finds bugs, logic errors, incorrect types, and unsafe operations. Only flags real correctness issues, not style.');
  lines.push('');
  lines.push('- **OK**: No bugs or correctness issues found.');
  lines.push('- **NEEDS_FIX**: A real bug, logic error, or type mismatch that would cause incorrect behavior at runtime.');
  lines.push('- **ERROR**: A critical bug that would cause a crash, data loss, or security breach.');
  lines.push('');
  lines.push('**Overengineering** — Evaluates whether complexity is justified by actual requirements.');
  lines.push('');
  lines.push('- **LEAN**: Implementation is minimal and appropriate for its purpose. A long function doing one thing well is still LEAN.');
  lines.push('- **OVER**: Unnecessary abstractions, premature generalization, factory patterns for single use, excessive configuration for simple behavior.');
  lines.push('- **ACCEPTABLE**: Some complexity present but justified by requirements.');
  lines.push('');
  lines.push('**Tests** — Assesses test coverage quality using coverage data (when available) and test file analysis.');
  lines.push('');
  lines.push('- **GOOD**: Meaningful unit tests covering happy path and edge cases.');
  lines.push('- **WEAK**: Tests exist but are superficial, missing edge cases, or testing implementation details rather than behavior.');
  lines.push('- **NONE**: No test file or test cases found for this symbol. Types/interfaces with no runtime behavior default to GOOD.');
  lines.push('');
  lines.push('**Best Practices** — File-level evaluation against 17 TypeGuard v2 rules. Starts at 10/10, penalties subtracted per violation:');
  lines.push('');
  lines.push('| # | Rule | Severity | Penalty |');
  lines.push('|---|------|----------|---------|');
  lines.push('| 1 | Strict mode (tsconfig strict: true) | HAUTE | -1 pt |');
  lines.push('| 2 | No `any` (explicit or implicit) | CRITIQUE | -3 pts |');
  lines.push('| 3 | Discriminated unions over type assertions | MOYENNE | -0.5 pt |');
  lines.push('| 4 | Utility types (Pick, Omit, Partial, Record) | MOYENNE | -0.5 pt |');
  lines.push('| 5 | Immutability (readonly, as const) | MOYENNE | -0.5 pt |');
  lines.push('| 6 | Interface vs Type consistency | MOYENNE | -0.5 pt |');
  lines.push('| 7 | File size < 300 lines | HAUTE | -1 pt |');
  lines.push('| 8 | ESLint compliance | HAUTE | -1 pt |');
  lines.push('| 9 | JSDoc on public exports | MOYENNE | -0.5 pt |');
  lines.push('| 10 | Modern 2026 practices | MOYENNE | -0.5 pt |');
  lines.push('| 11 | Import organization | MOYENNE | -0.5 pt |');
  lines.push('| 12 | Async/Promises/Error handling | HAUTE | -1 pt |');
  lines.push('| 13 | Security (no secrets, eval, injection) | CRITIQUE | -4 pts |');
  lines.push('| 14 | Performance (no N+1, sync I/O) | MOYENNE | -0.5 pt |');
  lines.push('| 15 | Testability (DI, low coupling) | MOYENNE | -0.5 pt |');
  lines.push('| 16 | TypeScript 5.5+ features | MOYENNE | -0.5 pt |');
  lines.push('| 17 | Context-adapted rules | MOYENNE | -0.5 pt |');
  lines.push('');
  lines.push('### Severity Classification');
  lines.push('');
  lines.push('Each finding is classified by severity:');
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
  lines.push('- If correction = ERROR, overengineering is forced to ACCEPTABLE (complexity is secondary to correctness).');
  lines.push('');

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
  lines.push('| File | Verdict | Utility | Duplicate | Over Engineered | Errors | BP Score | Confidence | Details |');
  lines.push('|------|---------|-----------|-----------|-----------------|--------|----------|------------|---------|');

  for (const review of shard.files) {
    const reliable = review.symbols.filter((s) => s.confidence >= 30);
    const dead = reliable.filter((s) => s.utility === 'DEAD').length;
    const dup = reliable.filter((s) => s.duplication === 'DUPLICATE').length;
    const over = reliable.filter((s) => s.overengineering === 'OVER').length;
    const errors = reliable.filter(
      (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
    ).length;
    const bpScore = review.best_practices ? `${review.best_practices.score}/10` : '-';
    const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
    const outputName = toOutputName(review.file);
    const link = `[details](./reviews/${outputName}.rev.md)`;
    const fileVerdict = computeFileVerdict(review);
    lines.push(
      `| \`${review.file}\` | ${fileVerdict} | ${dead} | ${dup} | ${over} | ${errors} | ${bpScore} | ${maxConf}% | ${link} |`,
    );
  }
  lines.push('');

  // Symbol-level details for files with findings
  const filesWithFindings = shard.files.filter((r) =>
    r.symbols.some((s) => s.confidence >= 30 && hasActionableIssue(s)),
  );
  if (filesWithFindings.length > 0) {
    lines.push('## Symbol Details');
    lines.push('');
    for (const review of filesWithFindings) {
      lines.push(`### \`${review.file}\``);
      lines.push('');
      lines.push('| Symbol | Lines | Correction | Utility | Duplication | Over-eng. | Tests | Conf. |');
      lines.push('|--------|-------|------------|---------|-------------|-----------|-------|-------|');
      const actionable = review.symbols.filter((s) => s.confidence >= 30 && hasActionableIssue(s));
      for (const s of actionable) {
        lines.push(
          `| \`${s.name}\` | L${s.line_start}–L${s.line_end} | ${s.correction} | ${s.utility} | ${s.duplication} | ${s.overengineering} | ${s.tests} | ${s.confidence}% |`,
        );
      }
      lines.push('');
    }
  }

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

  // Best Practices section — rendered from review data, not actions
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
