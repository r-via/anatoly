import { describe, it, expect } from 'vitest';
import {
  buildFunctionId,
  extractSignature,
  computeComplexity,
  extractCalledInternals,
  buildFunctionCards,
  needsReindex,
} from './indexer.js';
import type { RagCache } from './indexer.js';
import type { SymbolInfo, Task } from '../schemas/task.js';
import type { FunctionCardLLMOutput } from './types.js';

describe('buildFunctionId', () => {
  it('returns a deterministic 16-char hex string', () => {
    const id = buildFunctionId('src/utils/cache.ts', 10, 25);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    // Same input → same output
    expect(buildFunctionId('src/utils/cache.ts', 10, 25)).toBe(id);
  });

  it('returns different IDs for different inputs', () => {
    const id1 = buildFunctionId('src/a.ts', 1, 10);
    const id2 = buildFunctionId('src/b.ts', 1, 10);
    const id3 = buildFunctionId('src/a.ts', 1, 11);
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe('extractSignature', () => {
  it('extracts function signature from source', () => {
    const source = `export function add(a: number, b: number): number {
  return a + b;
}`;
    const symbol: SymbolInfo = { name: 'add', kind: 'function', exported: true, line_start: 1, line_end: 3 };
    const sig = extractSignature(source, symbol);
    expect(sig).toContain('function add');
    expect(sig).toContain('a: number');
  });

  it('extracts arrow function signature', () => {
    const source = `const multiply = (x: number, y: number) => {
  return x * y;
};`;
    const symbol: SymbolInfo = { name: 'multiply', kind: 'function', exported: false, line_start: 1, line_end: 3 };
    const sig = extractSignature(source, symbol);
    expect(sig).toContain('multiply');
    expect(sig).toContain('=>');
  });
});

describe('computeComplexity', () => {
  it('returns 1 for simple functions', () => {
    const source = `function add(a: number, b: number) {
  return a + b;
}`;
    const symbol: SymbolInfo = { name: 'add', kind: 'function', exported: false, line_start: 1, line_end: 3 };
    expect(computeComplexity(source, symbol)).toBe(1);
  });

  it('returns higher score for branching functions', () => {
    const source = `function process(x: number) {
  if (x > 0) {
    if (x > 10) {
      return 'big';
    } else if (x > 5) {
      return 'medium';
    }
    return 'small';
  }
  return 'negative';
}`;
    const symbol: SymbolInfo = { name: 'process', kind: 'function', exported: false, line_start: 1, line_end: 10 };
    const score = computeComplexity(source, symbol);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('counts ternary operators', () => {
    const source = `function check(a: boolean, b: boolean) {
  return a ? (b ? 'both' : 'a') : 'none';
}`;
    const symbol: SymbolInfo = { name: 'check', kind: 'function', exported: false, line_start: 1, line_end: 3 };
    const score = computeComplexity(source, symbol);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('counts logical operators', () => {
    const source = `function validate(a: boolean, b: boolean, c: boolean) {
  if (a && b || c) {
    return true;
  }
  return false;
}`;
    const symbol: SymbolInfo = { name: 'validate', kind: 'function', exported: false, line_start: 1, line_end: 5 };
    const score = computeComplexity(source, symbol);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('does not double-count else if', () => {
    const source = `function classify(x: number) {
  if (x > 100) {
    return 'huge';
  } else if (x > 50) {
    return 'large';
  } else if (x > 10) {
    return 'medium';
  } else if (x > 0) {
    return 'small';
  }
  return 'zero';
}`;
    const symbol: SymbolInfo = { name: 'classify', kind: 'function', exported: false, line_start: 1, line_end: 12 };
    const score = computeComplexity(source, symbol);
    // 1 (base) + 1 (if) + 3 (else if) = 5 raw → maps to scale 2
    expect(score).toBe(2);
  });
});

describe('extractCalledInternals', () => {
  it('finds calls to other functions in the same file', () => {
    const source = `function helper() { return 1; }
function main() {
  const x = helper();
  return x;
}`;
    const symbols: SymbolInfo[] = [
      { name: 'helper', kind: 'function', exported: false, line_start: 1, line_end: 1 },
      { name: 'main', kind: 'function', exported: false, line_start: 2, line_end: 5 },
    ];
    const calls = extractCalledInternals(source, symbols[1], symbols);
    expect(calls).toContain('helper');
  });

  it('does not include the function itself', () => {
    const source = `function recursive() {
  return recursive();
}`;
    const symbols: SymbolInfo[] = [
      { name: 'recursive', kind: 'function', exported: false, line_start: 1, line_end: 3 },
    ];
    const calls = extractCalledInternals(source, symbols[0], symbols);
    expect(calls).not.toContain('recursive');
  });

  it('returns empty array when no internal calls', () => {
    const source = `function standalone() {
  return 42;
}`;
    const symbols: SymbolInfo[] = [
      { name: 'standalone', kind: 'function', exported: false, line_start: 1, line_end: 3 },
    ];
    const calls = extractCalledInternals(source, symbols[0], symbols);
    expect(calls).toEqual([]);
  });
});

describe('buildFunctionCards', () => {
  it('merges LLM output with AST-derived data', () => {
    const source = `export function greet(name: string): string {
  return 'Hello ' + name;
}

export function farewell(name: string): string {
  return 'Bye ' + name;
}`;

    const task: Task = {
      version: 1,
      file: 'src/greetings.ts',
      hash: 'abc123',
      symbols: [
        { name: 'greet', kind: 'function', exported: true, line_start: 1, line_end: 3 },
        { name: 'farewell', kind: 'function', exported: true, line_start: 5, line_end: 7 },
      ],
      scanned_at: '2026-02-24T00:00:00.000Z',
    };

    const llmCards: FunctionCardLLMOutput[] = [
      { name: 'greet', summary: 'Returns a greeting string', keyConcepts: ['greeting', 'string'], behavioralProfile: 'pure' },
      { name: 'farewell', summary: 'Returns a farewell string', keyConcepts: ['farewell', 'string'], behavioralProfile: 'pure' },
    ];

    const cards = buildFunctionCards(task, source, llmCards);
    expect(cards).toHaveLength(2);

    expect(cards[0].name).toBe('greet');
    expect(cards[0].filePath).toBe('src/greetings.ts');
    expect(cards[0].summary).toBe('Returns a greeting string');
    expect(cards[0].id).toMatch(/^[a-f0-9]{16}$/);
    expect(cards[0].signature).toContain('greet');
    expect(cards[0].complexityScore).toBeGreaterThanOrEqual(1);
    expect(cards[0].calledInternals).toEqual([]);
    expect(cards[0].lastIndexed).toBeDefined();
  });

  it('skips non-function symbols', () => {
    const source = `export const MAX = 100;
export function calc() { return MAX; }`;

    const task: Task = {
      version: 1,
      file: 'src/calc.ts',
      hash: 'def456',
      symbols: [
        { name: 'MAX', kind: 'constant', exported: true, line_start: 1, line_end: 1 },
        { name: 'calc', kind: 'function', exported: true, line_start: 2, line_end: 2 },
      ],
      scanned_at: '2026-02-24T00:00:00.000Z',
    };

    const llmCards: FunctionCardLLMOutput[] = [
      { name: 'calc', summary: 'Calculates something', keyConcepts: ['calc'], behavioralProfile: 'pure' },
    ];

    const cards = buildFunctionCards(task, source, llmCards);
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('calc');
  });
});

describe('needsReindex', () => {
  const card = {
    id: 'abc123def4567890',
    filePath: 'src/foo.ts',
    name: 'test',
    signature: 'function test()',
    summary: 'Test function',
    keyConcepts: ['test'],
    behavioralProfile: 'pure' as const,
    complexityScore: 1,
    calledInternals: [],
    lastIndexed: '2026-01-01T00:00:00.000Z',
  };

  it('returns true when card is not in cache', () => {
    const cache: RagCache = { entries: {} };
    expect(needsReindex(cache, card, 'hash123')).toBe(true);
  });

  it('returns true when file hash has changed', () => {
    const cache: RagCache = { entries: { 'abc123def4567890': 'old_hash' } };
    expect(needsReindex(cache, card, 'new_hash')).toBe(true);
  });

  it('returns false when file hash matches cache', () => {
    const cache: RagCache = { entries: { 'abc123def4567890': 'same_hash' } };
    expect(needsReindex(cache, card, 'same_hash')).toBe(false);
  });
});
