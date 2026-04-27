// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { triageFile, generateSkipReview, evaluatorAxesForSkip } from './triage.js';
import type { Task } from '../schemas/task.js';
import { ReviewFileSchema } from '../schemas/review.js';
import type { UsageGraph } from './usage-graph.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    version: 1,
    file: 'src/test.ts',
    hash: 'abc123',
    symbols: [],
    scanned_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSymbol(
  overrides: Partial<Task['symbols'][0]> = {},
): Task['symbols'][0] {
  return {
    name: 'foo',
    kind: 'function',
    exported: true,
    line_start: 1,
    line_end: 10,
    ...overrides,
  };
}

describe('triageFile', () => {
  // --- Skip tier ---

  it('skip: barrel export (0 symbols, only re-exports)', () => {
    const task = makeTask({ symbols: [] });
    const source = `export { foo } from './foo.js';\nexport { bar } from './bar.js';\n`;
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'barrel-export' });
  });

  it('skip: trivial file (< 10 lines, 0-1 symbol)', () => {
    const task = makeTask({
      symbols: [makeSymbol({ name: 'x', kind: 'constant', line_end: 3 })],
    });
    const source = `export const x = 42;\n`;
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'trivial' });
  });

  it('skip: trivial file with 0 symbols and < 10 lines (not barrel)', () => {
    const task = makeTask({ symbols: [] });
    // Not all lines are export statements, so not barrel
    const source = `// just a comment\n`;
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'trivial' });
  });

  it('skip: type-only file (all symbols are type or enum)', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'MyType', kind: 'type', line_end: 5 }),
        makeSymbol({ name: 'MyEnum', kind: 'enum', line_end: 15 }),
      ],
    });
    // Needs >= 10 lines to not match trivial first
    const source = Array(20).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'type-only' });
  });

  it('skip: constants-only file', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'MAX_RETRIES', kind: 'constant', line_end: 1 }),
        makeSymbol({ name: 'DEFAULT_TIMEOUT', kind: 'constant', line_end: 2 }),
      ],
    });
    const source = Array(20).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'constants-only' });
  });

  // --- Evaluate tier ---

  it('evaluate: simple file (< 50 lines, < 3 symbols)', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'helper', kind: 'function', line_end: 20 }),
        makeSymbol({ name: 'util', kind: 'function', line_end: 30 }),
      ],
    });
    const source = Array(40).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'evaluate', reason: 'simple' });
  });

  it('evaluate: internal file (no exports)', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'helper', exported: false, line_end: 30 }),
        makeSymbol({ name: 'util', exported: false, line_end: 50 }),
        makeSymbol({ name: 'compute', exported: false, line_end: 80 }),
      ],
    });
    const source = Array(100).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'evaluate', reason: 'internal' });
  });

  // --- Evaluate tier ---

  it('evaluate: complex file (many symbols, exports, large)', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'doA', kind: 'function', exported: true }),
        makeSymbol({ name: 'doB', kind: 'function', exported: true }),
        makeSymbol({ name: 'doC', kind: 'function', exported: true }),
        makeSymbol({ name: 'doD', kind: 'function', exported: false }),
      ],
    });
    const source = Array(200).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'evaluate', reason: 'complex' });
  });

  // --- Edge cases ---

  it('barrel with symbols is not skip', () => {
    const task = makeTask({
      symbols: [makeSymbol({ name: 'foo', kind: 'function' })],
    });
    const source = `export { foo } from './foo.js';\n`;
    const result = triageFile(task, source);
    // Has symbols, so not barrel. < 10 lines, 1 symbol → trivial skip
    expect(result.tier).toBe('skip');
    expect(result.reason).toBe('trivial');
  });

  it('empty file (0 lines, 0 symbols) is trivial skip', () => {
    const task = makeTask({ symbols: [] });
    const source = '';
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'skip', reason: 'trivial' });
  });

  it('mixed type+function file is evaluate', () => {
    const task = makeTask({
      symbols: [
        makeSymbol({ name: 'MyType', kind: 'type' }),
        makeSymbol({ name: 'handler', kind: 'function', exported: true }),
        makeSymbol({ name: 'process', kind: 'function', exported: true }),
        makeSymbol({ name: 'init', kind: 'function', exported: true }),
      ],
    });
    const source = Array(100).fill('// line').join('\n');
    const result = triageFile(task, source);
    expect(result).toEqual({ tier: 'evaluate', reason: 'complex' });
  });
});

