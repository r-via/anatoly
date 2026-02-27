import { describe, it, expect } from 'vitest';
import { mergeAxisResults } from './axis-merger.js';
import type { Task } from '../schemas/task.js';
import type { AxisResult, AxisId, AxisSymbolResult } from './axis-evaluator.js';
import type { BestPractices } from '../schemas/review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockTask: Task = {
  version: 1,
  file: 'src/core/example.ts',
  hash: 'abc123',
  symbols: [
    { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 20 },
    { name: 'Helper', kind: 'class', exported: false, line_start: 22, line_end: 50 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

function makeSymbol(name: string, overrides: Partial<AxisSymbolResult> = {}): AxisSymbolResult {
  return {
    name,
    line_start: 1,
    line_end: 20,
    value: 'OK',
    confidence: 90,
    detail: 'Test detail for symbol',
    ...overrides,
  };
}

function makeAxisResult(axisId: string, symbols: AxisSymbolResult[], overrides: Partial<AxisResult> = {}): AxisResult {
  return {
    axisId: axisId as AxisResult['axisId'],
    symbols,
    actions: [],
    costUsd: 0.001,
    durationMs: 500,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    transcript: `## System (init)\n\n**Model:** claude-haiku-4-5-20251001\n`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeAxisResults', () => {
  it('should produce a valid ReviewFile v2', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [
        makeSymbol('doWork', { value: 'USED', confidence: 95 }),
        makeSymbol('Helper', { value: 'USED', confidence: 85, line_start: 22, line_end: 50 }),
      ]),
      makeAxisResult('correction', [
        makeSymbol('doWork', { value: 'OK', confidence: 90 }),
        makeSymbol('Helper', { value: 'OK', confidence: 88, line_start: 22, line_end: 50 }),
      ]),
    ];

    const review = mergeAxisResults(mockTask, results);

    expect(review.version).toBe(2);
    expect(review.file).toBe('src/core/example.ts');
    expect(review.is_generated).toBe(false);
    expect(review.symbols).toHaveLength(2);
    expect(review.symbols[0].name).toBe('doWork');
    expect(review.symbols[0].utility).toBe('USED');
    expect(review.symbols[0].correction).toBe('OK');
  });

  it('should apply axis defaults when an axis is missing for a symbol', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [
        makeSymbol('doWork', { value: 'DEAD', confidence: 95 }),
      ]),
    ];

    const review = mergeAxisResults(mockTask, results);
    const doWork = review.symbols[0];

    expect(doWork.utility).toBe('DEAD');
    // Defaults for missing axes
    expect(doWork.correction).toBe('OK');
    expect(doWork.overengineering).toBe('LEAN');
    expect(doWork.duplication).toBe('UNIQUE');
    // Coherence: DEAD → tests forced to NONE
    expect(doWork.tests).toBe('NONE');
  });

  it('should apply coherence rule: DEAD utility → tests=NONE', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [makeSymbol('doWork', { value: 'DEAD' })]),
      makeAxisResult('tests', [makeSymbol('doWork', { value: 'GOOD' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].tests).toBe('NONE');
  });

  it('should apply coherence rule: ERROR correction → overengineering=ACCEPTABLE', () => {
    const results: AxisResult[] = [
      makeAxisResult('correction', [makeSymbol('doWork', { value: 'ERROR' })]),
      makeAxisResult('overengineering', [makeSymbol('doWork', { value: 'OVER' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].overengineering).toBe('ACCEPTABLE');
  });

  it('should not override overengineering when correction is OK', () => {
    const results: AxisResult[] = [
      makeAxisResult('correction', [makeSymbol('doWork', { value: 'OK' })]),
      makeAxisResult('overengineering', [makeSymbol('doWork', { value: 'OVER' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].overengineering).toBe('OVER');
  });

  it('should not override tests when utility is USED', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [makeSymbol('doWork', { value: 'USED' })]),
      makeAxisResult('tests', [makeSymbol('doWork', { value: 'GOOD' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].tests).toBe('GOOD');
  });

  it('should compute verdict CLEAN when no findings', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [
        makeSymbol('doWork', { value: 'USED' }),
        makeSymbol('Helper', { value: 'USED', line_start: 22, line_end: 50 }),
      ]),
      makeAxisResult('correction', [
        makeSymbol('doWork', { value: 'OK' }),
        makeSymbol('Helper', { value: 'OK', line_start: 22, line_end: 50 }),
      ]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.verdict).toBe('CLEAN');
  });

  it('should compute verdict CRITICAL when correction=ERROR', () => {
    const results: AxisResult[] = [
      makeAxisResult('correction', [makeSymbol('doWork', { value: 'ERROR' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.verdict).toBe('CRITICAL');
  });

  it('should compute verdict NEEDS_REFACTOR when correction=NEEDS_FIX', () => {
    const results: AxisResult[] = [
      makeAxisResult('correction', [makeSymbol('doWork', { value: 'NEEDS_FIX' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.verdict).toBe('NEEDS_REFACTOR');
  });

  it('should compute verdict NEEDS_REFACTOR for DEAD/DUPLICATE/OVER', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [makeSymbol('doWork', { value: 'DEAD' })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.verdict).toBe('NEEDS_REFACTOR');
  });

  it('should merge actions from multiple axes with sequential IDs', () => {
    const results: AxisResult[] = [
      makeAxisResult('correction', [], {
        actions: [
          { id: 1, description: 'Fix null check', severity: 'high', effort: 'small', category: 'quickwin', target_symbol: null, target_lines: 'L5' },
        ],
      }),
      makeAxisResult('best_practices', [], {
        actions: [
          { id: 1, description: 'Add type annotation', severity: 'low', effort: 'small', category: 'hygiene', target_symbol: null, target_lines: null },
          { id: 2, description: 'Remove console.log', severity: 'low', effort: 'trivial', category: 'hygiene', target_symbol: null, target_lines: null },
        ],
      }),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.actions).toHaveLength(3);
    expect(review.actions[0].id).toBe(1);
    expect(review.actions[1].id).toBe(2);
    expect(review.actions[2].id).toBe(3);
  });

  it('should merge file-level results and deduplicate', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [], {
        fileLevel: { unused_imports: ['lodash', 'path'], general_notes: 'Utility note' },
      }),
      makeAxisResult('best_practices', [], {
        fileLevel: { unused_imports: ['lodash'], general_notes: 'BP note' },
      }),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.file_level.unused_imports).toEqual(['lodash', 'path']);
    expect(review.file_level.general_notes).toContain('Utility note');
    expect(review.file_level.general_notes).toContain('BP note');
  });

  it('should include best_practices when provided', () => {
    const bp: BestPractices = {
      score: 8.5,
      rules: [{ rule_id: 1, rule_name: 'Error handling', status: 'PASS', severity: 'CRITIQUE' }],
      suggestions: [],
    };

    const review = mergeAxisResults(mockTask, [], bp);
    expect(review.best_practices).toBeDefined();
    expect(review.best_practices!.score).toBe(8.5);
  });

  it('should build axis_meta from results', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [], { costUsd: 0.002, durationMs: 300 }),
      makeAxisResult('correction', [], { costUsd: 0.01, durationMs: 1200 }),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.axis_meta).toBeDefined();
    expect(review.axis_meta!['utility']).toBeDefined();
    expect(review.axis_meta!['utility']!.cost_usd).toBe(0.002);
    expect(review.axis_meta!['correction']!.duration_ms).toBe(1200);
  });

  it('should use minimum confidence across axes', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [makeSymbol('doWork', { value: 'USED', confidence: 95 })]),
      makeAxisResult('correction', [makeSymbol('doWork', { value: 'OK', confidence: 70 })]),
      makeAxisResult('tests', [makeSymbol('doWork', { value: 'GOOD', confidence: 85 })]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].confidence).toBe(70);
  });

  it('should handle empty results gracefully', () => {
    const review = mergeAxisResults(mockTask, []);

    expect(review.version).toBe(2);
    expect(review.symbols).toHaveLength(2);
    expect(review.verdict).toBe('CLEAN');
    expect(review.symbols[0].utility).toBe('USED');
    expect(review.symbols[0].correction).toBe('OK');
  });

  it('should set confidence to 0 when all symbol-level axes crashed', () => {
    const failedAxes: AxisId[] = ['utility', 'duplication', 'correction', 'overengineering', 'tests'];
    const review = mergeAxisResults(mockTask, [], undefined, failedAxes);

    expect(review.symbols[0].confidence).toBe(0);
    expect(review.symbols[1].confidence).toBe(0);
    expect(review.verdict).toBe('CLEAN');
    expect(review.symbols[0].detail).toContain('axis crashed');
  });

  it('should keep confidence 80 when no axes ran and none crashed', () => {
    const review = mergeAxisResults(mockTask, []);

    expect(review.symbols[0].confidence).toBe(80);
  });

  it('should use real min confidence when some axes succeed and some crash', () => {
    const results: AxisResult[] = [
      makeAxisResult('utility', [
        makeSymbol('doWork', { value: 'USED', confidence: 75 }),
      ]),
    ];
    const failedAxes: AxisId[] = ['correction', 'tests', 'duplication', 'overengineering'];
    const review = mergeAxisResults(mockTask, results, undefined, failedAxes);

    // doWork has utility result with confidence 75
    expect(review.symbols[0].confidence).toBe(75);
    // Helper has no utility result → all axes failed for it → confidence 0
    expect(review.symbols[1].confidence).toBe(0);
  });

  it('should include duplicate_target from duplication axis', () => {
    const target = { file: 'src/utils/other.ts', symbol: 'similarFn', similarity: '92%' };
    const results: AxisResult[] = [
      makeAxisResult('duplication', [
        makeSymbol('doWork', { value: 'DUPLICATE', duplicate_target: target }),
      ]),
    ];

    const review = mergeAxisResults(mockTask, results);
    expect(review.symbols[0].duplication).toBe('DUPLICATE');
    expect(review.symbols[0].duplicate_target).toEqual(target);
  });
});
