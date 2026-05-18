// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Story 55.9 — AC1: forecastRun includes doc-conflict-detector step
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC1: doc-conflict-detector forecast step', () => {
  it('estimator.ts exports DOC_CONFLICT_DETECTOR_TOKENS constant', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'run', 'estimator.ts'), 'utf-8');
    expect(src).toContain('DOC_CONFLICT_DETECTOR_TOKENS');
  });

  it('forecastRun adds conflict-detection step when docMode is full', async () => {
    // Structural: forecastRun handles docConflictDetection input
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'run', 'estimator.ts'), 'utf-8');
    expect(src).toContain('conflict-detection');
    expect(src).toContain('docConflictDetection');
  });

  it('ForecastInputs includes docConflictDetection field', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'run', 'estimator.ts'), 'utf-8');
    expect(src).toContain('docConflictDetection');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC2: runDocCoherenceReview cost in forecastRun
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC2: coherence-review in forecast', () => {
  it('DOC_COHERENCE_PER_PAGE is used in forecastRun (bootstrap mode)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'run', 'estimator.ts'), 'utf-8');
    expect(src).toContain('DOC_COHERENCE_PER_PAGE');
    expect(src).toContain("name: 'coherence'");
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC3: doc-pipeline costs clearly separated in breakdown
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC3: doc-pipeline costs separated', () => {
  it('estimate.ts renders doc-pipeline steps with internal-doc category', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'estimate.ts'), 'utf-8');
    expect(src).toContain('internal-doc');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC4: run-metrics.json includes doc-conflict-detection phase
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC4: run-metrics includes doc-conflict-detection', () => {
  // PR 8a (doc 11): the spine moved verbatim from run.ts to pipeline.ts.
  // These assert spine wiring, so they read the pipeline module now. The
  // former incidental `toContain('phaseDurations')` (which matched the
  // RunContext interface, not behavior) is dropped: per-phase timing is
  // directly guarded by the spine golden's phaseDurationKeys projection.
  it('pipeline captures doc-conflict timing via runPhase (bootstrap + update)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'orchestration', 'pipeline.ts'), 'utf-8');
    // Story 56.8 split doc-conflict-detection into two distinct phases
    expect(src).toContain("'doc-conflict-bootstrap'");
    expect(src).toContain("'doc-conflict-update'");
  });

  it('pipeline wraps runDocConflictDetection calls in runPhase for timing', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'orchestration', 'pipeline.ts'), 'utf-8');
    // Both calls (after bootstrap and after update) should be timed via runPhase
    const calls = [...src.matchAll(/runDocConflictDetection\(/g)];
    expect(calls.length).toBe(2);
    // Each call should be wrapped in a runPhase call nearby (handles timing internally).
    for (const call of calls) {
      const nearby = src.slice(Math.max(0, call.index! - 300), call.index! + 300);
      expect(nearby).toContain('runPhase(');
    }
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC5+AC6: pending conflicts hint at run start
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC5+AC6: pending conflicts hint at start', () => {
  // PR 3 (doc 11) moved the setup stage (incl. the start-of-run pending
  // conflicts hint) out of run.ts into the setup phase module. The hint
  // behavior is unchanged; only its file location moved.
  const setupSrc = join(process.cwd(), 'src', 'core', 'orchestration', 'phases', 'setup.ts');

  it('setup phase loads pending conflict count and shows hint', () => {
    const src = readFileSync(setupSrc, 'utf-8');
    // Should load doc conflicts to count pending entries
    expect(src).toContain('pendingConflicts');
    // Should mention the docs arbitrate command in the hint
    expect(src).toContain('anatoly docs arbitrate');
  });

  it('setup phase shows p.note() for pending conflicts in non-plain mode', () => {
    const src = readFileSync(setupSrc, 'utf-8');
    expect(src).toContain('p.note(');
    expect(src).toContain('pending');
    expect(src).toContain('doc conflict');
  });

  it('setup phase emits stderr line in plain mode for pending conflicts', () => {
    const src = readFileSync(setupSrc, 'utf-8');
    expect(src).toContain('process.stderr.write');
    expect(src).toContain('doc conflict');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC7: end-of-run pending conflicts reminder
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC7: end-of-run reminder', () => {
  // PR 2 (doc 11) moved the report phase (incl. setSummary, the plain-mode
  // summary, and the pending-conflicts reminder) out of run.ts into the
  // report phase module. The reminder behavior is unchanged; only its file
  // location moved, so these source assertions now target report.ts.
  const reportSrc = join(process.cwd(), 'src', 'core', 'orchestration', 'phases', 'report.ts');

  it('report phase checks for pending conflicts at end of run', () => {
    const src = readFileSync(reportSrc, 'utf-8');
    // After the summary, should load conflicts and print reminder
    const summaryIdx = src.indexOf('setSummary');
    expect(summaryIdx).toBeGreaterThan(-1);
    // The pending conflict check should appear after the summary
    const afterSummary = src.slice(summaryIdx);
    expect(afterSummary).toContain('doc conflicts pending');
    expect(afterSummary).toContain('anatoly docs arbitrate');
  });

  it('end-of-run reminder appears in both TUI and plain mode', () => {
    const src = readFileSync(reportSrc, 'utf-8');
    // Should have the reminder after the plain-mode summary block too
    const afterPlainSummary = src.slice(src.indexOf("ctx.plain || !state"));
    expect(afterPlainSummary).toContain('doc conflicts pending');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — Structural: wiring
// ---------------------------------------------------------------------------

describe('Story 55.9 — structural wiring', () => {
  it('estimate.ts passes docConflictDetection to forecastRun', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'estimate.ts'), 'utf-8');
    expect(src).toContain('docConflictDetection');
  });

  it('setup phase passes docConflictDetection to forecastRun', () => {
    // PR 3 (doc 11): the forecast wiring moved with the setup phase.
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'orchestration', 'phases', 'setup.ts'), 'utf-8');
    expect(src).toContain('docConflictDetection');
  });
});
