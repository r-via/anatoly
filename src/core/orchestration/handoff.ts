// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Typed inter-phase handoff contract (doc 11 Strategy B).
 *
 * This module is the single typed home for what one phase produces that a
 * later phase consumes. It is introduced in PR 3 carrying the setup phase's
 * output (`SetupResult`) and grows one phase at a time (PRs 4 to 7). PR 8
 * replaces the ad-hoc `RunContext` field mutation for the §4 inter-phase
 * subset with this object passed explicitly through the pipeline.
 *
 * Until PR 8 the data still flows the way it always has (return values +
 * `ctx` mutation); this module only owns the *types*, so introducing it is a
 * move-only, behavior-preserving step. Do not add behavior here.
 *
 * `SetupResult` moved verbatim from `commands/run.ts` (PR 3); it is the
 * return type of the setup phase and the upstream input every later phase
 * reads (`tasks`, `triageMap`, `usageGraph`, `depMeta`, project/doc trees).
 */

import type { Task } from '../../schemas/task.js';
import type { TriageResult } from '../triage.js';
import type { UsageGraph } from '../usage-graph.js';
import type { DependencyMeta } from '../dependency-meta.js';

export interface SetupResult {
  files: number;
  tasks: Task[];
  triageMap: Map<string, TriageResult>;
  usageGraph?: UsageGraph;
  depMeta?: DependencyMeta;
  projectTree?: string;
  docsTree?: string | null;
  internalDocsTree?: string | null;
  internalDocsDir?: string;
}
