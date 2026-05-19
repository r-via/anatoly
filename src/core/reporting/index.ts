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

export {
  generateReport,
  loadReviews,
  axisHealthPercent,
  REPORT_AXIS_IDS,
  makeActId,
  computeGlobalVerdict,
  computeFileVerdict,
  renderDocModeLine,
  docCommentTerm,
  renderDivergenceSection,
  aggregateDivergences,
  renderIndex,
  aggregateReviews,
  buildAxisReports,
  renderPublicIndex,
  aggregateStaleReferences,
  renderStaleReferenceSection,
  renderDocConflictSection,
  applyPendingConflictsToReviews,
} from './reporter.js';
export type { ReportAxisId, AxisReport, RunStats, TriageStats } from './reporter.js';

export { writeReviewOutput, writeTranscript } from './review-writer.js';

export { injectBadge } from './badge.js';