describe('generateSkipReview', () => {
  it('generates a valid CLEAN ReviewFile', () => {
    const task = makeTask({
      file: 'src/utils/types.ts',
      symbols: [
        makeSymbol({ name: 'Config', kind: 'type', line_start: 3, line_end: 10 }),
        makeSymbol({ name: 'Options', kind: 'type', line_start: 12, line_end: 18 }),
      ],
    });

    const review = generateSkipReview(task, 'type-only');

    // Validates against the Zod schema
    const parsed = ReviewFileSchema.safeParse(review);
    expect(parsed.success).toBe(true);

    expect(review.version).toBe(2);
    expect(review.file).toBe('src/utils/types.ts');
    expect(review.is_generated).toBe(true);
    expect(review.skip_reason).toBe('type-only');
    expect(review.verdict).toBe('CLEAN');
    expect(review.actions).toEqual([]);
    expect(review.symbols).toHaveLength(2);

    // Check each symbol review
    for (const sym of review.symbols) {
      expect(sym.correction).toBe('OK');
      expect(sym.overengineering).toBe('LEAN');
      expect(sym.utility).toBe('USED');
      expect(sym.duplication).toBe('UNIQUE');
      expect(sym.tests).toBe('-');
      expect(sym.confidence).toBe(100);
      expect(sym.detail).toContain('auto-skipped by triage');
      expect(sym.detail).toContain('type-only');
    }
  });

  it('generates valid review for barrel export with 0 symbols', () => {
    const task = makeTask({
      file: 'src/index.ts',
      symbols: [],
    });

    const review = generateSkipReview(task, 'barrel-export');

    const parsed = ReviewFileSchema.safeParse(review);
    expect(parsed.success).toBe(true);

    expect(review.symbols).toHaveLength(0);
    expect(review.verdict).toBe('CLEAN');
    expect(review.is_generated).toBe(true);
    expect(review.skip_reason).toBe('barrel-export');
  });

  it('AC 31.20.3: includes language from task in skip review', () => {
    const task = makeTask({
      file: 'helpers.sh',
      language: 'bash',
      parse_method: 'ast',
      symbols: [],
    });
    const review = generateSkipReview(task, 'trivial');
    expect(review.language).toBe('bash');
    expect(review.parse_method).toBe('ast');
  });

  it('AC 31.20.5: omits language when undefined (TS zero regression)', () => {
    const task = makeTask({ file: 'src/index.ts', symbols: [] });
    const review = generateSkipReview(task, 'barrel-export');
    expect(review.language).toBeUndefined();
    expect(review.parse_method).toBeUndefined();
  });

  // --- Regression: usage graph consulted for skipped files ---
  // Previously generateSkipReview blanket-classified every symbol as USED
  // for skipped files. A type-only file containing an exported but unused
  // type alias slipped through with utility=USED. With the usage graph
  // passed in, the unused export is correctly classified DEAD.

  function emptyUsageGraph(): UsageGraph {
    return {
      usages: new Map(),
      typeOnlyUsages: new Map(),
      intraFileRefs: new Map(),
      noImportFiles: new Set(),
    };
  }

  it('marks unused exported types as DEAD when usage graph is provided', () => {
    const task = makeTask({
      file: 'src/types.ts',
      symbols: [
        makeSymbol({ name: 'UsedType', kind: 'type', line_start: 1, line_end: 5 }),
        makeSymbol({ name: 'OrphanType', kind: 'type', line_start: 7, line_end: 10 }),
      ],
    });
    const graph = emptyUsageGraph();
    graph.usages.set('UsedType::src/types.ts', new Set(['src/consumer.ts']));

    const review = generateSkipReview(task, 'type-only', undefined, graph);

    const used = review.symbols.find((s) => s.name === 'UsedType');
    const orphan = review.symbols.find((s) => s.name === 'OrphanType');
    expect(used?.utility).toBe('USED');
    expect(orphan?.utility).toBe('DEAD');
    expect(orphan?.detail).toBe('Exported but imported by 0 files');
    expect(review.verdict).toBe('NEEDS_REFACTOR');
  });

  it('falls back to USED on type-only file when no usage graph is supplied', () => {
    const task = makeTask({
      file: 'src/types.ts',
      symbols: [makeSymbol({ name: 'OrphanType', kind: 'type' })],
    });
    const review = generateSkipReview(task, 'type-only');
    expect(review.symbols[0].utility).toBe('USED');
  });

  it('respects the type-only-imported path on the usage graph', () => {
    const task = makeTask({
      file: 'src/types.ts',
      symbols: [makeSymbol({ name: 'TypeUsedAsType', kind: 'type' })],
    });
    const graph = emptyUsageGraph();
    graph.typeOnlyUsages.set('TypeUsedAsType::src/types.ts', new Set(['src/consumer.ts']));
    const review = generateSkipReview(task, 'type-only', undefined, graph);
    expect(review.symbols[0].utility).toBe('USED');
    expect(review.symbols[0].detail).toContain('Type-only imported');
  });

  it('skips utility resolution when the utility axis is filtered out', () => {
    const task = makeTask({
      file: 'src/types.ts',
      symbols: [makeSymbol({ name: 'OrphanType', kind: 'type' })],
    });
    const graph = emptyUsageGraph(); // would mark OrphanType DEAD if utility were active
    const review = generateSkipReview(
      task,
      'type-only',
      ['correction', 'duplication'], // utility not enabled
      graph,
    );
    expect(review.symbols[0].utility).toBe('-');
    expect(review.verdict).toBe('CLEAN');
  });
});

describe('evaluatorAxesForSkip', () => {
  it('returns empty for barrel-export (no symbols anywhere)', () => {
    expect(evaluatorAxesForSkip('barrel-export').size).toBe(0);
  });

  it('returns empty for type-only (utility recovered via skip path)', () => {
    expect(evaluatorAxesForSkip('type-only').size).toBe(0);
  });

  it('returns empty for constants-only', () => {
    expect(evaluatorAxesForSkip('constants-only').size).toBe(0);
  });

  it('returns {correction, duplication, utility} for trivial files', () => {
    // Regression: a tiny file (e.g. a 4-line wild-bonus helper) can carry a
    // business-logic bug or duplicate another helper. The previous policy
    // skipped every axis and silently classified such files as CLEAN.
    const set = evaluatorAxesForSkip('trivial');
    expect(set.has('correction')).toBe(true);
    expect(set.has('duplication')).toBe(true);
    expect(set.has('utility')).toBe(true);
    expect(set.has('overengineering')).toBe(false);
    expect(set.has('tests')).toBe(false);
    expect(set.has('documentation')).toBe(false);
    expect(set.has('best_practices')).toBe(false);
  });

  it('returns empty for unknown reasons (safe default)', () => {
    expect(evaluatorAxesForSkip('mystery').size).toBe(0);
  });
});
