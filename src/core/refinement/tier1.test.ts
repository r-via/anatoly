// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { applyTier1 } from './tier1.js';
import type { Tier1Context } from './tier1.js';
import type { ReviewFile, SymbolReview } from '../../schemas/review.js';
import type { UsageGraph } from '../usage-graph.js';
import type { PreResolvedRag } from '../axis-evaluator.js';

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

function makeUsageGraph(overrides: Partial<UsageGraph> = {}): UsageGraph {
  return {
    usages: new Map(),
    typeOnlyUsages: new Map(),
    intraFileRefs: new Map(),
    noImportFiles: new Set(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<Tier1Context> = {}): Tier1Context {
  return {
    usageGraph: makeUsageGraph(),
    preResolvedRag: new Map(),
    fileContents: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyTier1', () => {
  // --- Utility axis: DEAD → USED ---

  it('AC: reclassifies DEAD→USED when usage graph shows ≥1 runtime importers', () => {
    const graph = makeUsageGraph({
      usages: new Map([['doWork::src/core/example.ts', new Set(['src/index.ts', 'src/cli.ts'])]]),
    });
    const review = makeReview({
      symbols: [{ name: 'doWork', utility: 'DEAD', confidence: 70, detail: 'No importers found' }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].utility).toBe('USED');
    expect(result.symbols[0].confidence).toBe(95);
    expect(result.symbols[0].detail).toContain('Auto-resolved: runtime-imported by 2 files');
  });

  it('AC: reclassifies DEAD→USED when transitively used', () => {
    const graph = makeUsageGraph({
      intraFileRefs: new Map([['doWork::src/core/example.ts', new Set(['mainExport'])]]),
      usages: new Map([['mainExport::src/core/example.ts', new Set(['src/index.ts'])]]),
    });
    const review = makeReview({
      symbols: [{ name: 'doWork', exported: true, utility: 'DEAD', confidence: 70, detail: 'No importers found' }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].utility).toBe('USED');
    expect(result.symbols[0].detail).toContain('Auto-resolved: transitively used by');
  });

  it('should NOT reclassify DEAD if usage graph has 0 importers and 0 transitive', () => {
    const review = makeReview({
      symbols: [{ name: 'doWork', exported: true, utility: 'DEAD', confidence: 70, detail: 'No importers found' }],
    });
    const ctx = makeContext();

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].utility).toBe('DEAD');
  });

  // --- Duplication axis: DUPLICATE → UNIQUE ---

  it('AC: reclassifies DUPLICATE→UNIQUE when no RAG candidate (score < 0.68)', () => {
    const ragMap = new Map<string, PreResolvedRag>();
    ragMap.set('src/core/example.ts', [
      { symbolName: 'doWork', lineStart: 1, lineEnd: 20, results: [{ card: {} as any, score: 0.55 }] },
    ]);
    const review = makeReview({
      symbols: [{ name: 'doWork', duplication: 'DUPLICATE', confidence: 70, detail: 'Possible duplicate' }],
    });
    const ctx = makeContext({ preResolvedRag: ragMap });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('UNIQUE');
    expect(result.symbols[0].confidence).toBe(90);
  });

  it('AC: reclassifies DUPLICATE→UNIQUE when no RAG data at all', () => {
    const review = makeReview({
      symbols: [{ name: 'doWork', duplication: 'DUPLICATE', confidence: 70, detail: 'Possible duplicate' }],
    });
    const ctx = makeContext({ preResolvedRag: new Map() });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('UNIQUE');
    expect(result.symbols[0].confidence).toBe(90);
  });

  it('AC: reclassifies DUPLICATE→UNIQUE when function is ≤2 lines', () => {
    const ragMap = new Map<string, PreResolvedRag>();
    ragMap.set('src/core/example.ts', [
      { symbolName: 'doWork', lineStart: 1, lineEnd: 2, results: [{ card: {} as any, score: 0.85 }] },
    ]);
    const review = makeReview({
      symbols: [{
        name: 'doWork', line_start: 1, line_end: 2,
        duplication: 'DUPLICATE', confidence: 70, detail: 'Possible duplicate',
      }],
    });
    const ctx = makeContext({ preResolvedRag: ragMap });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('UNIQUE');
    expect(result.symbols[0].detail).toContain('Trivial function');
  });

  it('should NOT reclassify DUPLICATE when RAG score ≥ 0.68 and function > 2 lines', () => {
    const ragMap = new Map<string, PreResolvedRag>();
    ragMap.set('src/core/example.ts', [
      { symbolName: 'doWork', lineStart: 1, lineEnd: 20, results: [{ card: {} as any, score: 0.80 }] },
    ]);
    const review = makeReview({
      symbols: [{ name: 'doWork', duplication: 'DUPLICATE', confidence: 70, detail: 'Possible duplicate' }],
    });
    const ctx = makeContext({ preResolvedRag: ragMap });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('DUPLICATE');
  });

  // --- Overengineering axis: OVER → LEAN ---

  it('AC: reclassifies OVER→LEAN when kind = interface', () => {
    const review = makeReview({
      symbols: [{ name: 'MyInterface', kind: 'type', overengineering: 'OVER', confidence: 70, detail: 'Over-engineered' }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('AC: reclassifies OVER→LEAN when kind = enum', () => {
    const review = makeReview({
      symbols: [{ name: 'Status', kind: 'enum', overengineering: 'OVER', confidence: 70, detail: 'Over-engineered' }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('AC: reclassifies OVER→LEAN when function ≤5 lines', () => {
    const review = makeReview({
      symbols: [{
        name: 'tiny', kind: 'function', line_start: 1, line_end: 5,
        overengineering: 'OVER', confidence: 70, detail: 'Over-engineered',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('should NOT reclassify OVER when function > 5 lines and kind is function', () => {
    const review = makeReview({
      symbols: [{
        name: 'bigFunc', kind: 'function', line_start: 1, line_end: 50,
        overengineering: 'OVER', confidence: 70, detail: 'Over-engineered',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('OVER');
  });

  // --- Documentation axis: UNDOCUMENTED → DOCUMENTED ---

  it('AC: reclassifies UNDOCUMENTED→DOCUMENTED when JSDoc exists (> 20 chars)', () => {
    const fileContents = new Map([
      ['src/core/example.ts', '/**\n * Process input data and return formatted output.\n */\nexport function doWork() {}'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'doWork', exported: true, line_start: 4, line_end: 4,
        documentation: 'UNDOCUMENTED', confidence: 70, detail: 'No JSDoc',
      }],
    });
    const ctx = makeContext({ fileContents });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].documentation).toBe('DOCUMENTED');
    expect(result.symbols[0].confidence).toBe(90);
  });

  it('AC: reclassifies UNDOCUMENTED→DOCUMENTED for self-descriptive type (≤5 fields)', () => {
    const fileContents = new Map([
      ['src/core/example.ts', 'export interface UserConfig {\n  name: string;\n  age: number;\n  email: string;\n}'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'UserConfig', kind: 'type', exported: true, line_start: 1, line_end: 5,
        documentation: 'UNDOCUMENTED', confidence: 70, detail: 'No JSDoc',
      }],
    });
    const ctx = makeContext({ fileContents });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].documentation).toBe('DOCUMENTED');
    expect(result.symbols[0].detail).toContain('Self-descriptive type');
  });

  it('should NOT reclassify UNDOCUMENTED when no JSDoc and not self-descriptive', () => {
    const fileContents = new Map([
      ['src/core/example.ts', 'export function doWork() { return 42; }'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'doWork', exported: true, line_start: 1, line_end: 1,
        documentation: 'UNDOCUMENTED', confidence: 70, detail: 'No JSDoc',
      }],
    });
    const ctx = makeContext({ fileContents });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].documentation).toBe('UNDOCUMENTED');
  });

  // --- Fixture / gold-set files ---

  it('AC: skips correction/utility findings for __fixtures__ files', () => {
    const review = makeReview({
      file: 'src/__fixtures__/broken.ts',
      symbols: [{
        name: 'broken', correction: 'NEEDS_FIX', utility: 'DEAD',
        confidence: 85, detail: 'Fixture file',
      }],
    });
    const result = applyTier1(review, makeContext());

    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].utility).toBe('USED');
    expect(result.symbols[0].detail).toContain('Intentional fixture code');
  });

  it('AC: skips correction/utility findings for __gold-set__ files', () => {
    const review = makeReview({
      file: 'tests/__gold-set__/sample.ts',
      symbols: [{
        name: 'sample', correction: 'ERROR', utility: 'DEAD',
        confidence: 90, detail: 'Gold set file',
      }],
    });
    const result = applyTier1(review, makeContext());

    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].utility).toBe('USED');
    expect(result.symbols[0].detail).toContain('Intentional fixture code');
  });

  // --- Tests axis: NONE confirmed when no test file ---

  it('AC: confirms tests: NONE when no test file exists (no change)', () => {
    const review = makeReview({
      symbols: [{ name: 'doWork', tests: 'NONE', confidence: 70, detail: 'No tests found' }],
    });
    const result = applyTier1(review, makeContext());

    // No change — just confirmed
    expect(result.symbols[0].tests).toBe('NONE');
  });

  // --- Performance: no network calls ---

  it('AC: should process all symbols in < 1 second with no network calls', () => {
    // Create a large review with 200 symbols
    const symbols = Array.from({ length: 200 }, (_, i) =>
      makeSymbol({ name: `symbol_${i}`, utility: 'DEAD', confidence: 70, detail: `No importers for ${i}` }),
    );
    const review = makeReview({ symbols } as any);
    const ctx = makeContext();

    const start = Date.now();
    applyTier1(review, ctx);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  // --- Returns a new review (immutability) ---

  it('should return a new ReviewFile object (not mutate input)', () => {
    const review = makeReview({
      symbols: [{ name: 'doWork', utility: 'DEAD', confidence: 70, detail: 'No importers found' }],
    });
    const original = JSON.parse(JSON.stringify(review));
    const graph = makeUsageGraph({
      usages: new Map([['doWork::src/core/example.ts', new Set(['src/index.ts'])]]),
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    // Result should be different
    expect(result.symbols[0].utility).toBe('USED');
    // Original should be unchanged
    expect(JSON.stringify(review)).toBe(JSON.stringify(original));
  });

  // --- Recalculates verdict after reclassifications ---

  it('should recalculate verdict to CLEAN when all findings are resolved', () => {
    const graph = makeUsageGraph({
      usages: new Map([['doWork::src/core/example.ts', new Set(['src/index.ts'])]]),
    });
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [{
        name: 'doWork', utility: 'DEAD', confidence: 70, detail: 'No importers found',
        correction: 'OK', duplication: 'UNIQUE', overengineering: 'LEAN',
        tests: 'GOOD', documentation: 'DOCUMENTED',
      }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    expect(result.verdict).toBe('CLEAN');
  });

  // --- Stats tracking ---

  it('should return stats with count of resolved findings', () => {
    const graph = makeUsageGraph({
      usages: new Map([['doWork::src/core/example.ts', new Set(['src/index.ts'])]]),
    });
    const review = makeReview({
      symbols: [{ name: 'doWork', utility: 'DEAD', confidence: 70, detail: 'No importers found' }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    expect(result._tier1Stats).toBeDefined();
    expect(result._tier1Stats!.resolved).toBeGreaterThan(0);
  });
});
