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
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'estimator.ts'), 'utf-8');
    expect(src).toContain('DOC_CONFLICT_DETECTOR_TOKENS');
  });

  it('forecastRun adds conflict-detection step when docMode is full', async () => {
    // Structural: forecastRun handles docConflictDetection input
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'estimator.ts'), 'utf-8');
    expect(src).toContain('conflict-detection');
    expect(src).toContain('docConflictDetection');
  });

  it('ForecastInputs includes docConflictDetection field', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'estimator.ts'), 'utf-8');
    expect(src).toContain('docConflictDetection');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC2: runDocCoherenceReview cost in forecastRun
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC2: coherence-review in forecast', () => {
  it('DOC_COHERENCE_PER_PAGE is used in forecastRun (bootstrap mode)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'estimator.ts'), 'utf-8');
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
  it('run.ts captures doc-conflict-detection duration in phaseDurations', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    expect(src).toContain("'doc-conflict-detection'");
    expect(src).toContain('phaseDurations');
  });

  it('run.ts records doc-conflict-detection timing around runDocConflictDetection calls', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    // Both calls (after bootstrap and after update) should be timed
    const calls = [...src.matchAll(/runDocConflictDetection\(/g)];
    expect(calls.length).toBe(2);
    // Each call should have a Date.now() timing measurement nearby.
    // Window widened to 600 chars on each side after phase_start/phase_end
    // ndjson emissions were added inline to the call site (UI bug fix).
    for (const call of calls) {
      const nearby = src.slice(Math.max(0, call.index! - 600), call.index! + 600);
      expect(nearby).toContain('Date.now()');
    }
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC5+AC6: pending conflicts hint at run start
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC5+AC6: pending conflicts hint at start', () => {
  it('run.ts loads pending conflict count and shows hint', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    // Should load doc conflicts to count pending entries
    expect(src).toContain('pendingConflicts');
    // Should mention the docs arbitrate command in the hint
    expect(src).toContain('anatoly docs arbitrate');
  });

  it('run.ts shows p.note() for pending conflicts in non-plain mode', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    expect(src).toContain('p.note(');
    expect(src).toContain('pending');
    expect(src).toContain('doc conflict');
  });

  it('run.ts emits stderr line in plain mode for pending conflicts', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    expect(src).toContain('process.stderr.write');
    expect(src).toContain('doc conflict');
  });
});

// ---------------------------------------------------------------------------
// Story 55.9 — AC7: end-of-run pending conflicts reminder
// ---------------------------------------------------------------------------

describe('Story 55.9 — AC7: end-of-run reminder', () => {
  it('run.ts checks for pending conflicts at end of run', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    // After the summary, should load conflicts and print reminder
    const summaryIdx = src.indexOf('setSummary');
    expect(summaryIdx).toBeGreaterThan(-1);
    // The pending conflict check should appear after the summary
    const afterSummary = src.slice(summaryIdx);
    expect(afterSummary).toContain('doc conflicts pending');
    expect(afterSummary).toContain('anatoly docs arbitrate');
  });

  it('end-of-run reminder appears in both TUI and plain mode', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
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

  it('run.ts passes docConflictDetection to forecastRun', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'run.ts'), 'utf-8');
    expect(src).toContain('docConflictDetection');
  });
});
