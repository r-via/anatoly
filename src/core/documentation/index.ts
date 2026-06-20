// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `documentation/` bounded context: the internal-docs phase. The largest
 * context (doc 12 §3.1), organized into four sub-folders
 * (`generation/`, `conflict/`, `reporting/`, `resolution/`). This is the
 * single published surface (doc 12 §1 rule 1): one barrel per bounded
 * context, not per sub-folder. Sub-folders import each other relatively;
 * everything outside `documentation/` imports this barrel.
 *
 * Built incrementally across doc 13 PRs 6a to 6d. The surface is exactly
 * the symbols current external importers use, no speculative API (doc 13
 * §8). PR 6a: generation/.
 */

// --- generation/ (doc 13 PR 6a) ---
export {
  runDocScaffold,
  runDocGeneration,
  commitDocPage,
  computeScaffoldPageList,
} from './generation/doc-pipeline.js';
export type { DocPipelineResult } from './generation/doc-pipeline.js';

export {
  executeDocPrompts,
  reviewDocStructure,
  runDocCoherenceReview,
  autoFixStructuralIssues,
} from './generation/doc-llm-executor.js';
export type { DocExecutor } from './generation/doc-llm-executor.js';

export {
  needsBootstrap,
  writeScaffoldStatus,
  readScaffoldStatus,
  writeCoherenceStatus,
  computeDocSetSignature,
  coherenceUpToDate,
} from './generation/doc-bootstrap.js';

export { scaffoldDocs } from './generation/doc-scaffolder.js';

// --- conflict/ (doc 13 PR 6b) ---
export {
  runDocConflictDetection,
  enrichDetectedConflict,
  detectNewConflictsViaLlm,
  derivePresumption,
  getGitTimestamp,
} from './conflict/doc-conflict-detector.js';

export type { DetectedConflictItem } from './conflict/doc-conflict-llm.js';

export {
  loadDocConflicts,
  saveDocConflicts,
  countPendingDocConflicts,
} from './conflict/doc-conflict-store.js';

export { buildCodeSurfaceSummary } from './conflict/doc-coherence-3way.js';

export { loadCodeWinsAsStaleReferences, loadPendingConflictsAsDocConflicts } from './conflict/doc-stale-reference.js';

export {
  refreshPendingConflicts,
  buildRefreshUserMessage,
  REFRESH_SYSTEM_PROMPT,
  RefreshDecisionSchema,
  RefreshResponseSchema,
} from './conflict/doc-conflict-refresh.js';
export type { RefreshOpts, RefreshSummary, RefreshResult, RefreshDecision } from './conflict/doc-conflict-refresh.js';

// --- reporting/ (doc 13 PR 6c) ---
export { aggregateDocReport } from './reporting/doc-report-aggregator.js';
export type { DocReportResult } from './reporting/doc-report-aggregator.js';
export type { DocReportStats, SymbolCoverage, SyncByType } from './reporting/doc-report-section.js';

export { detectDocGapsV2, formatGapReportV2 } from './reporting/doc-gap-detection.js';

// --- resolution/ (doc 13 PR 6d) ---
export {
  resolveRelevantDocsViaRag,
  resolveAllRelevantDocs,
  buildDocsTree,
} from './resolution/docs-resolver.js';

export type { ReferenceDoc } from './resolution/reference-docs-resolver.js';

export {
  defaultDocumentationConfig,
  detectDocPaths,
  quickInitDocConfig,
  buildDocumentationConfig,
} from './resolution/documentation-config.js';
export type { DocWizardSelections } from './resolution/documentation-config.js';
