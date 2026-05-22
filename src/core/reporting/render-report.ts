// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReviewFile } from '../../schemas/review.js';
import type { DocReportStats } from '../documentation/index.js';
import {
  CRASH_SENTINEL,
} from './review-data.js';
import type { ReportData, TriageStats, RunStats } from './review-data.js';
import {
  REPORT_AXIS_IDS,
  axisDisplayName, axisEmoji, axisHealthPercent, bestPracticesLabel,
  crashedAxisIds, derivePrimaryLanguage, docCommentTerm,
} from './axis-registry.js';
import type { ReportAxisId, AxisReport } from './axis-registry.js';
import type { DocModeInfo } from './doc-divergences.js';
import { renderDocModeLine } from './doc-divergences.js';
import { verdictEmoji, healthBar, hasAxisSymbolFinding, axisSymbolValue, axisDetail } from './render-axis.js';

// ---------------------------------------------------------------------------
// Axis summary (for master index)
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
export function renderIndex(data: ReportData, axisReports: AxisReport[], triageStats?: TriageStats, runStats?: RunStats, docReferenceSection?: string, divergenceSection?: string, docMode?: DocModeInfo, docConflictCount?: number): string {
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
  if (docConflictCount && docConflictCount > 0) {
    lines.push(`- **Unresolved doc conflicts:** ${docConflictCount} (run \`anatoly docs arbitrate\`)`);
  }
  if (docMode) {
    lines.push(`- **${renderDocModeLine(docMode)}**`);
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

  // Divergence section (Story 54.9, FR17)
  if (divergenceSection) {
    lines.push(divergenceSection);
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
  const lang = derivePrimaryLanguage(data.reviews);
  const bpLabel = bestPracticesLabel(lang);
  const docTerm = docCommentTerm(lang);
  lines.push(`| Best Practices | sonnet | Score 0–10 | Does the file follow ${bpLabel} best practices? |`);
  lines.push(`| Documentation | haiku | DOCUMENTED / PARTIAL / UNDOCUMENTED | Are exported symbols properly documented with ${docTerm}? |`);
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
// Public report renderer helpers
// ---------------------------------------------------------------------------

/**
 * Build a compact verdict breakdown string for an axis (e.g. "94% lean · 6% acceptable").
 * Used for "All clear" axes where health bar is 100% but verdicts are mixed.
 */
function axisVerdictBreakdown(data: ReportData, axis: ReportAxisId): string {
  const reliable = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30));

  const countAndFormat = (entries: Array<{ label: string; count: number }>, total: number): string => {
    if (total === 0) return 'No data';
    return entries
      .filter((e) => e.count > 0)
      .map((e) => `${Math.round((e.count / total) * 100)}% ${e.label}`)
      .join(' · ');
  };

  switch (axis) {
    case 'correction': {
      const all = reliable.filter((s) => s.correction !== '-');
      return countAndFormat([
        { label: 'OK', count: all.filter((s) => s.correction === 'OK').length },
        { label: 'needs fix', count: all.filter((s) => s.correction === 'NEEDS_FIX').length },
      ], all.length);
    }
    case 'utility': {
      const all = reliable.filter((s) => s.utility !== '-');
      return countAndFormat([
        { label: 'used', count: all.filter((s) => s.utility === 'USED').length },
        { label: 'dead', count: all.filter((s) => s.utility === 'DEAD').length },
        { label: 'low value', count: all.filter((s) => s.utility === 'LOW_VALUE').length },
      ], all.length);
    }
    case 'duplication': {
      const all = reliable.filter((s) => s.duplication !== '-');
      return countAndFormat([
        { label: 'unique', count: all.filter((s) => s.duplication === 'UNIQUE').length },
        { label: 'duplicate', count: all.filter((s) => s.duplication === 'DUPLICATE').length },
      ], all.length);
    }
    case 'overengineering': {
      const all = reliable.filter((s) => s.overengineering !== '-');
      return countAndFormat([
        { label: 'lean', count: all.filter((s) => s.overengineering === 'LEAN').length },
        { label: 'acceptable', count: all.filter((s) => s.overengineering === 'ACCEPTABLE').length },
        { label: 'over', count: all.filter((s) => s.overengineering === 'OVER').length },
      ], all.length);
    }
    case 'tests': {
      const all = reliable.filter((s) => s.tests !== '-');
      return countAndFormat([
        { label: 'good', count: all.filter((s) => s.tests === 'GOOD').length },
        { label: 'weak', count: all.filter((s) => s.tests === 'WEAK').length },
        { label: 'none', count: all.filter((s) => s.tests === 'NONE').length },
      ], all.length);
    }
    case 'documentation': {
      const all = reliable.filter((s) => s.documentation !== '-');
      return countAndFormat([
        { label: 'documented', count: all.filter((s) => s.documentation === 'DOCUMENTED').length },
        { label: 'partial', count: all.filter((s) => s.documentation === 'PARTIAL').length },
        { label: 'undocumented', count: all.filter((s) => s.documentation === 'UNDOCUMENTED').length },
      ], all.length);
    }
    case 'best-practices': {
      const bpReviews = data.reviews.filter((r) => r.best_practices);
      if (bpReviews.length === 0) return 'No data';
      const avg = bpReviews.reduce((sum, r) => sum + r.best_practices!.score, 0) / bpReviews.length;
      return `avg ${avg.toFixed(1)} / 10`;
    }
  }
}

/**
 * Render the public-report "Documentation Coverage" section directly from
 * the structured stats produced by `aggregateDocReport`. No regex parsing —
 * the previous implementation re-rendered the markdown by reverse-engineering
 * the rendered-then-persisted section via ~10 regex patterns, paying a
 * render→parse→render round-trip for data we already had in memory.
 */
function renderPublicDocSectionFromStats(stats: DocReportStats): string[] {
  const lines: string[] = [];
  lines.push('## Documentation Coverage');
  lines.push('');
  lines.push('Measures inline doc comments (`///` in Rust, `/** */` in JS/TS, docstrings in Python) on exported symbols.');
  lines.push('Anatoly also generates reference pages in `.anatoly/docs/` for every reviewed module.');
  lines.push('');

  const pageParts: string[] = [];
  if (stats.refreshedPages.length > 0) pageParts.push(`${stats.refreshedPages.length} refreshed`);
  if (stats.cachedPages.length > 0) pageParts.push(`${stats.cachedPages.length} cached`);
  const pageSummary = pageParts.length > 0 ? ` (${pageParts.join(', ')})` : '';
  lines.push(`**Reference pages:** ${stats.totalPages} pages generated${pageSummary}`);
  lines.push('');

  const sc = stats.symbolCoverage;
  if (sc) {
    const projectPct = sc.totalExports === 0 ? 100 : Math.min(100, Math.round((sc.projectDocumented / sc.totalExports) * 100));
    const internalPct = sc.totalExports === 0 ? 100 : Math.min(100, Math.round((sc.internalDocumented / sc.totalExports) * 100));
    const projectDocCount = Math.min(sc.projectDocumented, sc.totalExports);
    const internalDocCount = Math.min(sc.internalDocumented, sc.totalExports);

    if (stats.docsSynced || stats.userDocsPageCount === 0) {
      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');
      lines.push(`| Complete doc comments | ${healthBar(projectPct)} ${projectPct}% (${projectDocCount}/${sc.totalExports}) | Exported symbols with a complete inline doc comment covering description, params, and return |`);
      lines.push(`| Any doc comment | ${healthBar(internalPct)} ${internalPct}% (${internalDocCount}/${sc.totalExports}) | Exported symbols with at least a partial inline doc comment |`);
      if (sc.totalModules !== undefined && sc.internalModulesDocumented !== undefined) {
        const modPct = sc.totalModules === 0 ? 100 : Math.min(100, Math.round((sc.internalModulesDocumented / sc.totalModules) * 100));
        lines.push(`| Module guides | ${healthBar(modPct)} ${modPct}% (${sc.internalModulesDocumented}/${sc.totalModules}) | Modules > 200 LOC with a dedicated page in docs/ |`);
      }
      if (stats.userDocsPageCount === 0) {
        lines.push(`| Reference pages | ${stats.totalPages} pages | Anatoly-generated module and API reference pages |`);
      }
      lines.push('');
      lines.push(stats.docsSynced
        ? '> `docs/` is synced with `.anatoly/docs/` — documentation is evaluated against the Anatoly-generated reference.'
        : '> No `docs/` directory found. Copy `.anatoly/docs/` to `docs/` to adopt the generated documentation and speed up future Anatoly runs.');
      lines.push('');
    } else {
      lines.push('**Project docs (docs/):**');
      lines.push('');
      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');
      lines.push(`| Complete doc comments | ${healthBar(projectPct)} ${projectPct}% (${projectDocCount}/${sc.totalExports}) | Exported symbols with a complete inline doc comment covering description, params, and return |`);
      lines.push(`| Any doc comment | ${healthBar(internalPct)} ${internalPct}% (${internalDocCount}/${sc.totalExports}) | Exported symbols with at least a partial inline doc comment |`);
      if (sc.modulesDocumented !== undefined && sc.totalModules !== undefined) {
        const modPct = sc.totalModules === 0 ? 100 : Math.min(100, Math.round((sc.modulesDocumented / sc.totalModules) * 100));
        lines.push(`| Module guides | ${healthBar(modPct)} ${modPct}% (${sc.modulesDocumented}/${sc.totalModules}) | Modules > 200 LOC with a dedicated page in docs/ |`);
      }
      lines.push('');

      lines.push('**Internal docs (.anatoly/docs/):**');
      lines.push('');
      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');
      lines.push(`| Reference pages | ${stats.totalPages} pages | Anatoly-generated module and API reference pages |`);
      if (sc.totalModules !== undefined && sc.internalModulesDocumented !== undefined) {
        const intModPct = sc.totalModules === 0 ? 100 : Math.min(100, Math.round((sc.internalModulesDocumented / sc.totalModules) * 100));
        lines.push(`| Module guides | ${healthBar(intModPct)} ${intModPct}% (${sc.internalModulesDocumented}/${sc.totalModules}) | Modules > 200 LOC with a page in .anatoly/docs/ |`);
      }
      lines.push('');
      lines.push('> Check the internal Anatoly docs in `.anatoly/docs/` or simply replace your current `docs/` with the internal docs to speed up future Anatoly runs.');
      lines.push('');
    }
  }

  if (stats.syncByType) {
    const syncParts: string[] = [];
    if (stats.syncByType.toCreate > 0) syncParts.push(`${stats.syncByType.toCreate} pages to create`);
    if (stats.syncByType.outdated > 0) syncParts.push(`${stats.syncByType.outdated} pages outdated`);
    if (syncParts.length > 0) {
      lines.push(`**Gaps:** ${syncParts.join(', ')}.`);
      lines.push('');
    }
  }

  if (stats.newPages.length > 0) {
    lines.push('<details>');
    lines.push(`<summary><strong>New pages generated (${stats.newPages.length})</strong></summary>`);
    lines.push('');
    for (const { page, source } of stats.newPages) {
      lines.push(`- .anatoly/docs/${page}  (from ${source})`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines;
}

/**
 * Re-render the documentation reference section for the public report.
 * Prefers structured stats (clean path); falls back to regex-parsing the
 * rendered markdown when stats are absent (legacy runs without the
 * doc-report-stats.json sidecar).
 */
function renderPublicDocSection(raw: string, stats?: DocReportStats): string[] {
  if (stats) return renderPublicDocSectionFromStats(stats);
  const lines: string[] = [];
  lines.push('## Documentation Coverage');
  lines.push('');
  lines.push('Measures inline doc comments (`///` in Rust, `/** */` in JS/TS, docstrings in Python) on exported symbols.');
  lines.push('Anatoly also generates reference pages in `.anatoly/docs/` for every reviewed module.');
  lines.push('');

  // Parse the raw section to extract metrics
  const pagesMatch = raw.match(/updated:\s*(\d+)\s*pages\s*\(([^)]+)\)/);
  if (pagesMatch) {
    lines.push(`**Reference pages:** ${pagesMatch[1]} pages generated (${pagesMatch[2]})`);
    lines.push('');
  }

  // Detect rendering mode from raw markers
  const isSynced = raw.includes('synced with .anatoly/docs/');
  const isInternalOnly = raw.includes('Documentation coverage (.anatoly/docs/):');

  // Parse symbol coverage lines
  const fullyMatch = raw.match(/Fully documented:\s*(\d+)%\s*\((\d+)\/(\d+)\s*symbols\)/);
  const partialMatch = raw.match(/At least partial:\s*(\d+)%\s*\((\d+)\/(\d+)\s*symbols\)/);

  if (fullyMatch || partialMatch) {
    if (isSynced || isInternalOnly) {
      // Single table: synced or no docs/ directory
      const syncedModMatch = raw.match(/Modules:\s*(\d+)%\s*\((\d+)\/(\d+)\s*modules > 200 LOC (?:with a docs page|in internal docs)\)/);
      const intPagesMatch = raw.match(/Pages generated:\s*(\d+)/);

      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');

      if (fullyMatch) {
        const pct = parseInt(fullyMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Complete doc comments | ${bar} ${pct}% (${fullyMatch[2]}/${fullyMatch[3]}) | Exported symbols with a complete inline doc comment covering description, params, and return |`);
      }
      if (partialMatch) {
        const pct = parseInt(partialMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Any doc comment | ${bar} ${pct}% (${partialMatch[2]}/${partialMatch[3]}) | Exported symbols with at least a partial inline doc comment |`);
      }
      if (syncedModMatch) {
        const pct = parseInt(syncedModMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Module guides | ${bar} ${pct}% (${syncedModMatch[2]}/${syncedModMatch[3]}) | Modules > 200 LOC with a dedicated page in docs/ |`);
      }
      if (intPagesMatch) {
        lines.push(`| Reference pages | ${intPagesMatch[1]} pages | Anatoly-generated module and API reference pages |`);
      }
      lines.push('');

      if (isSynced) {
        lines.push('> `docs/` is synced with `.anatoly/docs/` — documentation is evaluated against the Anatoly-generated reference.');
      } else {
        lines.push('> No `docs/` directory found. Copy `.anatoly/docs/` to `docs/` to adopt the generated documentation and speed up future Anatoly runs.');
      }
      lines.push('');
    } else {
      // Two separate tables: docs/ exists but diverges from .anatoly/docs/
      const modulesMatch = raw.match(/Modules:\s*(\d+)%\s*\((\d+)\/(\d+)\s*modules > 200 LOC in project docs\)/);

      lines.push('**Project docs (docs/):**');
      lines.push('');
      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');

      if (fullyMatch) {
        const pct = parseInt(fullyMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Complete doc comments | ${bar} ${pct}% (${fullyMatch[2]}/${fullyMatch[3]}) | Exported symbols with a complete inline doc comment covering description, params, and return |`);
      }
      if (partialMatch) {
        const pct = parseInt(partialMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Any doc comment | ${bar} ${pct}% (${partialMatch[2]}/${partialMatch[3]}) | Exported symbols with at least a partial inline doc comment |`);
      }
      if (modulesMatch) {
        const pct = parseInt(modulesMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Module guides | ${bar} ${pct}% (${modulesMatch[2]}/${modulesMatch[3]}) | Modules > 200 LOC with a dedicated page in docs/ |`);
      }
      lines.push('');

      lines.push('**Internal docs (.anatoly/docs/):**');
      lines.push('');
      lines.push('| Metric | Coverage | Description |');
      lines.push('|--------|----------|-------------|');

      const intPagesMatch2 = raw.match(/Pages generated:\s*(\d+)/);
      const intModulesMatch = raw.match(/Modules:\s*(\d+)%\s*\((\d+)\/(\d+)\s*modules > 200 LOC in internal docs\)/);
      if (intPagesMatch2) {
        lines.push(`| Reference pages | ${intPagesMatch2[1]} pages | Anatoly-generated module and API reference pages |`);
      }
      if (intModulesMatch) {
        const pct = parseInt(intModulesMatch[1]);
        const bar = healthBar(pct);
        lines.push(`| Module guides | ${bar} ${pct}% (${intModulesMatch[2]}/${intModulesMatch[3]}) | Modules > 200 LOC with a page in .anatoly/docs/ |`);
      }
      lines.push('');
      lines.push('> Check the internal Anatoly docs in `.anatoly/docs/` or simply replace your current `docs/` with the internal docs to speed up future Anatoly runs.');
      lines.push('');
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Public report renderer (user-facing, polished)
// ---------------------------------------------------------------------------

/**
 * Render the public-facing report (public_report.md).
 * Designed for readability: hero block with value KPIs, health scorecard,
 * top findings, and compact run details in a cold zone.
 */
export function renderPublicIndex(data: ReportData, axisReports: AxisReport[], triageStats?: TriageStats, runStats?: RunStats, docReferenceSection?: string, reportsBaseUrl?: string, divergenceSection?: string, docMode?: DocModeInfo, docReportStats?: DocReportStats, docConflictCount?: number): string {
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
  const fileCount = data.findingFiles.length;
  const errorSymbols = data.reviews.flatMap((r) => r.symbols.filter((s) => s.confidence >= 30 && s.correction === 'ERROR'));
  const totalFindings = Object.values(data.counts).reduce((sum, c) => sum + c.high + c.medium + c.low, 0);

  lines.push(`> **${data.totalFiles} files** reviewed in **${durationMin} min** — **${costUsd}** in AI analysis so you don't have to.`);

  // An axis whose evaluators crashed produced no real verdicts. It must not
  // be presented as clean: a crashed axis is "not evaluated", not "100% OK".
  const crashedAxes = crashedAxisIds(data);
  const isAxisDegraded = (axis: ReportAxisId, evaluated: number): boolean => {
    if (evaluated > 0) return false;
    // best-practices is file-level (no per-symbol crash sentinel to parse):
    // treat it as degraded only when the run actually had degraded reviews.
    if (axis === 'best-practices') return data.degradedFiles.length > 0;
    return crashedAxes.has(axis);
  };
  const degradedAxisNames = REPORT_AXIS_IDS
    .filter((a) => isAxisDegraded(a, axisHealthPercent(data, a).evaluated))
    .map((a) => axisDisplayName(a));

  // A run with un-evaluated axes cannot honestly be called CLEAN — the
  // "clean" verdict would only reflect the axes that happened to run.
  const displayVerdict = data.globalVerdict === 'CLEAN' && degradedAxisNames.length > 0
    ? 'DEGRADED'
    : data.globalVerdict;
  const verdictParts = [`Verdict: **${displayVerdict}**`];
  if (errorSymbols.length > 0) verdictParts.push(`${errorSymbols.length} critical bug${errorSymbols.length > 1 ? 's' : ''} found`);
  verdictParts.push(`${totalFindings} finding${totalFindings !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`);
  if (degradedAxisNames.length > 0) {
    verdictParts.push(`⚠️ ${degradedAxisNames.length} axis evaluator${degradedAxisNames.length > 1 ? 's' : ''} crashed (${degradedAxisNames.join(', ')}) — re-run recommended`);
  }
  lines.push(`> ${verdictParts.join(' · ')}`);
  if (docConflictCount && docConflictCount > 0) {
    lines.push(`> ⚠️ ${docConflictCount} unresolved code↔reference doc conflict${docConflictCount > 1 ? 's' : ''} — run \`anatoly docs arbitrate\``);
  }
  if (docMode) {
    lines.push(`> ${renderDocModeLine(docMode)}`);
  }
  lines.push('');

  // ── 2. AXES OVERVIEW (health + findings + links — single source of truth) ──
  const countsKeyMap: Record<ReportAxisId, keyof typeof data.counts> = {
    correction: 'correction',
    utility: 'dead',
    duplication: 'duplicate',
    overengineering: 'overengineering',
    tests: 'tests',
    documentation: 'documentation',
    'best-practices': 'best_practices',
  };
  const axisReportSet = new Set(axisReports.map((r) => r.axis));

  // Helper to resolve links — absolute when reportsBaseUrl is set, relative otherwise
  const axisLink = (axis: string) => reportsBaseUrl
    ? `${reportsBaseUrl}/axes/${axis}/index.md`
    : `./axes/${axis}/index.md`;

  // Per-axis CRITICAL count, surfaced separately from `high` so readers don't
  // conflate "1 ERROR bug" with "20 high-confidence NEEDS_FIX". CRITICAL is
  // already included in counts[axis].high (via symbolSeverity/bpSevMap), so the
  // displayed `high` value subtracts it to keep the row total honest.
  const axisCriticalCount = (axis: ReportAxisId): number => {
    if (axis === 'correction') {
      let n = 0;
      for (const r of data.reviews) for (const s of r.symbols) if (s.confidence >= 30 && s.correction === 'ERROR') n++;
      return n;
    }
    if (axis === 'best-practices') {
      let n = 0;
      for (const r of data.reviews) if (r.best_practices) for (const rule of r.best_practices.rules) if (rule.status === 'FAIL' && rule.severity === 'CRITICAL') n++;
      return n;
    }
    return 0;
  };

  lines.push('## Axes');
  lines.push('');
  lines.push('| Axis | Health | Findings | Details |');
  lines.push('|------|--------|----------|---------|');
  for (const axis of REPORT_AXIS_IDS) {
    const name = axisDisplayName(axis);
    const { pct, label, evaluated } = axisHealthPercent(data, axis);

    // Crashed axis: never render a health bar / "All clear". It was not
    // evaluated, so show it explicitly as degraded with a re-run hint.
    if (isAxisDegraded(axis, evaluated)) {
      const detail = axisReportSet.has(axis) ? `[View →](${axisLink(axis)})` : '—';
      lines.push(`| ${name} | ⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜ ⚠️ not evaluated (axis crashed) | degraded | ${detail} |`);
      continue;
    }

    const c = data.counts[countsKeyMap[axis]];
    const critical = axisCriticalCount(axis);
    const highDisplay = Math.max(0, c.high - critical);
    const bar = healthBar(pct, c.high, data.totalFiles);
    const parts: string[] = [];
    if (critical > 0) parts.push(`${critical} critical`);
    if (highDisplay > 0) parts.push(`${highDisplay} high`);
    if (c.medium > 0) parts.push(`${c.medium} med`);
    if (c.low > 0) parts.push(`${c.low} low`);

    const healthLabel = axis === 'best-practices' ? `${bar} ${label}` : `${bar} ${pct}% ${label}`;

    if (axisReportSet.has(axis)) {
      const findingsStr = parts.join(' · ') || '—';
      const link = `[View →](${axisLink(axis)})`;
      lines.push(`| ${name} | ${healthLabel} | ${findingsStr} | ${link} |`);
    } else {
      // No findings — full green bar but show the actual verdict breakdown
      const cleanBar = healthBar(100);
      const breakdown = axisVerdictBreakdown(data, axis);
      lines.push(`| ${name} | ${cleanBar} ${breakdown} | All clear | — |`);
    }
  }
  lines.push('');

  // ── 3. TOP FINDINGS PER AXIS ────────────────────────────────────────────
  lines.push('## Top Findings');
  lines.push('');

  for (const axis of REPORT_AXIS_IDS) {
    const emoji = axisEmoji(axis);
    const name = axisDisplayName(axis);
    const report = axisReports.find((r) => r.axis === axis);

    if (!report || report.files.length === 0) {
      lines.push(`### ${emoji} ${name}`);
      lines.push('');
      if (isAxisDegraded(axis, axisHealthPercent(data, axis).evaluated)) {
        // No findings here because the axis crashed, not because the code is
        // clean. Saying "CLEAN" would be a false negative.
        lines.push(`⚠️ **DEGRADED** — axis evaluator crashed; this axis was not evaluated this run. Re-run recommended.`);
      } else {
        lines.push(`✨ **CLEAN** — No issues found!`);
      }
      lines.push('');
      continue;
    }

    // Collect findings with severity for this axis
    const axisFindings: Array<{ file: string; symbol: string; value: string; detail: string; confidence: number; severity: 'high' | 'medium' | 'low' }> = [];
    for (const review of report.files) {
      for (const s of review.symbols.filter((sym) => sym.confidence >= 30 && hasAxisSymbolFinding(sym, axis))) {
        const value = axisSymbolValue(s, axis);
        const detail = axisDetail(s, axis);
        const sev = s.confidence >= 80 ? 'high' as const : s.confidence >= 50 ? 'medium' as const : 'low' as const;
        axisFindings.push({ file: review.file, symbol: s.name, value, detail, confidence: s.confidence, severity: sev });
      }
    }

    // Determine which tier to show: high > medium > skip low
    const high = axisFindings.filter((f) => f.severity === 'high');
    const medium = axisFindings.filter((f) => f.severity === 'medium');
    const shown = high.length > 0 ? high : medium.length > 0 ? medium : [];

    const total = axisFindings.length;

    lines.push(`### ${emoji} ${name}`);
    lines.push('');

    if (shown.length === 0) {
      lines.push(`✨ **CLEAN** — Only low-confidence findings. [View details →](${axisLink(axis)})`);
      lines.push('');
      continue;
    }

    // Sort: critical verdicts first (🔴 before 🟡), then by confidence descending
    const verdictWeight = (value: string): number => {
      const e = verdictEmoji(value);
      if (e === '🔴') return 0;
      if (e === '🟡') return 1;
      return 2;
    };
    shown.sort((a, b) => verdictWeight(a.value) - verdictWeight(b.value) || b.confidence - a.confidence);
    const top = shown.slice(0, 5);

    if (total > top.length) {
      lines.push(`> Showing top ${top.length} of ${total} findings. [View all →](${axisLink(axis)})`);
    } else {
      lines.push(`> ${total} findings. [View all →](${axisLink(axis)})`);
    }
    lines.push('');

    for (const f of top) {
      const icon = verdictEmoji(f.value);
      const oneLiner = f.detail.length > 120 ? f.detail.slice(0, 117) + '...' : f.detail;
      lines.push(`- ${icon} **${f.file}** \`${f.symbol}\` — ${oneLiner}`);
    }
    lines.push('');
  }

  // ── 5. DOCUMENTATION REFERENCE (rewritten for public readability) ─────
  if (docReferenceSection || docReportStats) {
    lines.push(...renderPublicDocSection(docReferenceSection ?? '', docReportStats));
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
      // Extract which axes crashed from the detail strings
      const crashedAxesSet = new Set<string>();
      for (const s of r.symbols) {
        if (!s.detail.includes(CRASH_SENTINEL)) continue;
        const segments = s.detail.split(/\s*\|\s*/);
        const axisOrder: string[] = ['utility', 'duplication', 'correction', 'overengineering', 'tests', 'documentation'];
        for (let i = 0; i < segments.length && i < axisOrder.length; i++) {
          if (segments[i].includes(CRASH_SENTINEL)) {
            crashedAxesSet.add(axisOrder[i]);
          }
        }
      }
      const axisInfo = crashedAxesSet.size > 0 ? ` — crashed: ${[...crashedAxesSet].join(', ')}` : '';
      lines.push(`- \`${r.file}\`${axisInfo}`);
    }
    lines.push('');
  }

  // ── 6b. DOCUMENTATION (always present — link updated by publish.sh) ──
  const docsLink = reportsBaseUrl
    ? `${reportsBaseUrl}/docs/index.md`
    : './docs/index.md';
  lines.push('## 📚 Documentation');
  lines.push('');
  lines.push('Anatoly generated a complete documentation for this project during the audit.');
  lines.push('');
  lines.push(`**[Browse the documentation →](${docsLink})**`);
  lines.push('');

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

