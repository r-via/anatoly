// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildFunctionId,
  extractSignature,
  computeComplexity,
  extractCalledInternals,
  extractReferencedImports,
  buildFunctionCards,
  needsReindex,
  loadRagCache,
  saveRagCache,
  loadNlpSummaryCache,
  saveNlpSummaryCache,
  computeBodyHash,
  writeSharedNlpSummary,
  loadSharedNlpSummary,
  sharedNlpSummaryPath,
} from './indexer.js';
import type { RagCache, NlpSummaryCache } from './indexer.js';
import { readFileSync } from 'node:fs';
import type { SymbolInfo, Task } from '../schemas/task.js';

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

describe('extractReferencedImports', () => {
  const imports = [
    { source: './device', type: 'import' as const, symbols: ['getCarriers', 'getDivisors'] },
    { source: './paytable', type: 'import' as const, symbols: ['getPayMultiplier'] },
    { source: 'react', type: 'import' as const, symbols: ['useState'] },
  ];

  it('keeps only imported names the body actually references', () => {
    const body = 'const c = getCarriers(d); return getPayMultiplier(s, n);';
    const refs = extractReferencedImports(body, imports);
    expect(refs.sort()).toEqual(['getCarriers', 'getPayMultiplier']);
    expect(refs).not.toContain('getDivisors'); // imported but unused in this body
    expect(refs).not.toContain('useState');
  });

  it('matches a non-call reference too (constant / type read)', () => {
    const refs = extractReferencedImports('return ORB_PATHS[id] || NEUTRAL;', [
      { source: './c', type: 'import' as const, symbols: ['ORB_PATHS', 'NEUTRAL', 'UNUSED'] },
    ]);
    expect(refs.sort()).toEqual(['NEUTRAL', 'ORB_PATHS']);
  });

  it('skips namespace and bare default imports (binding name differs)', () => {
    const refs = extractReferencedImports('ns.foo(); def();', [
      { source: './ns', type: 'import' as const, namespace: true },
      { source: './def', type: 'import' as const, symbols: ['default'] },
    ]);
    expect(refs).toEqual([]);
  });

  it('returns [] when there are no imports', () => {
    expect(extractReferencedImports('const x = 1;', undefined)).toEqual([]);
    expect(extractReferencedImports('const x = 1;', [])).toEqual([]);
  });
});

describe('buildFunctionCards', () => {
  it('builds cards from AST data without LLM input', () => {
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

    const cards = buildFunctionCards(task, source);
    expect(cards).toHaveLength(2);

    expect(cards[0].name).toBe('greet');
    expect(cards[0].filePath).toBe('src/greetings.ts');
    expect(cards[0].summary).toBeUndefined();
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

    const cards = buildFunctionCards(task, source);
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
    complexityScore: 1,
    calledInternals: [] as string[],
    referencedImports: [] as string[],
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

describe('loadRagCache with cacheSuffix', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `anatoly-test-${Date.now()}`);
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads cache_lite.json when cacheSuffix is "lite"', () => {
    const cache: RagCache = { entries: { abc123def4567890: 'hash1' } };
    writeFileSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache_lite.json'), JSON.stringify(cache));

    const result = loadRagCache(tmpRoot, 'lite');
    expect(result.entries).toEqual({ abc123def4567890: 'hash1' });
  });

  it('loads cache.json when no suffix provided', () => {
    const cache: RagCache = { entries: { abc123def4567890: 'hash2' } };
    writeFileSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache.json'), JSON.stringify(cache));

    const result = loadRagCache(tmpRoot);
    expect(result.entries).toEqual({ abc123def4567890: 'hash2' });
  });

  it('falls back to legacy cache.json when mode-specific cache does not exist', () => {
    const cache: RagCache = { entries: { abc123def4567890: 'legacy' } };
    writeFileSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache.json'), JSON.stringify(cache));

    const result = loadRagCache(tmpRoot, 'lite');
    expect(result.entries).toEqual({ abc123def4567890: 'legacy' });
  });

  it('does not fall back when mode-specific cache exists', () => {
    const legacy: RagCache = { entries: { abc123def4567890: 'legacy' } };
    const modeSpecific: RagCache = { entries: { abc123def4567890: 'mode' } };
    writeFileSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache.json'), JSON.stringify(legacy));
    writeFileSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache_advanced.json'), JSON.stringify(modeSpecific));

    const result = loadRagCache(tmpRoot, 'advanced');
    expect(result.entries).toEqual({ abc123def4567890: 'mode' });
  });

  it('returns empty cache when no files exist', () => {
    const result = loadRagCache(tmpRoot, 'lite');
    expect(result.entries).toEqual({});
  });
});

