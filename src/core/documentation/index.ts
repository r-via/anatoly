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
  writeCoherenceStatus,
  computeDocSetSignature,
  coherenceUpToDate,
} from './generation/doc-bootstrap.js';

export { scaffoldDocs } from './generation/doc-scaffolder.js';
