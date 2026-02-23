import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReviewFileSchema } from '../schemas/review.js';
import type { ReviewFile, Verdict, Action, SymbolReview } from '../schemas/review.js';
import { toOutputName } from '../utils/cache.js';

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
 * Load all .rev.json files from .anatoly/reviews/ and parse them.
 */
export function loadReviews(projectRoot: string): ReviewFile[] {
  const reviewsDir = resolve(projectRoot, '.anatoly', 'reviews');
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
 * Compute the global verdict from all file verdicts.
 * - All CLEAN → CLEAN
 * - Any CRITICAL → CRITICAL
 * - Otherwise → NEEDS_REFACTOR
 */
export function computeGlobalVerdict(reviews: ReviewFile[]): Verdict {
  if (reviews.length === 0) return 'CLEAN';
  if (reviews.some((r) => r.verdict === 'CRITICAL')) return 'CRITICAL';
  if (reviews.some((r) => r.verdict === 'NEEDS_REFACTOR')) return 'NEEDS_REFACTOR';
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
  if (s.tests === 'NONE' || s.tests === 'WEAK') return 'low';
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

  const cleanFiles = reviews.filter((r) => r.verdict === 'CLEAN');
  const findingFiles = reviews.filter((r) => r.verdict !== 'CLEAN');

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

/**
 * Render the full report as structured Markdown.
 */
export function renderReport(data: ReportData): string {
  const lines: string[] = [];

  // Title
  lines.push('# Anatoly Audit Report');
  lines.push('');

  // Executive summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- **Files reviewed:** ${data.totalFiles}`);
  lines.push(`- **Global verdict:** ${data.globalVerdict}`);
  lines.push('');

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

  lines.push(`- **Clean files:** ${data.cleanFiles.length}`);
  if (data.errorFiles.length > 0) {
    lines.push(`- **Files in error:** ${data.errorFiles.length}`);
  }
  lines.push('');

  // Findings table
  if (data.findingFiles.length > 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('| File | Verdict | Dead Code | Duplicate | Over Engineered | Errors | Confidence | Details |');
    lines.push('|------|---------|-----------|-----------|-----------------|--------|------------|---------|');

    // Sort: CRITICAL first, then NEEDS_REFACTOR
    const sorted = [...data.findingFiles].sort((a, b) => {
      const vOrder = { CRITICAL: 0, NEEDS_REFACTOR: 1, CLEAN: 2 };
      const vDiff = vOrder[a.verdict] - vOrder[b.verdict];
      if (vDiff !== 0) return vDiff;
      // Then by max confidence descending
      const confA = Math.max(...a.symbols.map((s) => s.confidence), 0);
      const confB = Math.max(...b.symbols.map((s) => s.confidence), 0);
      return confB - confA;
    });

    for (const review of sorted) {
      const dead = review.symbols.filter((s) => s.utility === 'DEAD').length;
      const dup = review.symbols.filter((s) => s.duplication === 'DUPLICATE').length;
      const over = review.symbols.filter((s) => s.overengineering === 'OVER').length;
      const errors = review.symbols.filter(
        (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
      ).length;
      const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
      const outputName = toOutputName(review.file);
      const link = `[details](./reviews/${outputName}.rev.md)`;

      lines.push(
        `| \`${review.file}\` | ${review.verdict} | ${dead} | ${dup} | ${over} | ${errors} | ${maxConf}% | ${link} |`,
      );
    }
    lines.push('');
  }

  // Actions
  if (data.actions.length > 0) {
    lines.push('## Recommended Actions');
    lines.push('');
    for (const a of data.actions) {
      const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
      const loc = a.target_lines ? ` [${a.target_lines}]` : '';
      lines.push(`- **[${a.severity}]** \`${a.file}\`: ${a.description}${target}${loc}`);
    }
    lines.push('');
  }

  // Clean files
  if (data.cleanFiles.length > 0) {
    lines.push('## Clean Files');
    lines.push('');
    for (const review of data.cleanFiles) {
      lines.push(`- \`${review.file}\``);
    }
    lines.push('');
  }

  // Error files
  if (data.errorFiles.length > 0) {
    lines.push('## Files in Error');
    lines.push('');
    for (const f of data.errorFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // Metadata
  lines.push('## Metadata');
  lines.push('');
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **Version:** 1`);
  lines.push('');
  lines.push('### Methodology');
  lines.push('');
  lines.push('Each symbol (function, class, type, constant, etc.) extracted via AST parsing is evaluated by an LLM agent against 5 axes:');
  lines.push('');
  lines.push('| Axis | Column | Values | Method |');
  lines.push('|------|--------|--------|--------|');
  lines.push('| Correction | Errors | OK / NEEDS_FIX / ERROR | Agent reads the source code and identifies bugs, logic errors, type mismatches, and incorrect behavior. |');
  lines.push('| Utility | Dead Code | USED / DEAD / LOW_VALUE | Agent uses Grep to search the entire project for imports and usages of each exported symbol. Zero matches = DEAD. |');
  lines.push('| Duplication | Duplicate | UNIQUE / DUPLICATE | Agent reads candidate files and compares implementations. Near-identical logic (>80% similarity) = DUPLICATE, with the target file and symbol recorded. |');
  lines.push('| Over-engineering | Over Engineered | LEAN / OVER / ACCEPTABLE | Agent assesses whether abstractions, generics, or patterns are justified by actual usage. Unnecessary complexity = OVER. |');
  lines.push('| Tests | — | GOOD / WEAK / NONE | Agent checks test coverage data (when available) and inspects test files to evaluate quality and completeness. |');
  lines.push('');
  lines.push('**Confidence** (0–100%) reflects how much tool-verified evidence supports the assessment. 100% = fully verified with Grep/Read; <70% = uncertain, needs investigation.');
  lines.push('');
  lines.push('**Severity** is derived from axis values and confidence: high = confirmed issues (confidence ≥80%), medium = likely issues, low = minor concerns or missing tests.');
  lines.push('');
  lines.push('**Verdict** per file: CRITICAL (any ERROR), NEEDS_REFACTOR (any issues), CLEAN (all healthy). Global verdict is the worst across all files.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate the full report: load reviews, aggregate, write report.md.
 * Returns the path to the generated report and the report data.
 */
export function generateReport(
  projectRoot: string,
  errorFiles?: string[],
): { reportPath: string; data: ReportData } {
  const reviews = loadReviews(projectRoot);
  const data = aggregateReviews(reviews, errorFiles);
  const markdown = renderReport(data);

  const reportPath = resolve(projectRoot, '.anatoly', 'report.md');
  writeFileSync(reportPath, markdown);

  return { reportPath, data };
}
