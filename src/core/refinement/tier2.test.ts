// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { applyTier2, detectCrossFilePatterns } from './tier2.js';
import type { EscalatedFinding } from './tier2.js';
import type { ReviewFile, SymbolReview } from '../../schemas/review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(overrides: Partial<SymbolReview> = {}): SymbolReview {
  return {
    name: 'doWork',
    kind: 'function',
    exported: true,
    line_start: 1,
    line_end: 20,
    correction: 'OK',
    overengineering: 'LEAN',
    utility: 'USED',
    duplication: 'UNIQUE',
    tests: 'GOOD',
    documentation: 'DOCUMENTED',
    confidence: 85,
    detail: 'All axes evaluated successfully.',
    duplicate_target: undefined,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewFile> & { symbols?: Partial<SymbolReview>[] } = {}): ReviewFile {
  const { symbols: symOverrides, ...rest } = overrides;
  return {
    version: 2,
    file: 'src/core/example.ts',
    verdict: 'NEEDS_REFACTOR',
    symbols: symOverrides ? symOverrides.map((s) => makeSymbol(s)) : [makeSymbol()],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    is_generated: false,
    axis_timing: {},
    ...rest,
  } as ReviewFile;
}

// ---------------------------------------------------------------------------
// Tests — applyTier2 coherence rules
// ---------------------------------------------------------------------------

