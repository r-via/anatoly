// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc 14 PR 1 completeness gate + behaviour lock for the orchestration event
 * vocabulary.
 *
 * Two jobs:
 *   1. Convention completeness: `PHASE_EVENT_CONTRACT` covers exactly
 *      `CANONICAL_PHASES`, references only vocabulary members, and never
 *      lists the global boundary events. A new phase added to
 *      `CANONICAL_PHASES` without a contract entry fails CI here, which is
 *      the doc 14 §9 invariant 3 "a unit must declare its event set" applied
 *      at the phase grain.
 *   2. Behaviour lock: `emitPhaseStart` / `emitPhaseEnd` produce the exact
 *      pre-PR-1 run-phase.ts shapes (timeline entry key sets, the two log
 *      sinks, the exact messages). The spine golden reads
 *      `timeline.filter(e => e.event === 'phase_start').map(e => e.phase)`,
 *      so the phase_start entry key set is contractual; this test fails fast
 *      and in-process if it ever drifts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ORCHESTRATION_EVENTS,
  PHASE_EVENT_CONTRACT,
  isOrchestrationEvent,
  emitPhaseStart,
  emitPhaseEnd,
  type PhaseEventSink,
} from './events.js';
import { CANONICAL_PHASES } from './run-phase.js';

const VOCAB = new Set<string>(ORCHESTRATION_EVENTS);

describe('ORCHESTRATION_EVENTS vocabulary', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(ORCHESTRATION_EVENTS)).toBe(true);
  });

  it('has no duplicate names', () => {
    expect(new Set(ORCHESTRATION_EVENTS).size).toBe(ORCHESTRATION_EVENTS.length);
  });

  it('includes the two global boundary events', () => {
    expect(VOCAB.has('phase_start')).toBe(true);
    expect(VOCAB.has('phase_end')).toBe(true);
  });

  it('isOrchestrationEvent is an exact membership predicate', () => {
    expect(isOrchestrationEvent('file_review_end')).toBe(true);
    expect(isOrchestrationEvent('not_an_event')).toBe(false);
  });
});

describe('PHASE_EVENT_CONTRACT completeness (doc 14 §9 inv. 3, phase grain)', () => {
  it('keys are exactly CANONICAL_PHASES (no missing, no extra)', () => {
    expect(Object.keys(PHASE_EVENT_CONTRACT).sort()).toEqual([...CANONICAL_PHASES].sort());
  });

  it('every declared body event is a vocabulary member', () => {
    for (const [phase, events] of Object.entries(PHASE_EVENT_CONTRACT)) {
      for (const e of events) {
        expect(VOCAB.has(e), `phase "${phase}" declares unknown event "${e}"`).toBe(true);
      }
    }
  });

  it('never lists the global boundary events per-phase (they are runPhase-global)', () => {
    for (const [phase, events] of Object.entries(PHASE_EVENT_CONTRACT)) {
      expect(events, `phase "${phase}" must not list phase_start`).not.toContain('phase_start');
      expect(events, `phase "${phase}" must not list phase_end`).not.toContain('phase_end');
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour lock — emitters reproduce the pre-PR-1 run-phase.ts shapes exactly
// ---------------------------------------------------------------------------

function makeSink() {
  const timeline: PhaseEventSink['timeline'] = [];
  const runLogInfo = vi.fn();
  const ctx: PhaseEventSink = {
    runId: 'run-xyz',
    timeline,
    runLog: { info: runLogInfo } as unknown as PhaseEventSink['runLog'],
  };
  return { ctx, timeline, runLogInfo };
}

describe('emitPhaseStart', () => {
  it('pushes a timeline entry whose key set is exactly {event,phase,t}', () => {
    const { ctx, timeline } = makeSink();
    emitPhaseStart(ctx, { info: vi.fn() }, 'review', 42);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toEqual({ event: 'phase_start', phase: 'review', t: 42 });
    // exact key set — the spine golden depends on `event` + `phase`
    expect(Object.keys(timeline[0]).sort()).toEqual(['event', 'phase', 't']);
  });

  it('logs to getLogger and ctx.runLog with the exact legacy shape + message', () => {
    const { ctx, runLogInfo } = makeSink();
    const log = { info: vi.fn() };
    emitPhaseStart(ctx, log, 'scan', 0);
    expect(log.info).toHaveBeenCalledWith(
      { event: 'phase_start', phase: 'scan', runId: 'run-xyz' },
      'phase started',
    );
    expect(runLogInfo).toHaveBeenCalledWith(
      { event: 'phase_start', phase: 'scan', runId: 'run-xyz' },
      'phase started',
    );
  });

  it('does not throw when runLog is absent', () => {
    const timeline: PhaseEventSink['timeline'] = [];
    const ctx: PhaseEventSink = { runId: 'r', timeline };
    expect(() => emitPhaseStart(ctx, { info: vi.fn() }, 'report', 1)).not.toThrow();
    expect(timeline).toHaveLength(1);
  });
});

describe('emitPhaseEnd', () => {
  it('pushes a timeline entry whose key set is exactly {event,phase,durationMs,t}', () => {
    const { ctx, timeline } = makeSink();
    emitPhaseEnd(ctx, { info: vi.fn() }, 'review', 1234, 99);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toEqual({ event: 'phase_end', phase: 'review', durationMs: 1234, t: 99 });
    expect(Object.keys(timeline[0]).sort()).toEqual(['durationMs', 'event', 'phase', 't']);
  });

  it('logs symmetric phase_end to both sinks with durationMs and the exact message', () => {
    const { ctx, runLogInfo } = makeSink();
    const log = { info: vi.fn() };
    emitPhaseEnd(ctx, log, 'refinement', 7, 8);
    const expected = { event: 'phase_end', phase: 'refinement', durationMs: 7, runId: 'run-xyz' };
    expect(log.info).toHaveBeenCalledWith(expected, 'phase ended');
    expect(runLogInfo).toHaveBeenCalledWith(expected, 'phase ended');
  });
});
