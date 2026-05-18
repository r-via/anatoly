// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The orchestration policy gates (doc 14 §6 / PR 5).
 *
 * This is the "centralized rules" half: the run/skip *predicates* and the
 * skip-reason *vocabulary* for the three gated phases, lifted out of the
 * inline if/else scattered through pipeline.ts:144-292 into one readable
 * table. doc 14 §6, kept to the letter: the spine stays a concrete
 * procedural function; this module is **data the procedural spine reads**
 * (`gate(ctx, handoff) -> {run|skip+reason}`), never a program a generic
 * executor runs. The phase bodies, sub-phases (`doc-conflict-*`),
 * `writeScaffoldStatus`, `reindexDocsAfterUpdate`, the `completeTask` UI
 * calls and `handoff` mutation stay in the spine: they are the phase work,
 * not the gate.
 *
 * Behaviour-preserving by construction: every predicate below is the exact
 * boolean the spine evaluated inline, and every `reason` is the verbatim
 * `pipelineState.completeTask(...)` string the spine passed (the em dashes in
 * `'skipped — ...'` are part of the existing UI literal: byte-verbatim, not
 * prose). `resolveDocMode` is pure (reads `ctx.config`), so computing it per
 * gate instead of once in the spine is a free, observably-identical call.
 *
 * `RunContext` is type-only (erased): no runtime dependency on the commands
 * layer, mirroring the rest of `orchestration/`.
 */

import { resolveDocMode } from '../run/index.js';
import { isDocAxisActive } from '../evaluation/index.js';
import type { Handoff } from './handoff.js';
import type { RunContext } from '../../commands/run.js';

/**
 * One gate's verdict. `run: true` -> the spine executes the phase body.
 * `run: false` with a `reason` -> the spine records the skip via
 * `pipelineState.completeTask(phase, reason)` exactly as before. `run: false`
 * with no `reason` -> a silent skip (the pre-PR-5 implicit `else` that did
 * nothing: bootstrap-doc when `full` but not first-run; refinement when no
 * files were reviewed).
 */
export interface GateDecision {
  readonly run: boolean;
  readonly reason?: string;
}

/**
 * bootstrap-doc gate (was pipeline.ts:148-159). Mode `off`/`lite` skip with
 * their reason; `full` runs only on the first run with the doc axis active;
 * otherwise a silent skip (verbatim: the old code had no `else`).
 */
export function bootstrapDocGate(ctx: RunContext, handoff: Handoff): GateDecision {
  const mode = resolveDocMode(ctx.config);
  if (mode === 'off') return { run: false, reason: 'off' };
  if (mode === 'lite') return { run: false, reason: 'lite (per-file retrieval)' };
  if (handoff.isFirstRun && isDocAxisActive(ctx)) return { run: true };
  return { run: false };
}

/**
 * internal-docs gate (was pipeline.ts:198-242). `off`/`lite` skip with their
 * reason; otherwise (`full`) run iff there is at least one evaluable file,
 * else skip with the no-evaluable reason. The triage source is
 * `handoff.triageMap`, the identical ref to the pre-PR-4b `setup.triageMap`.
 */
export function internalDocsGate(ctx: RunContext, handoff: Handoff): GateDecision {
  const mode = resolveDocMode(ctx.config);
  if (mode === 'off') return { run: false, reason: 'off' };
  if (mode === 'lite') return { run: false, reason: 'lite (per-file retrieval)' };
  const hasEvaluableFiles = [...handoff.triageMap.values()].some((t) => t.tier === 'evaluate');
  if (hasEvaluableFiles) return { run: true };
  return { run: false, reason: 'skipped — no evaluable files' };
}

/**
 * refinement gate (was pipeline.ts:264-268). Run when deliberation is on and
 * files were reviewed; skip-with-reason when files were reviewed but
 * deliberation is off; silent skip when nothing was reviewed.
 */
export function refinementGate(ctx: RunContext, handoff: Handoff): GateDecision {
  if (ctx.deliberation && handoff.filesReviewed > 0) return { run: true };
  if (handoff.filesReviewed > 0) return { run: false, reason: 'skipped — deliberation disabled' };
  return { run: false };
}