describe('saveRagCache with cacheSuffix', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `anatoly-test-${Date.now()}`);
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('saves to cache_lite.json when suffix is "lite"', () => {
    const cache: RagCache = { entries: { abc123def4567890: 'saved' } };
    saveRagCache(tmpRoot, cache, 'lite');

    const filePath = resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache_lite.json');
    expect(existsSync(filePath)).toBe(true);
  });

  it('saves to cache.json when no suffix', () => {
    const cache: RagCache = { entries: { abc123def4567890: 'saved' } };
    saveRagCache(tmpRoot, cache);

    const filePath = resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'cache.json');
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NLP Summary Cache
// ---------------------------------------------------------------------------

describe('computeBodyHash', () => {
  it('returns a deterministic 16-char hex string', () => {
    const hash = computeBodyHash('function add(a, b) { return a + b; }');
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(computeBodyHash('function add(a, b) { return a + b; }')).toBe(hash);
  });

  it('returns different hashes for different bodies', () => {
    const hash1 = computeBodyHash('function add(a, b) { return a + b; }');
    const hash2 = computeBodyHash('function sub(a, b) { return a - b; }');
    expect(hash1).not.toBe(hash2);
  });
});

describe('loadNlpSummaryCache', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `anatoly-test-nlp-${Date.now()}`);
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty cache when file does not exist', () => {
    const cache = loadNlpSummaryCache(tmpRoot);
    expect(cache.entries).toEqual({});
  });

  it('loads existing NLP summary cache', () => {
    const data: NlpSummaryCache = {
      entries: {
        abc123: {
          bodyHash: 'deadbeef01234567',
          summary: { summary: 'Adds two numbers', docSummary: '', keyConcepts: ['math'], behavioralProfile: 'pure' },
        },
      },
    };
    writeFileSync(
      resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'nlp_summary_cache.json'),
      JSON.stringify(data),
    );

    const cache = loadNlpSummaryCache(tmpRoot);
    expect(cache.entries['abc123'].bodyHash).toBe('deadbeef01234567');
    expect(cache.entries['abc123'].summary.summary).toBe('Adds two numbers');
  });

  it('returns empty cache for corrupted file', () => {
    writeFileSync(
      resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'nlp_summary_cache.json'),
      'not json',
    );
    const cache = loadNlpSummaryCache(tmpRoot);
    expect(cache.entries).toEqual({});
  });

  it('ignores legacy mode-suffixed caches (migration removed in Story 56.9)', () => {
    const ragDir = resolve(tmpRoot, '.anatoly', 'cache', 'rag');
    writeFileSync(resolve(ragDir, 'nlp_summary_cache_lite.json'), JSON.stringify({ entries: { fn: { bodyHash: 'h', summary: {} } } }));
    // With migration removed, legacy files are ignored and an empty cache is returned
    const cache = loadNlpSummaryCache(tmpRoot);
    expect(cache.entries).toEqual({});
  });
});

describe('saveNlpSummaryCache', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `anatoly-test-nlp-${Date.now()}`);
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('saves to nlp_summary_cache.json', () => {
    const cache: NlpSummaryCache = {
      entries: {
        fn1: {
          bodyHash: 'hash1',
          summary: { summary: 'test', docSummary: '', keyConcepts: ['a'], behavioralProfile: 'utility' },
        },
      },
    };
    saveNlpSummaryCache(tmpRoot, cache);

    const filePath = resolve(tmpRoot, '.anatoly', 'cache', 'rag', 'nlp_summary_cache.json');
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadNlpSummaryCache(tmpRoot);
    expect(loaded.entries['fn1'].summary.summary).toBe('test');
  });

  it('round-trips correctly', () => {
    const cache: NlpSummaryCache = {
      entries: {
        fn1: {
          bodyHash: 'aabb',
          summary: { summary: 'first', docSummary: '', keyConcepts: ['x', 'y'], behavioralProfile: 'async' },
        },
        fn2: {
          bodyHash: 'ccdd',
          summary: { summary: 'second', docSummary: '', keyConcepts: ['z'], behavioralProfile: 'pure' },
        },
      },
    };
    saveNlpSummaryCache(tmpRoot, cache);
    const loaded = loadNlpSummaryCache(tmpRoot);
    expect(loaded).toEqual(cache);
  });
});

// ---------------------------------------------------------------------------
// Shared NLP Summary Cache (Story 52.4)
// ---------------------------------------------------------------------------

describe('shared NLP summary cache', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `anatoly-shared-nlp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'nlp-summaries'), { recursive: true });
    mkdirSync(resolve(tmpRoot, '.anatoly', 'cache', 'rag'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('should write NLP summary to cache/nlp-summaries with sharding', () => {
    const summary = { summary: 'Formats dates', docSummary: '', keyConcepts: ['date'], behavioralProfile: 'pure' as const };
    const bodyHash = 'abcdef1234567890';

    writeSharedNlpSummary(tmpRoot, bodyHash, summary, 'flash-2.0');

    const path = sharedNlpSummaryPath(tmpRoot, bodyHash);
    expect(existsSync(path)).toBe(true);

    // Check sharding — path includes shard prefix from bodyHash[0:2]
    expect(path).toMatch(/nlp-summaries[/\\]ab[/\\]/);

    // Check _meta header
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw._meta.schema).toBe(1);
    expect(raw._meta.model_id).toBe('flash-2.0');
    expect(raw.data.summary).toBe('Formats dates');
  });

  it('should load shared NLP summary by body hash', () => {
    const summary = { summary: 'Parses JSON', docSummary: '', keyConcepts: ['json'], behavioralProfile: 'pure' as const };
    const bodyHash = '1234abcd5678ef90';

    writeSharedNlpSummary(tmpRoot, bodyHash, summary, 'flash-2.0');

    const loaded = loadSharedNlpSummary(tmpRoot, bodyHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.summary).toBe('Parses JSON');
  });

  it('should return null for missing summary', () => {
    expect(loadSharedNlpSummary(tmpRoot, 'nonexistent')).toBeNull();
  });
});
