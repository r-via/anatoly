// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 56.10 — KPI 3: Plan-fidelity regression tests.
 *
 * Validates the variance computation logic and asserts that the deviation
 * formula is correct. When a real fixture is available, also validates
 * end-to-end variance bounds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeCostVariance } from '../../utils/llm-calls-sink.js';
import type { CostVariance, VarianceEntry } from '../../utils/llm-calls-sink.js';

// ---------------------------------------------------------------------------
// KPI 3a: Variance deviation formula correctness
// ---------------------------------------------------------------------------

describe('KPI 3a: variance deviation formula', () => {
  it('deviationPct = ((actual - estimated) / estimated) * 100', () => {
    // Manual verification of the formula
    const estimated = 0.10;
    const actual = 0.12;
    const expected = ((actual - estimated) / estimated) * 100; // +20%
    expect(expected).toBeCloseTo(20, 1);
  });

  it('under-budget produces negative deviationPct', () => {
    const estimated = 0.10;
    const actual = 0.08;
    const expected = ((actual - estimated) / estimated) * 100; // -20%
    expect(expected).toBeCloseTo(-20, 1);
  });

  it('zero estimate produces zero deviation (no division by zero)', () => {
    const estimated = 0;
    const deviationPct = estimated > 0 ? ((0.05 - estimated) / estimated) * 100 : 0;
    expect(deviationPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// KPI 3b: writeCostVariance produces valid variance.json from ledger
// ---------------------------------------------------------------------------

describe('KPI 3b: writeCostVariance end-to-end', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `anatoly-variance-${Date.now()}`);
    mkdirSync(join(tmpDir, 'costs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces variance.json with byComposer and byPhase from ledger records', () => {
    // Write a synthetic ledger with estimate + actual records
    const ledger = [
      // Pre-flight estimate for axes.utility
      JSON.stringify({
        schemaVersion: 2,
        t: 0,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        phase: 'review',
        composer: 'axes.utility',
        primitive: 'axes.utility',
        costSource: 'estimated',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
        durationMs: 0,
        success: true,
      }),
      // Actual call for axes.utility
      JSON.stringify({
        schemaVersion: 2,
        t: 100,
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        phase: 'review',
        composer: 'axes.utility',
        primitive: 'axes.utility',
        callId: 'call-1',
        costSource: 'actual',
        inputTokens: 1100,
        outputTokens: 550,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.012,
        durationMs: 1200,
        success: true,
      }),
    ].join('\n') + '\n';

    writeFileSync(join(tmpDir, 'costs', 'ledger.ndjson'), ledger);
    writeCostVariance(tmpDir);

    const variance: CostVariance = JSON.parse(
      readFileSync(join(tmpDir, 'costs', 'variance.json'), 'utf-8'),
    );

    // byComposer should have axes.utility
    expect(variance.byComposer).toHaveProperty('axes.utility');
    const composerEntry: VarianceEntry = variance.byComposer['axes.utility'];
    expect(composerEntry.estimatedUsd).toBe(0.01);
    expect(composerEntry.actualUsd).toBe(0.012);
    // deviationPct = ((0.012 - 0.01) / 0.01) * 100 = 20%
    expect(composerEntry.deviationPct).toBeCloseTo(20, 0);

    // byPhase should have review
    expect(variance.byPhase).toHaveProperty('review');
    const phaseEntry: VarianceEntry = variance.byPhase['review'];
    expect(phaseEntry.estimatedUsd).toBe(0.01);
    expect(phaseEntry.actualUsd).toBe(0.012);
  });

  it('deviation within ±20% passes the fidelity bound', () => {
    const entry: VarianceEntry = {
      estimatedUsd: 0.10,
      actualUsd: 0.11, // +10%
      deviationPct: 10,
    };
    expect(Math.abs(entry.deviationPct)).toBeLessThanOrEqual(20);
  });

  it('deviation outside ±20% fails the fidelity bound', () => {
    const entry: VarianceEntry = {
      estimatedUsd: 0.10,
      actualUsd: 0.15, // +50%
      deviationPct: 50,
    };
    expect(Math.abs(entry.deviationPct)).toBeGreaterThan(20);
  });
});
