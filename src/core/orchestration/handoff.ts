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
import type { VectorStore } from '../../rag/vector-store.js';
import type { ResolvedModels } from '../../rag/hardware-detect.js';
import type { DocPipelineResult } from '../doc-pipeline.js';
import type { DocReportResult } from '../doc-report-aggregator.js';
import type { ArbitratedFragment } from '../axes/reference-docs-context.js';

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

/**
 * Rag phase output (moved verbatim from commands/run.ts in PR 4, doc 11).
 * The `rag-index` phase returns this; `review` and the post-doc-update
 * re-index consume `vectorStore`.
 */
export interface RagContext {
  vectorStore?: VectorStore;
  ragEnabled: boolean;
}


/**
 * The §4 inter-phase handoff (doc 11 PR 8c). These are exactly the values one
 * phase produces that a later phase consumes. They were loose mutable fields
 * on the RunContext god object; PR 8c moves them into this typed object,
 * created once in the pipeline and passed explicitly to every phase, so the
 * handoff is no longer conflated with RunContext's runtime/UI/lifecycle
 * state. Runtime accounting (totalCostUsd, providerStats, axisStats) and
 * lifecycle (interrupted, fatalError, lockPath, renderer, ...) stay on
 * RunContext: they are not inter-phase handoff.
 *
 * `resolvedModels` may be seeded from the pre-pipeline pricing pre-flight
 * (run.ts) via {@link createHandoff}; every other field starts empty/zero and
 * is filled by the phase that owns it.
 */
export interface Handoff {
  /** setup -> doc/report: every scanned task. */
  allTasks: Task[];
  /** setup -> doc/report: triage classification per file. */
  triageMap: Map<string, TriageResult>;
  /** pricing pre-flight (seed) / rag / setup: resolved embedding models. */
  resolvedModels?: ResolvedModels;
  /** pipeline gate: first run (no .anatoly/docs yet). */
  isFirstRun: boolean;
  /** doc-conflict arbitration -> review axes: doc-wins fragments. */
  arbitratedFragments?: ArbitratedFragment[];
  /** doc phases -> report: scaffold + generation result. */
  docPipelineResult?: DocPipelineResult;
  /** report: aggregated doc-coverage result. */
  docReportResult?: DocReportResult;
  /** review/refinement -> report + spine gates: files reviewed. */
  filesReviewed: number;
  /** review/refinement -> report + spine summaries: net findings. */
  totalFindings: number;
  /** review -> report: total files in scope. */
  totalFiles: number;
}

/**
 * Create the handoff for one pipeline run. `seed.resolvedModels` carries the
 * pre-pipeline pricing pre-flight value (run.ts) so it is not lost when the
 * field moves off RunContext.
 */
export function createHandoff(seed?: { resolvedModels?: ResolvedModels }): Handoff {
  return {
    allTasks: [],
    triageMap: new Map(),
    isFirstRun: false,
    filesReviewed: 0,
    totalFindings: 0,
    totalFiles: 0,
    ...(seed?.resolvedModels ? { resolvedModels: seed.resolvedModels } : {}),
  };
}
