import { describe, it, expect } from 'vitest';
import { triageFile, generateSkipReview } from './triage.js';
import type { Task } from '../schemas/task.js';
import { ReviewFileSchema } from '../schemas/review.js';

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
      expect(sym.tests).toBe('NONE');
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
});
