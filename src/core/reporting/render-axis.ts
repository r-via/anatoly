// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import type { ReviewFile, Action, SymbolReview, Category } from '../../schemas/review.js';
import { computeFileVerdict } from './review-data.js';
import type { ShardInfo } from './review-data.js';
import {
  axisDisplayName, axisEmoji, axisIntro, axisModel,
  docCommentTerm, derivePrimaryLanguage, hasAxisFinding,
} from './axis-registry.js';
import type { ReportAxisId, AxisReport } from './axis-registry.js';

// ---------------------------------------------------------------------------
// Verdict emoji
// ---------------------------------------------------------------------------

export function verdictEmoji(verdict: string): string {
  switch (verdict) {
    // Critical / bad
    case 'CRITICAL': case 'ERROR': case 'DEAD': case 'DUPLICATE': case 'OVER': case 'NONE': case 'UNDOCUMENTED': return '🔴';
    // Warning / partial
    case 'NEEDS_REFACTOR': case 'NEEDS_FIX': case 'LOW_VALUE': case 'WEAK': case 'PARTIAL': case 'ACCEPTABLE': return '🟡';
    // Good
    case 'CLEAN': case 'OK': case 'USED': case 'UNIQUE': case 'LEAN': case 'GOOD': case 'DOCUMENTED': return '🟢';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Health bar
// ---------------------------------------------------------------------------

/**
 * Build an emoji health bar: 🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜ (10 squares, color by pct).
 *
 * When `highFindings` and `totalFiles` are provided, the color is degraded
 * based on the high-finding DENSITY (ratio of high findings to codebase size),
 * so the thresholds scale with project size:
 *
 * - density >= 15% → red regardless of pct
 * - density >= 3%  → cap at yellow
 * - density > 0%   → green only if pct >= 95%
 * - density = 0%   → pure percentage-based coloring
 */
export function healthBar(pct: number, highFindings = 0, totalFiles = 0): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const density = totalFiles > 0 ? highFindings / totalFiles : highFindings > 0 ? 1 : 0;
  let square: string;
  if (density >= 0.15) {
    square = '🟥';
  } else if (density >= 0.03) {
    square = pct >= 50 ? '🟨' : '🟥';
  } else if (density > 0) {
    square = pct >= 95 ? '🟩' : pct >= 50 ? '🟨' : '🟥';
  } else {
    square = pct >= 80 ? '🟩' : pct >= 50 ? '🟨' : '🟥';
  }
  return square.repeat(filled) + '⬜'.repeat(10 - filled);
}

// ---------------------------------------------------------------------------
// Action rendering
// ---------------------------------------------------------------------------

/**
 * Convert a file path to a GitHub-compatible heading anchor.
 * Matches GitHub's algorithm: lowercase, strip non-alphanumeric (except hyphens), replace spaces with hyphens.
 * Used for axis shard "details" links that anchor to ### `file/path.rs` headings.
 */
export function fileToAnchor(filePath: string): string {
  return filePath
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

/**
 * Generate a deterministic action ID for checkbox matching.
 * Format: ACT-{6-char file hash}-{action id}
 */
export function makeActId(file: string, actionId: number): string {
  const hash = createHash('sha256').update(file).digest('hex').slice(0, 6);
  return `ACT-${hash}-${actionId}`;
}

/**
 * Normalize category and effort for correction actions based on severity.
 * Correction axis historically hardcoded everything as quickwin/small;
 * this remaps at render time so cached .rev.json files are also handled.
 */
function normalizeAction(a: Action & { file: string }): Action & { file: string } {
  if (a.source !== 'correction') return a;
  switch (a.severity) {
    case 'high':   return { ...a, effort: 'large',   category: 'refactor' };
    case 'low':    return { ...a, effort: 'trivial',  category: 'hygiene' };
    default:       return { ...a, effort: 'small',    category: 'quickwin' };
  }
}

function renderAction(lines: string[], raw: Action & { file: string }): void {
  const a = normalizeAction(raw);
  const effort = a.effort ?? 'small';
  const src = a.source ? `${a.source} · ` : '';
  const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
  const loc = a.target_lines ? ` [${a.target_lines}]` : '';
  const actId = makeActId(a.file, a.id);
  lines.push(`- [ ] <!-- ${actId} --> **[${src}${a.severity} · ${effort}]** \`${a.file}\`: ${a.description}${target}${loc}`);
}

// ---------------------------------------------------------------------------
// Verdict distribution table helpers
// ---------------------------------------------------------------------------

const SYMBOL_AXIS_LABELS = {
  utility: { field: 'utility', labels: ['USED', 'DEAD', 'LOW_VALUE'] as const },
  duplication: { field: 'duplication', labels: ['UNIQUE', 'DUPLICATE'] as const },
  correction: { field: 'correction', labels: ['OK', 'NEEDS_FIX', 'ERROR'] as const },
  overengineering: { field: 'overengineering', labels: ['LEAN', 'ACCEPTABLE', 'OVER'] as const },
  tests: { field: 'tests', labels: ['GOOD', 'WEAK', 'NONE'] as const },
  documentation: { field: 'documentation', labels: ['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED'] as const },
} as const satisfies Partial<Record<ReportAxisId, { field: keyof SymbolReview; labels: readonly string[] }>>;

function renderVerdictCountTable(
  lines: string[],
  reliable: SymbolReview[],
  field: keyof SymbolReview,
  labels: readonly string[],
): void {
  const counts = labels.map((label) => ({
    label,
    count: reliable.filter((s) => s[field] === label).length,
  }));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return;
  lines.push('| Verdict | Count | % |');
  lines.push('|---------|-------|---|');
  for (const { label, count } of counts) {
    if (count > 0) lines.push(`| ${label} | ${count} | ${((count / total) * 100).toFixed(0)}% |`);
  }
  lines.push('');
}

function renderAxisVerdictDistribution(report: AxisReport): string[] {
  const lines: string[] = [];
  const reliable = report.files.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));
  if (reliable.length === 0) return lines;

  lines.push('## 📈 Verdict Distribution');
  lines.push('');

  if (report.axis === 'best-practices') {
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
    return lines;
  }

  const spec = SYMBOL_AXIS_LABELS[report.axis as keyof typeof SYMBOL_AXIS_LABELS];
  if (spec) renderVerdictCountTable(lines, reliable, spec.field, spec.labels);
  return lines;
}

