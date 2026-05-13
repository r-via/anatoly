// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ComposerEntry } from './types.js';

// Axis composers (7)
import { axesUtilityComposer } from './axes/utility.js';
import { axesDuplicationComposer } from './axes/duplication.js';
import { axesCorrectionComposer } from './axes/correction.js';
import { axesOverengineeringComposer } from './axes/overengineering.js';
import { axesTestsComposer } from './axes/tests.js';
import { axesBestPracticesComposer } from './axes/best-practices.js';
import { axesDocumentationComposer } from './axes/documentation.js';

// Pipeline composers (4)
import { reviewPipelineComposer } from './pipelines/review-pipeline.js';
import { docConflictPipelineComposer } from './pipelines/doc-conflict-pipeline.js';
import { docUpdatePipelineComposer } from './pipelines/doc-update-pipeline.js';
import { refinementPipelineComposer } from './pipelines/refinement-pipeline.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const entries: ComposerEntry[] = [
  // Axes
  axesUtilityComposer,
  axesDuplicationComposer,
  axesCorrectionComposer,
  axesOverengineeringComposer,
  axesTestsComposer,
  axesBestPracticesComposer,
  axesDocumentationComposer,
  // Pipelines
  reviewPipelineComposer,
  docConflictPipelineComposer,
  docUpdatePipelineComposer,
  refinementPipelineComposer,
];

/**
 * Registry of all named composers with their declarative DAG plans.
 * Each entry declares its execution plan, input/output schemas.
 */
export const COMPOSERS: ReadonlyMap<string, ComposerEntry> = new Map(
  entries.map((e) => [e.name, e]),
);
