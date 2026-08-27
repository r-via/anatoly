// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { applyTier1, hasJsDocBefore, isSelfContradictingDuplicate, classHasHeritageClause } from './tier1.js';
import type { Tier1Context } from './tier1.js';
import type { ReviewFile, SymbolReview } from '../../../schemas/review.js';
import type { UsageGraph } from '../../scanning/index.js';
import type { PreResolvedRag } from '../contract.js';
import type { FunctionCard } from '../../../rag/types.js';

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
    flow: '-',
    confidence: 85,
    detail: 'All axes evaluated successfully.',
    duplicate_target: undefined,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReview(overrides: Record<string, any> = {}): ReviewFile {
  const { symbols: symOverrides, ...rest } = overrides;
  return {
    version: 2,
    file: 'src/core/example.ts',
    verdict: 'NEEDS_REFACTOR',
    symbols: symOverrides ? symOverrides.map((s: Partial<SymbolReview>) => makeSymbol(s)) : [makeSymbol()],
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

  it('purges the synthesized "Remove dead code" action when DEAD→USED resolves', () => {
    const graph = makeUsageGraph({
      typeOnlyUsages: new Map([['Progress::src/rag/prefetch.ts', new Set(['src/cli/setup.ts'])]]),
    });
    const review = makeReview({
      file: 'src/rag/prefetch.ts',
      symbols: [{ name: 'Progress', exported: true, utility: 'DEAD', confidence: 90, detail: 'No importers found' }],
      actions: [{
        id: 1,
        description: 'Remove dead code: `Progress` is exported but unused',
        severity: 'high', effort: 'trivial', category: 'quickwin',
        source: 'utility', target_symbol: 'Progress', target_lines: 'L1-L3',
      }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].utility).toBe('USED');
    // the now-stale dead-code action must be gone, not surfaced in the report
    expect(result.actions.find((a) => a.source === 'utility' && a.target_symbol === 'Progress')).toBeUndefined();
  });

  it('generalizes the purge to documentation (UNDOCUMENTED→DOCUMENTED drops the JSDoc action)', () => {
    const content = '/**\n * A clear description of foo and what it returns.\n */\nexport function foo() {}\n';
    const review = makeReview({
      file: 'src/x.ts',
      symbols: [{ name: 'foo', exported: true, documentation: 'UNDOCUMENTED', confidence: 80, detail: 'No JSDoc', line_start: 4, line_end: 4 }],
      actions: [{
        id: 1, description: 'Add a JSDoc block to `foo`', severity: 'medium', effort: 'trivial', category: 'refactor',
        source: 'documentation', target_symbol: 'foo', target_lines: 'L4-L4',
      }],
    });
    const ctx = makeContext({ fileContents: new Map([['src/x.ts', content]]) });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].documentation).toBe('DOCUMENTED');
    expect(result.actions.find((a) => a.source === 'documentation' && a.target_symbol === 'foo')).toBeUndefined();
  });

  it('keeps an action whose source is not a verdict-driven axis', () => {
    const graph = makeUsageGraph({ usages: new Map([['x::src/x.ts', new Set(['src/y.ts'])]]) });
    const review = makeReview({
      file: 'src/x.ts',
      symbols: [{ name: 'x', exported: true, utility: 'DEAD', confidence: 90, detail: 'No importers found' }],
      actions: [{
        id: 1, description: 'Apply a best-practice rule', severity: 'medium', effort: 'trivial', category: 'refactor',
        source: 'best_practices', target_symbol: 'x', target_lines: 'L1-L1',
      }],
    });

    const result = applyTier1(review, makeContext({ usageGraph: graph }));

    // x flips DEAD→USED, but the action's source axis is not verdict-action-driven → never purged.
    expect(result.symbols[0].utility).toBe('USED');
    expect(result.actions.some((a) => a.source === 'best_practices' && a.target_symbol === 'x')).toBe(true);
  });

  it('keeps a synthesized action when the verdict stays actionable', () => {
    const review = makeReview({
      file: 'src/x.ts',
      symbols: [{ name: 'gone', exported: true, utility: 'DEAD', confidence: 90, detail: 'No importers found' }],
      actions: [{
        id: 1, description: 'Remove dead code: `gone` is exported but unused', severity: 'high', effort: 'trivial', category: 'quickwin',
        source: 'utility', target_symbol: 'gone', target_lines: 'L1-L1',
      }],
    });

    // Empty usage graph → no importers → stays DEAD → action kept.
    const result = applyTier1(review, makeContext());

    expect(result.symbols[0].utility).toBe('DEAD');
    expect(result.actions.some((a) => a.source === 'utility' && a.target_symbol === 'gone')).toBe(true);
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
      { symbolName: 'doWork', lineStart: 1, lineEnd: 20, results: [{ card: {} as unknown as FunctionCard, score: 0.55 }] },
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
      { symbolName: 'doWork', lineStart: 1, lineEnd: 2, results: [{ card: {} as unknown as FunctionCard, score: 0.85 }] },
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
      { symbolName: 'doWork', lineStart: 1, lineEnd: 20, results: [{ card: {} as unknown as FunctionCard, score: 0.80 }] },
    ]);
    const review = makeReview({
      symbols: [{ name: 'doWork', duplication: 'DUPLICATE', confidence: 70, detail: 'Possible duplicate' }],
    });
    const ctx = makeContext({ preResolvedRag: ragMap });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('DUPLICATE');
  });

  it('should NOT reclassify DUPLICATE when duplicate_target is populated, even if RAG score < 0.68', () => {
    // Regression: the duplication LLM previously pointed at a concrete
    // match (e.g. rng.ts::weightedPick ↔ reels.ts::pickFromWeighted at
    // 99% semantic similarity) while the underlying RAG embedding score
    // stayed below 0.68 — exactly the case where embeddings diverge from
    // semantic equivalence (renamed variables, different generics). The
    // tier-1 RAG-threshold heuristic was stripping the verdict anyway,
    // erasing the LLM's evidence. A populated target is committed
    // evidence and must not be overridden by a cheap post-hoc heuristic.
    const ragMap = new Map<string, PreResolvedRag>();
    ragMap.set('src/rng.ts', [
      { symbolName: 'weightedPick', lineStart: 5, lineEnd: 16, results: [{ card: {} as unknown as FunctionCard, score: 0.42 }] },
    ]);
    const review = makeReview({
      file: 'src/rng.ts',
      symbols: [{
        name: 'weightedPick',
        line_start: 5,
        line_end: 16,
        duplication: 'DUPLICATE',
        confidence: 95,
        detail: 'Identical weighted random selection algorithm.',
        duplicate_target: {
          file: 'src/reels.ts',
          symbol: 'pickFromWeighted',
          similarity: '99% identical logic',
        },
      }],
    });
    const ctx = makeContext({ preResolvedRag: ragMap });

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('DUPLICATE');
    expect(result.symbols[0].duplicate_target?.symbol).toBe('pickFromWeighted');
    expect(result.symbols[0].detail).toBe('Identical weighted random selection algorithm.');
  });

  it('demotes a self-contradicting DUPLICATE (below 0.82 + "differs") and clears the target', () => {
    // ui-kit-app Stat↔Metric: the LLM emitted DUPLICATE with a populated
    // target, but its own rationale says 0.744 (below 0.82) and the code
    // "differs significantly". That self-contradiction is a false positive.
    const review = makeReview({
      file: 'client/src/components/ImportDialog.tsx',
      symbols: [{
        name: 'Stat',
        line_start: 1,
        line_end: 12,
        duplication: 'DUPLICATE',
        confidence: 82,
        detail: '[DUPLICATE] RAG score 0.744 against Metric in PatientsPage.tsx — below the 0.82 duplicate threshold. Actual code differs significantly: Stat accepts an icon prop and renders a card.',
        duplicate_target: {
          file: 'client/src/pages/PatientsPage.tsx',
          symbol: 'Metric',
          similarity: 'shared label+value pattern, but Stat adds icon rendering and card styling',
        },
      }],
      actions: [{
        id: 1, description: 'Deduplicate: `Stat` duplicates `Metric` in `client/src/pages/PatientsPage.tsx`',
        severity: 'high', effort: 'small', category: 'refactor',
        source: 'duplication', target_symbol: 'Stat', target_lines: 'L1-L12',
      }],
    });

    const result = applyTier1(review, makeContext());

    expect(result.symbols[0].duplication).toBe('UNIQUE');
    expect(result.symbols[0].duplicate_target).toBeUndefined();
    // the now-stale deduplicate action must be purged
    expect(result.actions.some((a) => a.source === 'duplication' && a.target_symbol === 'Stat')).toBe(false);
  });

  it('does NOT demote a confident low-RAG DUPLICATE that lacks self-contradiction language', () => {
    // The protection must survive: low embedding score + populated target, but
    // the rationale asserts a real match (no "differs"/"below threshold").
    const review = makeReview({
      symbols: [{
        name: 'doWork', line_start: 1, line_end: 20,
        duplication: 'DUPLICATE', confidence: 95,
        detail: 'Same control flow and identical branching as helper; variables renamed.',
        duplicate_target: { file: 'src/other.ts', symbol: 'helper', similarity: 'same algorithm, renamed locals' },
      }],
    });

    const result = applyTier1(review, makeContext());

    expect(result.symbols[0].duplication).toBe('DUPLICATE');
    expect(result.symbols[0].duplicate_target?.symbol).toBe('helper');
  });

  it('should NOT reclassify DUPLICATE when duplicate_target is populated on a trivial (≤2 line) function', () => {
    // Same principle as the RAG-score case: a committed target wins over
    // the trivial-function heuristic. The LLM asserted a specific match;
    // we trust that evidence over a cheap length-based rule.
    const review = makeReview({
      symbols: [{
        name: 'getCount',
        line_start: 1,
        line_end: 2,
        duplication: 'DUPLICATE',
        confidence: 95,
        detail: 'Identical to getSize.',
        duplicate_target: {
          file: 'src/other.ts',
          symbol: 'getSize',
          similarity: '100% identical',
        },
      }],
    });
    const ctx = makeContext();

    const result = applyTier1(review, ctx);

    expect(result.symbols[0].duplication).toBe('DUPLICATE');
    expect(result.symbols[0].duplicate_target?.symbol).toBe('getSize');
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

  // --- Overengineering axis: LEAN → OVER (usage-graph promotion) ---

  it('promotes LEAN→OVER when exported class has 0 importers', () => {
    const review = makeReview({
      symbols: [{
        name: 'SpinEventEmitter', kind: 'class', exported: true,
        line_start: 1, line_end: 30,
        overengineering: 'LEAN', confidence: 80, detail: 'Clean structure',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('OVER');
    expect(result.symbols[0].detail).toContain('imported by 0 files');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].source).toBe('overengineering');
    expect(result.actions[0].target_symbol).toBe('SpinEventEmitter');
  });

  it('promotes LEAN→OVER when exported class has exactly 1 importer', () => {
    const graph = makeUsageGraph({
      usages: new Map([['AbstractFactory::src/core/example.ts', new Set(['src/main.ts'])]]),
    });
    const review = makeReview({
      symbols: [{
        name: 'AbstractFactory', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Looks fine',
      }],
    });
    const result = applyTier1(review, makeContext({ usageGraph: graph }));
    expect(result.symbols[0].overengineering).toBe('OVER');
    expect(result.symbols[0].detail).toContain('imported by 1 file');
  });

  it('does NOT promote LEAN→OVER when class has ≥2 importers', () => {
    const graph = makeUsageGraph({
      usages: new Map([['Widget::src/core/example.ts', new Set(['src/a.ts', 'src/b.ts'])]]),
    });
    const review = makeReview({
      symbols: [{
        name: 'Widget', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Looks fine',
      }],
    });
    const result = applyTier1(review, makeContext({ usageGraph: graph }));
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('does NOT promote LEAN→OVER when class is under 15 lines', () => {
    const review = makeReview({
      symbols: [{
        name: 'Tiny', kind: 'class', exported: true,
        line_start: 1, line_end: 10,
        overengineering: 'LEAN', confidence: 80, detail: 'Looks fine',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('does NOT promote entry-point classes (main/app/bootstrap) even with ≤1 importer', () => {
    const review = makeReview({
      symbols: [{
        name: 'App', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'App class',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('does NOT promote non-exported classes', () => {
    const review = makeReview({
      symbols: [{
        name: 'InternalHelper', kind: 'class', exported: false,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Helper',
      }],
    });
    const result = applyTier1(review, makeContext());
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('counts type-only importers when deciding promotion', () => {
    const graph = makeUsageGraph({
      typeOnlyUsages: new Map([['Strategy::src/core/example.ts', new Set(['src/impl.ts'])]]),
    });
    const review = makeReview({
      symbols: [{
        name: 'Strategy', kind: 'class', exported: true,
        line_start: 1, line_end: 30,
        overengineering: 'LEAN', confidence: 80, detail: 'Looks fine',
      }],
    });
    const result = applyTier1(review, makeContext({ usageGraph: graph }));
    expect(result.symbols[0].overengineering).toBe('OVER');
    expect(result.symbols[0].detail).toContain('imported by 1 file');
  });

  it('does NOT promote a class that implements an interface (polymorphic family, ≤1 importer)', () => {
    const graph = makeUsageGraph({
      usages: new Map([['TypeScriptAdapter::src/core/example.ts', new Set(['src/core/registry.ts'])]]),
    });
    const fileContents = new Map([
      ['src/core/example.ts', 'export class TypeScriptAdapter implements LanguageAdapter {\n  parse() { return []; }\n}'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'TypeScriptAdapter', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Clean adapter',
      }],
    });
    const result = applyTier1(review, makeContext({ usageGraph: graph, fileContents }));
    expect(result.symbols[0].overengineering).toBe('LEAN');
    expect(result.actions).toHaveLength(0);
  });

  it('does NOT promote a class that extends a base class (≤1 importer)', () => {
    const fileContents = new Map([
      ['src/core/example.ts', 'export class JsonAdapter extends BaseAdapter {\n  parse() { return {}; }\n}'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'JsonAdapter', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Clean adapter',
      }],
    });
    const result = applyTier1(review, makeContext({ fileContents }));
    expect(result.symbols[0].overengineering).toBe('LEAN');
  });

  it('still promotes a standalone class with no heritage clause (≤1 importer)', () => {
    const fileContents = new Map([
      ['src/core/example.ts', 'export class ConfigManager {\n  load() { return 1; }\n}'],
    ]);
    const review = makeReview({
      symbols: [{
        name: 'ConfigManager', kind: 'class', exported: true,
        line_start: 1, line_end: 40,
        overengineering: 'LEAN', confidence: 80, detail: 'Single-client wrapper',
      }],
    });
    const result = applyTier1(review, makeContext({ fileContents }));
    expect(result.symbols[0].overengineering).toBe('OVER');
    expect(result.symbols[0].detail).toContain('imported by 0 files');
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
    const review = makeReview({ symbols } as unknown as Parameters<typeof makeReview>[0]);
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

  // --- Detail-segment preservation (regression: see PR fix(report))
  //
  // axis-merger emits `detail` as `[VERDICT_A] text | [VERDICT_B] text | ...`.
  // render-axis.axisDetail(s, axis) locates a segment by its `[VERDICT] ` tag.
  // Prior to this fix, tier1 reclassification sites assigned a flat string,
  // wiping every other axis's segment — so the public report showed (for
  // example) "Auto-resolved: runtime-imported by N files" as the rationale
  // on the correction, tests, and documentation axes for the same symbol,
  // when the LLM's per-axis rationale was the real signal.

  it('utility DEAD→USED preserves segments of other axes in detail', () => {
    const graph = makeUsageGraph({
      usages: new Map([['doWork::src/core/example.ts', new Set(['src/index.ts', 'src/cli.ts'])]]),
    });
    const review = makeReview({
      symbols: [{
        name: 'doWork',
        utility: 'DEAD',
        overengineering: 'OVER',
        tests: 'NONE',
        documentation: 'UNDOCUMENTED',
        confidence: 70,
        detail: '[DEAD] No importers found | [OVER] Bloated class with many methods | [NONE] No test file exists | [UNDOCUMENTED] Public function, no docstring',
      }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);
    const d = result.symbols[0].detail;

    // utility segment was rewritten
    expect(d).toContain('[USED] Auto-resolved: runtime-imported by 2 files');
    expect(d).not.toContain('[DEAD]');
    // other axes preserved verbatim
    expect(d).toContain('[OVER] Bloated class with many methods');
    expect(d).toContain('[NONE] No test file exists');
    expect(d).toContain('[UNDOCUMENTED] Public function, no docstring');
    // pipe-delimited format intact
    expect(d.split(' | ').length).toBe(4);
  });

  it('overengineering LEAN→OVER preserves other axis segments', () => {
    const graph = makeUsageGraph({
      usages: new Map([['BigClass::src/core/example.ts', new Set(['src/sole-client.ts'])]]),
    });
    const review = makeReview({
      symbols: [{
        name: 'BigClass',
        kind: 'class',
        exported: true,
        line_start: 1,
        line_end: 40,
        overengineering: 'LEAN',
        correction: 'NEEDS_FIX',
        detail: '[NEEDS_FIX] Off-by-one in loop bound | [LEAN] Class is concise | [USED] Imported by 1 file',
      }],
    });
    const ctx = makeContext({ usageGraph: graph });

    const result = applyTier1(review, ctx);
    const d = result.symbols[0].detail;

    expect(result.symbols[0].overengineering).toBe('OVER');
    expect(d).toContain('[OVER] Auto-promoted: exported class imported by 1 file');
    // The correction rationale from the LLM must survive
    expect(d).toContain('[NEEDS_FIX] Off-by-one in loop bound');
    expect(d).toContain('[USED] Imported by 1 file');
  });

  it('overengineering OVER→LEAN preserves other axis segments', () => {
    const review = makeReview({
      symbols: [{
        name: 'tinyHelper',
        kind: 'function',
        line_start: 1,
        line_end: 3,
        overengineering: 'OVER',
        correction: 'OK',
        utility: 'USED',
        detail: '[OK] No bug | [OVER] Looks over-designed | [USED] Imported by 5 files',
      }],
    });
    const ctx = makeContext();

    const result = applyTier1(review, ctx);
    const d = result.symbols[0].detail;

    expect(result.symbols[0].overengineering).toBe('LEAN');
    expect(d).toContain('[LEAN] Auto-resolved: function ≤');
    expect(d).toContain('[OK] No bug');
    expect(d).toContain('[USED] Imported by 5 files');
  });
});

describe('hasJsDocBefore', () => {
  // line numbers are 1-based; the symbol is on the last line of each fixture.
  it('returns true when a JSDoc block directly precedes the symbol', () => {
    const src = [
      '/**',
      ' * Does the important work for the pipeline.',
      ' */',
      'function foo() {}',
    ].join('\n');
    expect(hasJsDocBefore(src, 4)).toBe(true);
  });

  it('returns true for a long single-line JSDoc', () => {
    const src = '/** Documents foo thoroughly enough. */\nfunction foo() {}';
    expect(hasJsDocBefore(src, 2)).toBe(true);
  });

  it('looks past decorators between the JSDoc and the symbol', () => {
    const src = [
      '/**',
      ' * A documented, decorated class.',
      ' */',
      '@Component()',
      'class Foo {}',
    ].join('\n');
    expect(hasJsDocBefore(src, 5)).toBe(true);
  });

  it('does NOT count a JSDoc that belongs to an earlier symbol (the bug)', () => {
    const src = [
      '/** Documentation for foo function here. */',
      'function foo() {}',
      '',
      'function bar() {}', // bar has no JSDoc of its own
    ].join('\n');
    expect(hasJsDocBefore(src, 4)).toBe(false);
  });

  it('returns false when there is no JSDoc at all', () => {
    const src = '// a plain line comment\nfunction foo() {}';
    expect(hasJsDocBefore(src, 2)).toBe(false);
  });
});

describe('isSelfContradictingDuplicate', () => {
  it('true: stated score below 0.82 AND negation language', () => {
    expect(isSelfContradictingDuplicate('RAG score 0.744 — below the 0.82 duplicate threshold. Actual code differs significantly.')).toBe(true);
  });

  it('true: negation comes from the similarity text, score from the detail', () => {
    expect(isSelfContradictingDuplicate('similarity 0.71 against Metric', 'shared pattern, but adds an icon — not a duplicate')).toBe(true);
  });

  it('false: negation language but no stated score', () => {
    expect(isSelfContradictingDuplicate('The two components differ significantly in their props.')).toBe(false);
  });

  it('false: low score but no negation language (genuine low-RAG semantic match)', () => {
    expect(isSelfContradictingDuplicate('RAG score 0.42 but identical control flow; variables renamed.')).toBe(false);
  });

  it('false: negation language but the stated score is >= 0.82 (trust the high score)', () => {
    expect(isSelfContradictingDuplicate('RAG score 0.91 against Metric, though the surface differs significantly')).toBe(false);
  });
});

describe('classHasHeritageClause', () => {
  it('detects an implements clause', () => {
    expect(classHasHeritageClause('export class Foo implements Bar {}', 'Foo')).toBe(true);
  });

  it('detects an extends clause', () => {
    expect(classHasHeritageClause('class Foo extends Base {}', 'Foo')).toBe(true);
  });

  it('detects heritage on a generic class', () => {
    expect(classHasHeritageClause('export class Foo<T> extends Base<T> implements I {}', 'Foo')).toBe(true);
  });

  it('returns false for a standalone class', () => {
    expect(classHasHeritageClause('export class Foo {\n  do() {}\n}', 'Foo')).toBe(false);
  });

  it('does not match a different class that has heritage', () => {
    expect(classHasHeritageClause('class Other implements X {}\nexport class Foo {}', 'Foo')).toBe(false);
  });

  it('does not collide on a name prefix (FooBar vs Foo)', () => {
    expect(classHasHeritageClause('export class FooBar implements X {}', 'Foo')).toBe(false);
  });

  it('returns false when the source is unavailable', () => {
    expect(classHasHeritageClause(undefined, 'Foo')).toBe(false);
  });
});
