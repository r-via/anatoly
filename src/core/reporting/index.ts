// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `reporting/` bounded context: the Report / Badge phases (audit output).
 *
 * Published surface (doc 12 §1 rule 1, doc 13 PR 2). Everything outside this
 * context imports this barrel, never a module path inside it. The surface is
 * exactly the symbols current external importers use, no speculative API
 * (doc 13 §8). Distinct from `documentation/reporting/`, which scores docs.
 */

export { generateReport } from './reporter.js';

export {
  loadReviews,
  computeGlobalVerdict,
  computeFileVerdict,
  aggregateReviews,
} from './review-data.js';
export type { RunStats, TriageStats } from './review-data.js';

export {
  axisHealthPercent,
  REPORT_AXIS_IDS,
  docCommentTerm,
  buildAxisReports,
  toReportAxisId,
} from './axis-registry.js';
export type { ReportAxisId, AxisReport } from './axis-registry.js';

export {
  renderDocModeLine,
  renderDivergenceSection,
  aggregateDivergences,
  aggregateStaleReferences,
  renderStaleReferenceSection,
  renderDocConflictSection,
  applyPendingConflictsToReviews,
  applyInvariantFindingsToReviews,
} from './doc-divergences.js';

export { makeActId } from './render-axis.js';

export { renderIndex, renderPublicIndex } from './render-report.js';

export { writeReviewOutput, writeTranscript } from './review-writer.js';

export { injectBadge } from './badge.js';
