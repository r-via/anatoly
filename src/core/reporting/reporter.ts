// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and LICENSING details.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCodeWinsAsStaleReferences, loadPendingConflictsAsDocConflicts } from '../documentation/index.js';
import type { DocReportStats } from '../documentation/index.js';

// ---------------------------------------------------------------------------
// Re-exports — all public symbols from each domain module.
// External callers (barrel index.ts, reporter.test.ts) import from this file.
// ---------------------------------------------------------------------------

export {
  loadReviews,
  computeFileVerdict, computeGlobalVerdict,
  aggregateReviews, sortFindingFiles, buildShards,
  isDegradedReview, CRASH_SENTINEL,
} from './review-data.js';
export type { TriageStats, RunStats, ReportData, ShardInfo } from './review-data.js';

export {
  REPORT_AXIS_IDS,
  toReportAxisId, toAxisId,
  axisDisplayName, axisEmoji, axisIntro, axisModel,
  hasAxisFinding, buildAxisReports,
  docCommentTerm, bestPracticesLabel, derivePrimaryLanguage,
  crashedAxisIds, axisHealthPercent,
} from './axis-registry.js';
export type { ReportAxisId, AxisReport } from './axis-registry.js';

export {
  aggregateDivergences, renderDivergenceSection,
  aggregateStaleReferences, renderStaleReferenceSection,
  renderDocConflictSection,
  renderDocModeLine, applyPendingConflictsToReviews,
} from './doc-divergences.js';
export type { DocModeInfo } from './doc-divergences.js';

export {
  makeActId, fileToAnchor,
  verdictEmoji, healthBar,
  renderAxisIndex, renderAxisShard,
} from './render-axis.js';

export { renderIndex, renderPublicIndex } from './render-report.js';

// ---------------------------------------------------------------------------
// Entry point — generateReport
// ---------------------------------------------------------------------------

import { loadReviews, aggregateReviews, buildShards } from './review-data.js';
import type { ReportData, ShardInfo, TriageStats, RunStats } from './review-data.js';
import { buildAxisReports } from './axis-registry.js';
import type { AxisReport } from './axis-registry.js';
import { applyPendingConflictsToReviews, aggregateDivergences, renderDivergenceSection, renderStaleReferenceSection, renderDocConflictSection } from './doc-divergences.js';
import type { DocModeInfo } from './doc-divergences.js';
import { renderIndex, renderPublicIndex } from './render-report.js';
import { renderAxisIndex, renderAxisShard } from './render-axis.js';

/**
 * Generate the axis-based report: master index + per-axis folders with indexes and shards.
 * When runDir is provided, reads reviews from and writes report to the run directory.
 * @param projectRoot - Absolute path to the project root.
 * @param errorFiles - File paths that failed evaluation (included in the report as errors).
 * @param runDir - Optional run-scoped directory for reading reviews and writing the report.
 * @param triageStats - Optional triage statistics to include in the master index.
 * @param runStats - Optional run-level timing/cost statistics.
 * @param docReferenceSection - Optional markdown section for referenced documentation.
 * @param docReportStats - Optional structured DocReportStats for the public report's
 *   doc-coverage section. Passed through verbatim to {@link renderPublicIndex}; when
 *   present, the public renderer uses it directly instead of regex-parsing
 *   `docReferenceSection`.
 * @returns An object with `reportPath`, aggregated `data`, legacy `shards`, and per-axis `axisReports`.
 */
export function generateReport(
  projectRoot: string,
  errorFiles?: string[],
  runDir?: string,
  triageStats?: TriageStats,
  runStats?: RunStats,
  docReferenceSection?: string,
  reportsBaseUrl?: string,
  docMode?: DocModeInfo,
  docReportStats?: DocReportStats,
): { reportPath: string; data: ReportData; shards: ShardInfo[]; axisReports: AxisReport[] } {
  const reviews = loadReviews(projectRoot, runDir);
  // doc 16 PR 3a: fold unresolved (pending) doc-conflicts into the
  // correction axis as explained NEEDS_FIX findings, so a detected
  // code↔reference contradiction is a scorable axis finding (it lives in
  // axes/correction/shard.N.md like every finding), not only a markdown
  // section. Safety-net + dedupe: only when correction did NOT already
  // flag that symbol (no double-count). The doc-conflicts.yaml store is
  // left intact for `anatoly docs arbitrate` (surface ≠ adjudicate; the
  // detail explains it is a conflict and points at arbitration).
  applyPendingConflictsToReviews(reviews, projectRoot, runDir);
  const data = aggregateReviews(reviews, errorFiles);
  const shards = buildShards(data);
  const axisReports = buildAxisReports(data);

  // Aggregate doc divergences across all reviews (Story 54.9, FR17)
  const allDivergences = aggregateDivergences(reviews);
  const divergenceSection = renderDivergenceSection(allDivergences);

  // Load stale reference findings directly from doc-conflicts.yaml (Story 55.8)
  const allStaleRefs = loadCodeWinsAsStaleReferences(projectRoot);
  const staleRefSection = renderStaleReferenceSection(allStaleRefs);
  // doc 16 PR 3a: surface unresolved (pending) conflicts as doc_conflict
  // findings — detection is not silently dropped.
  const allDocConflicts = loadPendingConflictsAsDocConflicts(projectRoot);
  const docConflictSection = renderDocConflictSection(allDocConflicts);
  const combinedDivergenceSection = [divergenceSection, staleRefSection, docConflictSection].filter(Boolean).join('\n\n');

  const baseDir = runDir ?? join(projectRoot, '.anatoly');
  const reportPath = join(baseDir, 'report.md');

  // Write master index (internal, full detail)
  writeFileSync(reportPath, renderIndex(data, axisReports, triageStats, runStats, docReferenceSection, combinedDivergenceSection, docMode));

  // Write public report (user-facing, polished)
  const publicReportPath = join(baseDir, 'public_report.md');
  writeFileSync(publicReportPath, renderPublicIndex(data, axisReports, triageStats, runStats, docReferenceSection, reportsBaseUrl, combinedDivergenceSection, docMode, docReportStats));

  // Write per-axis folders
  for (const report of axisReports) {
    const axisDir = join(baseDir, 'axes', report.axis);
    mkdirSync(axisDir, { recursive: true });

    // Write axis index
    writeFileSync(join(axisDir, 'index.md'), renderAxisIndex(report, data.reviews));

    // Write axis shards
    for (const shard of report.shards) {
      writeFileSync(join(axisDir, `shard.${shard.index}.md`), renderAxisShard(report.axis, shard));
    }
  }

  return { reportPath, data, shards, axisReports };
}
