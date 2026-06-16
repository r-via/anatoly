// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Deterministic user-flow modeling (doc 23, Stage 1).
 *
 * Pure graph code that derives `UserFlow` skeletons from the in-memory RAG
 * cards + usage graph and persists them to a canonical state artifact. No LLM,
 * zero scored findings.
 */

export {
  buildFlowSkeletons,
  DEFAULT_FLOW_WALK_CAPS,
  type FlowWalkCaps,
  type BuildFlowSkeletonsInput,
} from './flow-walk.js';
export {
  writeFlowArtifact,
  flowArtifactPath,
  FLOW_ARTIFACT_FILENAME,
} from './flow-writer.js';