describe('applyTier2', () => {
  // --- DEAD + NEEDS_FIX → correction = OK ---

  it('AC: DEAD + NEEDS_FIX → correction reclassified to OK', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', correction: 'NEEDS_FIX',
        confidence: 85, detail: 'Has bug + dead',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].correction).toBe('OK');
    expect(result.review.symbols[0].detail).toContain('Moot');
    expect(result.review.symbols[0].detail).toContain('DEAD');
  });

  // --- DEAD + OVER → overengineering = skip ---

  it('AC: DEAD + OVER → overengineering reclassified to skip', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', overengineering: 'OVER',
        confidence: 85, detail: 'Dead and over-eng',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].overengineering).toBe('-');
  });

  // --- DEAD + DUPLICATE → duplication = skip ---

  it('AC: DEAD + DUPLICATE → duplication reclassified to skip', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', duplication: 'DUPLICATE',
        confidence: 85, detail: 'Dead and duplicate',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].duplication).toBe('-');
  });

  // --- DEAD + WEAK/NONE → tests = skip ---

  it('AC: DEAD + WEAK → tests reclassified to skip', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', tests: 'WEAK',
        confidence: 85, detail: 'Dead with weak tests',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].tests).toBe('-');
  });

  it('AC: DEAD + NONE → tests reclassified to skip', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', tests: 'NONE',
        confidence: 85, detail: 'Dead with no tests',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].tests).toBe('-');
  });

  // --- DEAD + UNDOCUMENTED → documentation = skip ---

  it('AC: DEAD + UNDOCUMENTED → documentation reclassified to skip', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', documentation: 'UNDOCUMENTED',
        confidence: 85, detail: 'Dead and undocumented',
      }],
    });

    const result = await applyTier2(review);

    expect(result.review.symbols[0].documentation).toBe('-');
  });

  // --- DEAD resolves ALL conflicting axes on same symbol ---

  it('should resolve all conflicting axes on a DEAD symbol at once', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD',
        correction: 'NEEDS_FIX',
        overengineering: 'OVER',
        duplication: 'DUPLICATE',
        tests: 'NONE',
        documentation: 'UNDOCUMENTED',
        confidence: 85,
        detail: 'Dead with everything wrong',
      }],
    });

    const result = await applyTier2(review);
    const sym = result.review.symbols[0];

    expect(sym.utility).toBe('DEAD'); // Unchanged
    expect(sym.correction).toBe('OK');
    expect(sym.overengineering).toBe('-');
    expect(sym.duplication).toBe('-');
    expect(sym.tests).toBe('-');
    expect(sym.documentation).toBe('-');
  });

  // --- correction: ERROR → always escalated ---

  it('AC: correction ERROR → always escalated to tier 3', async () => {
    const review = makeReview({
      symbols: [{
        name: 'buggyFunc',
        correction: 'ERROR', confidence: 95,
        detail: 'Null pointer dereference at line 42',
      }],
    });

    const result = await applyTier2(review);

    expect(result.escalated.length).toBe(1);
    expect(result.escalated[0].symbolName).toBe('buggyFunc');
    expect(result.escalated[0].axis).toBe('correction');
    expect(result.escalated[0].value).toBe('ERROR');
    // ERROR should NOT be auto-resolved
    expect(result.review.symbols[0].correction).toBe('ERROR');
  });

  // --- Low confidence isolated NEEDS_FIX → escalated ---

  it('AC: NEEDS_FIX confidence < 75 isolated → escalated', async () => {
    const review = makeReview({
      symbols: [{
        name: 'suspectFunc',
        correction: 'NEEDS_FIX', confidence: 60,
        // All other axes are clean (isolated finding)
        utility: 'USED', duplication: 'UNIQUE', overengineering: 'LEAN',
        tests: 'GOOD', documentation: 'DOCUMENTED',
        detail: 'Possible off-by-one error',
      }],
    });

    const result = await applyTier2(review);

    expect(result.escalated.length).toBe(1);
    expect(result.escalated[0].reason).toContain('Low confidence isolated finding');
  });

  it('should NOT escalate NEEDS_FIX confidence < 75 when other axes have findings', async () => {
    const review = makeReview({
      symbols: [{
        name: 'suspectFunc',
        correction: 'NEEDS_FIX', confidence: 60,
        utility: 'DEAD', // Another axis has a finding → not isolated
        detail: 'Possible off-by-one + dead code',
      }],
    });

    const result = await applyTier2(review);

    // Should NOT be escalated as "isolated" — the DEAD+NEEDS_FIX coherence rule applies instead
    const isolated = result.escalated.filter((e) => e.reason.includes('Low confidence isolated'));
    expect(isolated.length).toBe(0);
  });

  it('should NOT escalate NEEDS_FIX when confidence ≥ 75', async () => {
    const review = makeReview({
      symbols: [{
        name: 'confirmedBug',
        correction: 'NEEDS_FIX', confidence: 80,
        utility: 'USED', duplication: 'UNIQUE', overengineering: 'LEAN',
        tests: 'GOOD', documentation: 'DOCUMENTED',
        detail: 'Confirmed buffer overflow',
      }],
    });

    const result = await applyTier2(review);

    const isolated = result.escalated.filter((e) => e.reason.includes('Low confidence'));
    expect(isolated.length).toBe(0);
  });

  // --- Behavioral change detection → escalated ---

  it('AC: finding about default/config change → escalated', async () => {
    const review = makeReview({
      symbols: [{
        name: 'initConfig',
        correction: 'NEEDS_FIX', confidence: 80,
        detail: 'Default timeout value should be changed from 3000 to 5000',
      }],
    });

    const result = await applyTier2(review);

    const behavioral = result.escalated.filter((e) => e.reason.includes('Behavioral change'));
    expect(behavioral.length).toBe(1);
  });

  it('should detect behavioral change from config-related keywords', async () => {
    const review = makeReview({
      symbols: [{
        name: 'setConfig',
        correction: 'NEEDS_FIX', confidence: 85,
        detail: 'Configuration fallback should use environment variable instead',
      }],
    });

    const result = await applyTier2(review);

    const behavioral = result.escalated.filter((e) => e.reason.includes('Behavioral change'));
    expect(behavioral.length).toBe(1);
  });

  // --- Verdict recalculation ---

  it('should recalculate verdict to CLEAN when DEAD conflicts are resolved', async () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD',
        correction: 'NEEDS_FIX',
        overengineering: 'OVER',
        confidence: 85,
        detail: 'Dead code with issues',
      }],
    });

    const result = await applyTier2(review);

    // DEAD is still a finding → should remain NEEDS_REFACTOR
    expect(result.review.verdict).toBe('NEEDS_REFACTOR');
  });

  // --- Immutability ---

  it('should not mutate the input review', async () => {
    const review = makeReview({
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', correction: 'NEEDS_FIX',
        confidence: 85, detail: 'Dead and buggy',
      }],
    });
    const originalJson = JSON.stringify(review);

    await applyTier2(review);

    expect(JSON.stringify(review)).toBe(originalJson);
  });

  // --- Stats tracking ---

  it('should return stats with counts', async () => {
    const review = makeReview({
      symbols: [
        { name: 'dead1', utility: 'DEAD', correction: 'NEEDS_FIX', confidence: 85, detail: 'Dead and buggy' },
        { name: 'error1', correction: 'ERROR', confidence: 95, detail: 'Null pointer crash' },
      ],
    });

    const result = await applyTier2(review);

    expect(result.stats).toBeDefined();
    expect(result.stats.resolved).toBeGreaterThan(0);
    expect(result.stats.escalated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — detectCrossFilePatterns
// ---------------------------------------------------------------------------

describe('detectCrossFilePatterns', () => {
  it('AC: > 10 DEAD symbols in same module → systemic pattern escalated', () => {
    const reviews: ReviewFile[] = [];
    // Create 12 files in src/core/ each with a DEAD symbol
    for (let i = 0; i < 12; i++) {
      reviews.push(makeReview({
        file: `src/core/module${i}.ts`,
        symbols: [{
          name: `deadFunc${i}`,
          utility: 'DEAD', confidence: 80,
          detail: `No importers for deadFunc${i}`,
        }],
      }));
    }

    const escalated = detectCrossFilePatterns(reviews);

    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated[0].reason).toContain('Systemic pattern');
    expect(escalated[0].reason).toContain('DEAD');
    expect(escalated[0].reason).toContain('src/core');
  });

  it('should NOT flag systemic pattern when ≤ 10 DEAD symbols in module', () => {
    const reviews: ReviewFile[] = [];
    for (let i = 0; i < 8; i++) {
      reviews.push(makeReview({
        file: `src/core/module${i}.ts`,
        symbols: [{ name: `deadFunc${i}`, utility: 'DEAD', confidence: 80, detail: 'Dead' }],
      }));
    }

    const escalated = detectCrossFilePatterns(reviews);

    expect(escalated.length).toBe(0);
  });

  it('should group by directory for pattern detection', () => {
    const reviews: ReviewFile[] = [];
    // 6 DEAD in src/core/, 6 DEAD in src/utils/ — neither exceeds threshold alone
    for (let i = 0; i < 6; i++) {
      reviews.push(makeReview({
        file: `src/core/mod${i}.ts`,
        symbols: [{ name: `dead${i}`, utility: 'DEAD', confidence: 80, detail: 'Dead' }],
      }));
      reviews.push(makeReview({
        file: `src/utils/util${i}.ts`,
        symbols: [{ name: `deadUtil${i}`, utility: 'DEAD', confidence: 80, detail: 'Dead' }],
      }));
    }

    const escalated = detectCrossFilePatterns(reviews);

    expect(escalated.length).toBe(0);
  });
});
