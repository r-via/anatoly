// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The orchestration event vocabulary and the phase-boundary emitter
 * (doc 14 PR 1, the convention-first first slice).
 *
 * This module is the single enumerable home of every event name the
 * orchestration layer surfaces, the per-phase contract that says which body
 * events a phase is expected to produce, and the emitter that fires the
 * phase-boundary triple identically for every phase.
 *
 * PR 1 scope, deliberately narrow (doc 14 §8 "at the phase grain inside
 * runPhase, lowest risk first"):
 *   - `ORCHESTRATION_EVENTS` / `OrchestrationEventName`: the complete, typed,
 *     enumerable vocabulary. Free-string `event:` literals across the phases
 *     are replaced by references into this union, verbatim (same runtime
 *     string, now compile-checked). This is what makes "every event is listed
 *     under one convention" true rather than aspirational.
 *   - `PHASE_EVENT_CONTRACT`: per-phase declared body-event set. Boundary
 *     events (`phase_start` / `phase_end`) are global: `runPhase` fires them
 *     for every phase, so they are not listed per-phase.
 *   - `emitPhaseStart` / `emitPhaseEnd`: the byte-equivalent centralisation
 *     of the run-phase.ts boundary triple (timeline.push + getLogger().info +
 *     ctx.runLog?.info, with the exact legacy field sets and messages). No
 *     behaviour change: run-phase.test.ts and the spine golden are the proof.
 *
 * Out of PR 1 scope: routing the heterogeneous phase-body sites (review.ts
 * file_review_* etc., each with its own sink/level/message) through a single
 * fan-out emitter. Those are weakly covered by the goldens and must not ride
 * this bench gate; that centralisation belongs to the harness PR (doc 14 §8
 * PR 2/4). Do not add behaviour here.
 *
 * Type-only imports from `./run-phase.js` (erased): no runtime cycle, even
 * though run-phase.ts imports the emitters from this module.
 */

import type { Logger } from '../../utils/logger.js';
import type { PhaseName } from './run-phase.js';

// ---------------------------------------------------------------------------
// The vocabulary (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Every event name the orchestration layer emits, boundary and body. Frozen
 * so the list cannot be mutated at runtime; the array order has no semantic
 * meaning (it is a set).
 */
export const ORCHESTRATION_EVENTS = Object.freeze([
  // boundary (runPhase, every phase)
  'phase_start',
  'phase_end',
  // body
  'estimate_total',
  'stale_task_dropped',
  'file_triage',
  'rag_progress',
  'file_review_start',
  'file_review_end',
  'file_cached',
  'file_cache_miss',
  'file_skip',
  'retry',
  'standby',
] as const);

export type OrchestrationEventName = (typeof ORCHESTRATION_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(ORCHESTRATION_EVENTS);

/** True when `name` is a member of the canonical vocabulary. */
export function isOrchestrationEvent(name: string): name is OrchestrationEventName {
  return EVENT_SET.has(name);
}

// ---------------------------------------------------------------------------
// The per-phase body-event contract
// ---------------------------------------------------------------------------

/**
 * The body events each phase is expected to surface, grounded at HEAD
 * `ab1034e` against the actual emission sites:
 *   - triage: setup.ts emits `file_triage` under `phase:'triage'`
 *   - rag-index: rag.ts emits `rag_progress`
 *   - review: review.ts emits the file_* lifecycle, estimate_total, retry,
 *     standby
 *   - every other phase: no body event today (boundary only)
 *
 * `phase_start` / `phase_end` are intentionally absent: they are global,
 * fired by `runPhase` for every phase, so listing them per-phase would be
 * redundant noise. The completeness test asserts this map's keys are exactly
 * `CANONICAL_PHASES` and every listed value is in `ORCHESTRATION_EVENTS`.
 */
export const PHASE_EVENT_CONTRACT = Object.freeze({
  scan: [],
  estimate: ['stale_task_dropped'],
  triage: ['file_triage'],
  'bootstrap-doc': [],
  'doc-conflict-bootstrap': [],
  'rag-index': ['rag_progress'],
  flows: [],
  'internal-docs': [],
  'rag-index-update': [],
  'doc-conflict-update': [],
  review: [
    'estimate_total',
    'file_review_start',
    'file_review_end',
    'file_cached',
    'file_cache_miss',
    'file_skip',
    'retry',
    'standby',
  ],
  invariants: [],
  refinement: [],
  report: [],
} as const) satisfies Record<PhaseName, readonly OrchestrationEventName[]>;

// ---------------------------------------------------------------------------
// The phase-boundary emitter
// ---------------------------------------------------------------------------

/**
 * Structural subset of the run context the boundary emitter touches. Kept
 * structural (not an import of the full RunContext) for the same reason
 * `RunPhaseContext` is: no dependency on the commands layer, no cycle.
 */
export interface PhaseEventSink {
  runId: string;
  timeline: Array<{ t: number; event: string; [k: string]: unknown }>;
  runLog?: Pick<Logger, 'info'>;
}

/**
 * Fire the `phase_start` triple, byte-equivalent to the pre-PR-1 run-phase.ts
 * inline form: timeline push, `getLogger().info`, `ctx.runLog?.info`, with the
 * exact field set (`event`, `phase`, `runId`) and message (`'phase started'`).
 * `tOffset` is passed in (never recomputed) so the timeline `t` is identical
 * to the legacy `phaseStartedAt - ctx.startTime`.
 */
export function emitPhaseStart(
  ctx: PhaseEventSink,
  log: Pick<Logger, 'info'>,
  phase: PhaseName,
  tOffset: number,
): void {
  ctx.timeline.push({ event: 'phase_start', phase, t: tOffset });
  log.info({ event: 'phase_start', phase, runId: ctx.runId }, 'phase started');
  ctx.runLog?.info({ event: 'phase_start', phase, runId: ctx.runId }, 'phase started');
}

/**
 * Fire the `phase_end` triple, byte-equivalent to the pre-PR-1 run-phase.ts
 * inline form (timeline push with `durationMs` + `t`, symmetric
 * `getLogger().info` + `ctx.runLog?.info`, message `'phase ended'`). Fires on
 * both success and error, exactly as `fireExitEffects` did. The
 * `phaseDurations[name]` assignment stays in run-phase.ts: it is run
 * accounting, not an event, and is asserted independently.
 */
export function emitPhaseEnd(
  ctx: PhaseEventSink,
  log: Pick<Logger, 'info'>,
  phase: PhaseName,
  durationMs: number,
  tOffset: number,
): void {
  ctx.timeline.push({ event: 'phase_end', phase, durationMs, t: tOffset });
  log.info({ event: 'phase_end', phase, durationMs, runId: ctx.runId }, 'phase ended');
  ctx.runLog?.info({ event: 'phase_end', phase, durationMs, runId: ctx.runId }, 'phase ended');
}
