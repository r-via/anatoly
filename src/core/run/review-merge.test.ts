// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { mergeRefreshedReview, computeMergedAxesCoverage } from './review-merge.js';
import type { ReviewFile, SymbolReview, Action } from '../../schemas/review.js';

// Minimal symbol factory — fills the required fields with safe defaults
// so each test only specifies what matters.
function sym(overrides: Partial<SymbolReview> & { name: string; line_start: number }): SymbolReview {
  return {
    name: overrides.name,
    kind: overrides.kind ?? 'function',
    exported: overrides.exported ?? true,
    line_start: overrides.line_start,
    line_end: overrides.line_end ?? overrides.line_start + 1,
    correction: overrides.correction ?? 'OK',
    overengineering: overrides.overengineering ?? 'LEAN',
    utility: overrides.utility ?? 'USED',
    duplication: overrides.duplication ?? 'UNIQUE',
    tests: overrides.tests ?? 'GOOD',
    documentation: overrides.documentation ?? 'DOCUMENTED',
    confidence: overrides.confidence ?? 85,
    detail: overrides.detail ?? '[OK] no issue | [USED] imported | [LEAN] simple',
    duplicate_target: overrides.duplicate_target,
    findings: overrides.findings,
  };
}

function review(overrides: Partial<ReviewFile> & { file?: string } = {}): ReviewFile {
  return {
    version: 2,
    file: overrides.file ?? 'src/a.ts',
    is_generated: false,
    verdict: 'CLEAN',
    symbols: overrides.symbols ?? [],
    actions: overrides.actions ?? [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    ...overrides,
  } as ReviewFile;
}

describe('mergeRefreshedReview', () => {
  it('returns fresh as-is when no cache exists', () => {
    const fresh = review({ symbols: [sym({ name: 'a', line_start: 1 })] });
    expect(mergeRefreshedReview(null, fresh, ['utility'])).toBe(fresh);
  });

  it('returns fresh as-is when cache is for a different file (defensive)', () => {
    const cached = review({ file: 'src/other.ts' });
    const fresh = review({ file: 'src/a.ts' });
    expect(mergeRefreshedReview(cached, fresh, ['utility'])).toBe(fresh);
  });

  it('preserves cached verdicts for non-refreshed axes on overlapping symbols', () => {
    const cached = review({
      symbols: [sym({
        name: 'foo', line_start: 10,
        correction: 'NEEDS_FIX', overengineering: 'OVER', utility: 'DEAD',
        detail: '[NEEDS_FIX] bug here | [OVER] bloat | [DEAD] no importers',
        confidence: 70,
      })],
    });
    const fresh = review({
      symbols: [sym({
        name: 'foo', line_start: 10,
        correction: 'OK', overengineering: 'LEAN', utility: 'USED',
        detail: '[OK] axis crashed | [LEAN] axis crashed | [USED] runtime-imported by 3',
        confidence: 95,
      })],
    });

    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    const s = merged.symbols[0];
    // utility refreshed
    expect(s.utility).toBe('USED');
    expect(s.detail).toContain('[USED] runtime-imported by 3');
    // non-refreshed axes kept their cached verdicts AND rationale
    expect(s.correction).toBe('NEEDS_FIX');
    expect(s.detail).toContain('[NEEDS_FIX] bug here');
    expect(s.overengineering).toBe('OVER');
    expect(s.detail).toContain('[OVER] bloat');
    // confidence: conservative (min) — not raised by a single refreshed axis
    expect(s.confidence).toBe(70);
  });

  it('refreshes only the requested axes (multi-axis subset)', () => {
    const cached = review({
      symbols: [sym({
        name: 'foo', line_start: 10,
        correction: 'NEEDS_FIX', overengineering: 'OVER', utility: 'DEAD',
        tests: 'NONE', documentation: 'UNDOCUMENTED',
        detail: '[NEEDS_FIX] x | [OVER] x | [DEAD] x | [NONE] x | [UNDOCUMENTED] x',
      })],
    });
    const fresh = review({
      symbols: [sym({
        name: 'foo', line_start: 10,
        correction: 'OK', overengineering: 'LEAN', utility: 'USED',
        tests: 'GOOD', documentation: 'DOCUMENTED',
        detail: '[OK] fixed | [LEAN] fixed | [USED] fixed | [GOOD] fixed | [DOCUMENTED] fixed',
      })],
    });

    const merged = mergeRefreshedReview(cached, fresh, ['utility', 'tests']);
    const s = merged.symbols[0];
    expect(s.utility).toBe('USED');
    expect(s.tests).toBe('GOOD');
    expect(s.correction).toBe('NEEDS_FIX');
    expect(s.overengineering).toBe('OVER');
    expect(s.documentation).toBe('UNDOCUMENTED');
    expect(s.detail).toContain('[USED] fixed');
    expect(s.detail).toContain('[GOOD] fixed');
    expect(s.detail).toContain('[NEEDS_FIX] x');
    expect(s.detail).not.toContain('[OK] fixed');
  });

  it('passes new fresh symbols through as-is (no cached counterpart)', () => {
    const cached = review({ symbols: [sym({ name: 'foo', line_start: 1 })] });
    const fresh = review({
      symbols: [
        sym({ name: 'foo', line_start: 1 }),
        sym({ name: 'newSymbol', line_start: 50, utility: 'DEAD' }),
      ],
    });
    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    expect(merged.symbols).toHaveLength(2);
    const newSym = merged.symbols.find((s) => s.name === 'newSymbol');
    expect(newSym?.utility).toBe('DEAD');
  });

  it('drops cached symbols that no longer exist in the fresh scan', () => {
    const cached = review({
      symbols: [
        sym({ name: 'foo', line_start: 1 }),
        sym({ name: 'removed', line_start: 20 }),
      ],
    });
    const fresh = review({ symbols: [sym({ name: 'foo', line_start: 1 })] });
    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    expect(merged.symbols).toHaveLength(1);
    expect(merged.symbols[0].name).toBe('foo');
  });

  it('treats a renamed symbol (same line, different name) as a fresh symbol', () => {
    const cached = review({
      symbols: [sym({ name: 'oldName', line_start: 10, correction: 'NEEDS_FIX' })],
    });
    const fresh = review({
      symbols: [sym({ name: 'newName', line_start: 10, correction: 'OK' })],
    });
    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    // No match by name@line, so fresh passes through; correction reflects
    // the fresh evaluation, not the cached "NEEDS_FIX" of the prior name.
    expect(merged.symbols[0].name).toBe('newName');
    expect(merged.symbols[0].correction).toBe('OK');
  });

  it('keeps cached actions whose source is NOT in the refreshed axes', () => {
    const action = (id: number, source: Action['source']): Action => ({
      id, description: `from ${source}`, severity: 'medium',
      effort: 'small', category: 'refactor',
      source, target_symbol: null, target_lines: null,
    });
    const cached = review({
      actions: [
        action(1, 'utility'),
        action(2, 'correction'),
        action(3, 'tests'),
      ],
    });
    const fresh = review({
      actions: [action(99, 'utility')],
    });
    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    // Cached utility action dropped; cached correction + tests kept; fresh
    // utility action appended. IDs re-numbered sequentially.
    expect(merged.actions.map((a) => a.source)).toEqual(['correction', 'tests', 'utility']);
    expect(merged.actions.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('keeps cached file_level (a partial run cannot detect unused imports honestly)', () => {
    const cached = review({
      file_level: { unused_imports: ['fs'], circular_dependencies: ['a→b→a'], general_notes: 'note' },
    });
    const fresh = review({
      file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    });
    const merged = mergeRefreshedReview(cached, fresh, ['utility']);
    expect(merged.file_level.unused_imports).toEqual(['fs']);
    expect(merged.file_level.circular_dependencies).toEqual(['a→b→a']);
  });

  it('refreshes documentation side outputs only when documentation axis is in the set', () => {
    const cached = review({
      docs_coverage: {
        concepts: [{ name: 'A', status: 'COVERED', doc_path: null, detail: 'd' }],
        score_pct: 50,
      },
    });
    const fresh = review({
      docs_coverage: {
        concepts: [{ name: 'B', status: 'MISSING', doc_path: null, detail: 'd' }],
        score_pct: 90,
      },
    });

    // utility-only refresh: cached docs_coverage preserved
    let merged = mergeRefreshedReview(cached, fresh, ['utility']);
    expect(merged.docs_coverage?.score_pct).toBe(50);

    // documentation refresh: fresh wins
    merged = mergeRefreshedReview(cached, fresh, ['documentation']);
    expect(merged.docs_coverage?.score_pct).toBe(90);
  });
});

describe('computeMergedAxesCoverage', () => {
  it('returns the union of refreshed and cached axes', () => {
    const r = review();
    const axes = computeMergedAxesCoverage(
      r,
      ['utility'],
      ['correction', 'utility', 'tests'],
    );
    expect(axes.sort()).toEqual(['correction', 'tests', 'utility']);
  });

  it('drops unknown axes from the cached list (schema drift safety)', () => {
    const r = review();
    const axes = computeMergedAxesCoverage(
      r,
      ['utility'],
      ['utility', 'definitely_not_an_axis'],
    );
    expect(axes).toEqual(['utility']);
  });

  it('handles an empty cached axes list (no prior coverage)', () => {
    const r = review();
    expect(computeMergedAxesCoverage(r, ['utility'], [])).toEqual(['utility']);
  });
});