// ---------------------------------------------------------------------------
// Axis shard detail helpers
// ---------------------------------------------------------------------------

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

export function hasAxisSymbolFinding(s: SymbolReview, axis: ReportAxisId): boolean {
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

export function axisSymbolValue(s: SymbolReview, axis: ReportAxisId): string {
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

function axisAllValues(axis: ReportAxisId): string[] {
  switch (axis) {
    case 'correction': return ['OK', 'NEEDS_FIX', 'ERROR'];
    case 'utility': return ['USED', 'DEAD', 'LOW_VALUE'];
    case 'duplication': return ['UNIQUE', 'DUPLICATE'];
    case 'overengineering': return ['LEAN', 'OVER', 'ACCEPTABLE'];
    case 'tests': return ['GOOD', 'WEAK', 'NONE'];
    case 'documentation': return ['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED'];
    case 'best-practices': return [];
  }
}

/**
 * Extract the detail segment for a specific axis from the pipe-delimited merged detail string.
 * The format is `[VALUE] text | [VALUE] text | ...`. We find the segment whose [VALUE] tag
 * matches the axis verdict for this symbol and strip the tag prefix.
 */
export function axisDetail(s: SymbolReview, axis: ReportAxisId): string {
  const value = axisSymbolValue(s, axis);
  const segments = s.detail.split(' | ');
  const tag = `[${value}] `;
  const match = segments.find((seg) => seg.startsWith(tag));
  if (match) return match.slice(tag.length);
  // Fallback: try matching any segment that starts with a known verdict for this axis
  const allValues = axisAllValues(axis);
  for (const seg of segments) {
    for (const v of allValues) {
      if (seg.startsWith(`[${v}] `)) return seg.slice(v.length + 3);
    }
  }
  return s.detail;
}

// ---------------------------------------------------------------------------
// Axis methodology renderer
// ---------------------------------------------------------------------------

function renderAxisMethodology(axis: ReportAxisId, language?: string): string[] {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('## 📖 Methodology');
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

    case 'documentation': {
      const docTerm = docCommentTerm(language);
      lines.push(`Evaluates ${docTerm} coverage on exported symbols and optional /docs/ concept coverage.`);
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push(`- **DOCUMENTED**: Symbol has a complete ${docTerm} covering description, params, and return type.`);
      lines.push(`- **PARTIAL**: ${docTerm} exists but is incomplete (missing params, outdated description, or lacking return type).`);
      lines.push(`- **UNDOCUMENTED**: No ${docTerm} found for an exported symbol. Types and interfaces default to DOCUMENTED.`);
      break;
    }

    case 'best-practices': {
      const bpLabel = language === 'rust' ? 'Rust' : language === 'python' ? 'Python' : language === 'go' ? 'Go' : 'TypeScript';
      lines.push(`File-level evaluation against language-specific ${bpLabel} best-practice rules. Starts at 10/10, penalties subtracted per violation.`);
      lines.push('');
      lines.push('### Rating Criteria');
      lines.push('');
      lines.push('Files are scored on a 0–10 scale. A score below 7 triggers a NEEDS_REFACTOR verdict.');
      lines.push('The score reflects adherence to language-specific conventions: naming, error handling, type safety, and code organisation.');
      break;
    }
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
export function renderAxisIndex(report: AxisReport, allReviews?: ReviewFile[]): string {
  const lines: string[] = [];
  const name = axisDisplayName(report.axis);

  const emoji = axisEmoji(report.axis);

  lines.push(`[← Back to report](../../public_report.md)`);
  lines.push('');
  lines.push(`# ${emoji} ${name}`);
  lines.push('');
  lines.push(`> ${axisIntro(report.axis)}`);
  lines.push('');

  // Stats
  lines.push(`- 📁 **Files with findings:** ${report.files.length}`);
  lines.push(`- 🎯 **Actions:** ${report.actions.length}`);
  lines.push('');

  // Shard links
  if (report.shards.length > 0) {
    lines.push('## 📦 Shards');
    lines.push('');
    lines.push('Findings are split into shards of up to 10 files each to keep pages readable and avoid GitHub rendering limits.');
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
  lines.push(...renderAxisMethodology(report.axis, derivePrimaryLanguage(allReviews ?? report.files)));

  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
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

  const emoji = axisEmoji(axis);

  lines.push(`[← Back to ${name}](./index.md) · [← Back to report](../../public_report.md)`);
  lines.push('');
  lines.push(`# ${emoji} ${name} — Shard ${shard.index}`);
  lines.push('');

  // Build TOC based on which sections will be present
  const tocEntries: string[] = ['- [📊 Findings](#-findings)'];

  const hasSymbolDetails = axis !== 'best-practices' && shard.files.some((r) => hasAxisFinding(r, axis));
  const hasBpDetails = axis === 'best-practices' && shard.files.some((r) => r.best_practices && r.best_practices.suggestions.length > 0);
  if (hasSymbolDetails) tocEntries.push('- [🔍 Symbol Details](#-symbol-details)');
  if (hasBpDetails) tocEntries.push('- [🔍 Details](#-details)');

  const normalizedActions = shard.actions.map(normalizeAction);
  const byCategory: Record<Category, Array<Action & { file: string }>> = { quickwin: [], refactor: [], hygiene: [] };
  for (const a of normalizedActions) {
    const cat = a.category ?? 'refactor';
    byCategory[cat].push(a);
  }
  if (byCategory.quickwin.length > 0) tocEntries.push('- [⚡ Quick Wins](#-quick-wins)');
  if (byCategory.refactor.length > 0) tocEntries.push('- [🔧 Refactors](#-refactors)');
  if (byCategory.hygiene.length > 0) tocEntries.push('- [🧹 Hygiene](#-hygiene)');

  if (axis === 'tests' && shard.files.some((r) => r.symbols.some((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE')))) {
    tocEntries.push('- [🧪 Test Improvements](#-test-improvements)');
  }

  for (const entry of tocEntries) lines.push(entry);
  lines.push('');

  // Findings table — axis-specific columns
  lines.push('## 📊 Findings');
  lines.push('');

  if (axis === 'best-practices') {
    lines.push('| File | Verdict | BP Score | Details |');
    lines.push('|------|---------|----------|---------|');
    for (const review of shard.files) {
      const bpScore = review.best_practices ? `${review.best_practices.score}/10` : '-';
      const anchor = fileToAnchor(review.file);
      const link = `[details](#${anchor})`;
      const fileVerdict = computeFileVerdict(review);
      lines.push(`| \`${review.file}\` | ${verdictEmoji(fileVerdict)} ${fileVerdict} | ${bpScore} | ${link} |`);
    }
  } else {
    const header = axisShardHeader(axis);
    lines.push(header.columns);
    lines.push(header.separator);
    for (const review of shard.files) {
      const reliable = review.symbols.filter((s) => s.confidence >= 30);
      const count = axisShardCount(axis, reliable);
      const maxConf = Math.max(...review.symbols.map((s) => s.confidence), 0);
      const anchor = fileToAnchor(review.file);
      const link = `[details](#${anchor})`;
      const fileVerdict = computeFileVerdict(review);
      lines.push(`| \`${review.file}\` | ${verdictEmoji(fileVerdict)} ${fileVerdict} | ${count} | ${maxConf}% | ${link} |`);
    }
  }
  lines.push('');

  // Symbol-level details
  const filesWithAxisFindings = shard.files.filter((r) => hasAxisFinding(r, axis));
  if (filesWithAxisFindings.length > 0 && axis !== 'best-practices') {
    lines.push('## 🔍 Symbol Details');
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
        // When the symbol carries multiple distinct defects on this axis,
        // emit one table row per defect — same symbol name, different
        // line range and detail per row. Downstream consumers (incl. the
        // anatoly-bench scorer) treat each row as an independent finding.
        const axisFindings = (s.findings ?? []).filter((f) => f.axis === axis);
        if (axisFindings.length > 0) {
          for (const f of axisFindings) {
            const range = f.line_start === f.line_end ? `L${f.line_start}` : `L${f.line_start}–L${f.line_end}`;
            const safeDetail = f.detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
            lines.push(`| \`${s.name}\` | ${range} | ${verdictEmoji(value)} ${value} | ${s.confidence}% | ${safeDetail} |`);
          }
        } else {
          const detail = axisDetail(s, axis);
          lines.push(`| \`${s.name}\` | L${s.line_start}–L${s.line_end} | ${verdictEmoji(value)} ${value} | ${s.confidence}% | ${detail} |`);
        }
      }
      lines.push('');
    }
  }

  // Best practices details
  if (axis === 'best-practices') {
    const bpReviews = shard.files.filter((r) => r.best_practices && r.best_practices.suggestions.length > 0);
    if (bpReviews.length > 0) {
      lines.push('## 🔍 Details');
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

  // Actions by category (scoped to this axis, byCategory computed above for TOC)
  if (shard.actions.length > 0) {
    if (byCategory.quickwin.length > 0) {
      lines.push('## ⚡ Quick Wins');
      lines.push('');
      for (const a of byCategory.quickwin) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.refactor.length > 0) {
      lines.push('## 🔧 Refactors');
      lines.push('');
      for (const a of byCategory.refactor) renderAction(lines, a);
      lines.push('');
    }

    if (byCategory.hygiene.length > 0) {
      lines.push('## 🧹 Hygiene');
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
      lines.push('## 🧪 Test Improvements');
      lines.push('');
      for (const review of testReviews) {
        const testSymbols = review.symbols.filter((s) => s.confidence >= 30 && (s.tests === 'WEAK' || s.tests === 'NONE'));
        const noneSymbols = testSymbols.filter((s) => s.tests === 'NONE');
        const weakSymbols = testSymbols.filter((s) => s.tests === 'WEAK');
        const summary = [noneSymbols.length > 0 ? `${noneSymbols.length} untested` : '', weakSymbols.length > 0 ? `${weakSymbols.length} weak` : ''].filter(Boolean).join(', ');

        const extMatch = review.file.match(/(\.\w+)$/);
        // Replace the trailing extension only: a plain-string replace hits the
        // first occurrence, mangling paths like `src/utils.ts/foo.ts`.
        const testFile = extMatch ? review.file.replace(/(\.\w+)$/, `.test$1`) : `${review.file}.test.ts`;
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
