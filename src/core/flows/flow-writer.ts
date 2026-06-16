// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Persist the deterministic user-flow artifact (doc 23, section 3.3).
 *
 * The artifact follows the internal-docs persistence model, NOT the per-run
 * findings model: it is re-derived and overwritten in place at a stable,
 * well-known path (`.anatoly/state/internal-flows/flows.json`) every run, so
 * every consumer (the future dead-intent router, the conformance matcher, a web
 * UI, external runtime tools) reads one canonical location. The on-disk JSON is
 * the source of truth; any future markdown is a one-way render of it.
 */

import { anatolyPath } from '../../utils/anatoly-paths.js';
import { atomicWriteJson } from '../../utils/cache.js';
import {
  USER_FLOW_ARTIFACT_VERSION,
  UserFlowArtifactSchema,
  type UserFlow,
  type UserFlowArtifact,
} from '../../schemas/user-flow.js';

/** The well-known artifact filename under `.anatoly/state/internal-flows/`. */
export const FLOW_ARTIFACT_FILENAME = 'flows.json';

/** Resolve the canonical artifact path for a project root. */
export function flowArtifactPath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'state/internal-flows', FLOW_ARTIFACT_FILENAME);
}

/**
 * Write the flow skeletons to the canonical artifact path, overwriting any
 * prior artifact. Validates against the schema before writing so a malformed
 * artifact is never persisted. `atomicWriteJson` creates the directory and
 * writes via tmp + rename. Returns the path written.
 */
export function writeFlowArtifact(projectRoot: string, flows: UserFlow[]): string {
  const artifact: UserFlowArtifact = {
    version: USER_FLOW_ARTIFACT_VERSION,
    flowCount: flows.length,
    flows,
  };
  // Parse (not just assert) so we persist exactly the validated shape.
  const validated = UserFlowArtifactSchema.parse(artifact);
  const path = flowArtifactPath(projectRoot);
  atomicWriteJson(path, validated);
  return path;
}
