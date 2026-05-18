// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Story 54.9 — doc_divergence findings + aggregation + doc mode in report
// ---------------------------------------------------------------------------

// AC1: DocDivergence schema exists with FR15 form, severity limited to info|warn
describe('Story 54.9 — AC1: DocDivergence schema', () => {
  it('DocDivergenceSchema exists in review.ts', async () => {
    const { DocDivergenceSchema } = await import('../../schemas/review.js');
    expect(DocDivergenceSchema).toBeDefined();
  });

  it('DocDivergenceSchema accepts a valid doc_divergence finding', async () => {
    const { DocDivergenceSchema } = await import('../../schemas/review.js');
    const valid = {
      kind: 'doc_divergence',
      severity: 'warn',
      file: 'src/core/foo.ts',
      line: 42,
      symbol: 'processData',
      reference_excerpt: 'processData accepts a Buffer',
      reference_source: 'README.md#processdata',
      observed_behavior: 'processData accepts a string, not a Buffer',
      axis_origin: 'correction',
    };
    const result = DocDivergenceSchema.parse(valid);
    expect(result.kind).toBe('doc_divergence');
    expect(result.severity).toBe('warn');
    expect(result.axis_origin).toBe('correction');
  });

  it('severity is limited to info | warn (no error)', async () => {
    const { DocDivergenceSchema } = await import('../../schemas/review.js');
    const invalid = {
      kind: 'doc_divergence',
      severity: 'error',
      file: 'src/foo.ts',
      reference_excerpt: 'some excerpt',
      reference_source: 'README.md',
      observed_behavior: 'different behavior',
      axis_origin: 'correction',
    };
    expect(() => DocDivergenceSchema.parse(invalid)).toThrow();
  });

  it('axis_origin limited to correction | best_practices | overengineering | tests', async () => {
    const { DocDivergenceSchema } = await import('../../schemas/review.js');
    const base = {
      kind: 'doc_divergence',
      severity: 'info',
      file: 'src/foo.ts',
      reference_excerpt: 'excerpt',
      reference_source: 'README.md',
      observed_behavior: 'observed',
    };
    // Valid origins
    for (const origin of ['correction', 'best_practices', 'overengineering', 'tests']) {
      expect(() => DocDivergenceSchema.parse({ ...base, axis_origin: origin })).not.toThrow();
    }
    // Invalid origin
    expect(() => DocDivergenceSchema.parse({ ...base, axis_origin: 'utility' })).toThrow();
  });

  it('line and symbol are optional', async () => {
    const { DocDivergenceSchema } = await import('../../schemas/review.js');
    const minimal = {
      kind: 'doc_divergence',
      severity: 'info',
      file: 'src/foo.ts',
      reference_excerpt: 'excerpt',
      reference_source: 'README.md',
      observed_behavior: 'observed',
      axis_origin: 'correction',
    };
    const result = DocDivergenceSchema.parse(minimal);
    expect(result.line).toBeUndefined();
    expect(result.symbol).toBeUndefined();
  });

  it('ReviewFileSchema accepts doc_divergences array', async () => {
    const { ReviewFileSchema } = await import('../../schemas/review.js');
    const review = {
      version: 2,
      file: 'src/foo.ts',
      verdict: 'CLEAN',
      symbols: [],
      file_level: {},
      doc_divergences: [{
        kind: 'doc_divergence',
        severity: 'warn',
        file: 'src/foo.ts',
        reference_excerpt: 'excerpt',
        reference_source: 'README.md',
        observed_behavior: 'observed',
        axis_origin: 'correction',
      }],
    };
    const result = ReviewFileSchema.parse(review);
    expect(result.doc_divergences).toHaveLength(1);
    expect(result.doc_divergences![0].kind).toBe('doc_divergence');
  });

  it('ReviewFileSchema defaults doc_divergences to empty array when absent', async () => {
    const { ReviewFileSchema } = await import('../../schemas/review.js');
    const review = {
      version: 2,
      file: 'src/foo.ts',
      verdict: 'CLEAN',
      symbols: [],
      file_level: {},
    };
    const result = ReviewFileSchema.parse(review);
    expect(result.doc_divergences).toBeUndefined();
  });
});

// AC2: 4 axis response schemas accept doc_divergences
describe('Story 54.9 — AC2: Axis response schemas accept doc_divergences', () => {
  it('CorrectionResponseSchema accepts doc_divergences array', async () => {
    const { CorrectionResponseSchema } = await import('../evaluation/axes/correction.js');
    const response = {
      symbols: [],
      actions: [],
      doc_divergences: [{
        kind: 'doc_divergence',
        severity: 'warn',
        file: 'src/foo.ts',
        reference_excerpt: 'should return number',
        reference_source: 'README.md',
        observed_behavior: 'returns string',
        axis_origin: 'correction',
      }],
    };
    const result = CorrectionResponseSchema.parse(response);
    expect(result.doc_divergences).toHaveLength(1);
  });

  it('OverengineeringResponseSchema accepts doc_divergences array', async () => {
    const { OverengineeringResponseSchema } = await import('../evaluation/axes/overengineering.js');
    const response = {
      symbols: [],
      doc_divergences: [{
        kind: 'doc_divergence',
        severity: 'info',
        file: 'src/foo.ts',
        reference_excerpt: 'uses simple pattern',
        reference_source: 'docs/arch.md',
        observed_behavior: 'uses factory pattern',
        axis_origin: 'overengineering',
      }],
    };
    const result = OverengineeringResponseSchema.parse(response);
    expect(result.doc_divergences).toHaveLength(1);
  });

  it('TestsResponseSchema accepts doc_divergences array', async () => {
    const { TestsResponseSchema } = await import('../evaluation/axes/tests.js');
    const response = {
      symbols: [],
      doc_divergences: [{
        kind: 'doc_divergence',
        severity: 'warn',
        file: 'src/foo.ts',
        reference_excerpt: 'tests use jest',
        reference_source: 'README.md',
        observed_behavior: 'tests use vitest',
        axis_origin: 'tests',
      }],
    };
    const result = TestsResponseSchema.parse(response);
    expect(result.doc_divergences).toHaveLength(1);
  });

  it('BestPracticesResponseSchema accepts doc_divergences array', async () => {
    const { BestPracticesResponseSchema } = await import('../evaluation/axes/best-practices.js');
    const response = {
      score: 8,
      rules: [],
      suggestions: [],
      doc_divergences: [{
        kind: 'doc_divergence',
        severity: 'info',
        file: 'src/foo.ts',
        reference_excerpt: 'follow ESM pattern',
        reference_source: 'CONTRIBUTING.md',
        observed_behavior: 'uses CJS require()',
        axis_origin: 'best_practices',
      }],
    };
    const result = BestPracticesResponseSchema.parse(response);
    expect(result.doc_divergences).toHaveLength(1);
  });

  it('all 4 axis schemas treat doc_divergences as optional when absent', async () => {
    const { CorrectionResponseSchema } = await import('../evaluation/axes/correction.js');
    const { OverengineeringResponseSchema } = await import('../evaluation/axes/overengineering.js');
    const { TestsResponseSchema } = await import('../evaluation/axes/tests.js');
    const { BestPracticesResponseSchema } = await import('../evaluation/axes/best-practices.js');

    expect(CorrectionResponseSchema.parse({ symbols: [], actions: [] }).doc_divergences).toBeUndefined();
    expect(OverengineeringResponseSchema.parse({ symbols: [] }).doc_divergences).toBeUndefined();
    expect(TestsResponseSchema.parse({ symbols: [] }).doc_divergences).toBeUndefined();
    expect(BestPracticesResponseSchema.parse({ score: 10, rules: [] }).doc_divergences).toBeUndefined();
  });
});

// AC2: System prompts contain doc_divergence instruction (structural)
describe('Story 54.9 — AC2: System prompts contain doc_divergence instruction', () => {
  const axisPrompts = [
    { axis: 'correction', file: 'src/prompts/axes/correction.system.md' },
    { axis: 'best-practices', file: 'src/prompts/axes/best-practices.system.md' },
    { axis: 'overengineering', file: 'src/prompts/axes/overengineering.system.md' },
    { axis: 'tests', file: 'src/prompts/axes/tests.system.md' },
  ];

  for (const { axis, file } of axisPrompts) {
    it(`${axis} system prompt contains doc_divergence instruction`, () => {
      const content = readFileSync(resolve(__dirname, '../../../', file), 'utf-8');
      expect(content).toContain('doc_divergence');
      expect(content).toContain('reference');
    });
  }
});

// AC3: Divergence aggregation in reporter
describe('Story 54.9 — AC3: Divergence aggregation in report', () => {
  it('renderDivergenceSection exists and renders divergences', async () => {
    const { renderDivergenceSection } = await import('./index.js');
    expect(renderDivergenceSection).toBeDefined();
  });

  it('renderDivergenceSection renders correct markdown structure', async () => {
    const { renderDivergenceSection } = await import('./index.js');
    const divergences = [
      {
        kind: 'doc_divergence' as const,
        severity: 'warn' as const,
        file: 'src/core/foo.ts',
        line: 42,
        symbol: 'processData',
        reference_excerpt: 'processData accepts a Buffer',
        reference_source: 'README.md#processdata',
        observed_behavior: 'processData accepts a string, not a Buffer',
        axis_origin: 'correction' as const,
      },
      {
        kind: 'doc_divergence' as const,
        severity: 'info' as const,
        file: 'src/core/bar.ts',
        reference_excerpt: 'uses factory pattern',
        reference_source: 'docs/arch.md',
        observed_behavior: 'uses direct instantiation',
        axis_origin: 'overengineering' as const,
      },
    ];
    const result = renderDivergenceSection(divergences);
    expect(result).toContain('### Divergences code ↔ reference');
    expect(result).toContain('processData');
    expect(result).toContain('correction');
    expect(result).toContain('README.md#processdata');
    expect(result).toContain('processData accepts a Buffer');
    expect(result).toContain('processData accepts a string, not a Buffer');
    expect(result).toContain('overengineering');
  });

  it('renderDivergenceSection returns empty string when no divergences', async () => {
    const { renderDivergenceSection } = await import('./index.js');
    expect(renderDivergenceSection([])).toBe('');
  });

  it('aggregateDivergences collects doc_divergences from all review files', async () => {
    const { aggregateDivergences } = await import('./index.js');
    const reviews = [
      {
        version: 2 as const,
        file: 'src/a.ts',
        is_generated: false,
        verdict: 'CLEAN' as const,
        symbols: [],
        actions: [],
        file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
        doc_divergences: [{
          kind: 'doc_divergence' as const,
          severity: 'warn' as const,
          file: 'src/a.ts',
          reference_excerpt: 'excerpt a',
          reference_source: 'README.md',
          observed_behavior: 'observed a',
          axis_origin: 'correction' as const,
        }],
      },
      {
        version: 2 as const,
        file: 'src/b.ts',
        is_generated: false,
        verdict: 'CLEAN' as const,
        symbols: [],
        actions: [],
        file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
        doc_divergences: [{
          kind: 'doc_divergence' as const,
          severity: 'info' as const,
          file: 'src/b.ts',
          reference_excerpt: 'excerpt b',
          reference_source: 'docs/api.md',
          observed_behavior: 'observed b',
          axis_origin: 'tests' as const,
        }],
      },
    ];
    const result = aggregateDivergences(reviews);
    expect(result).toHaveLength(2);
    expect(result[0].axis_origin).toBe('correction');
    expect(result[1].axis_origin).toBe('tests');
  });
});

// AC4: Documentation mode in report header
describe('Story 54.9 — AC4: Documentation mode in report header', () => {
  it('renderIndex includes Documentation mode line when docMode provided', async () => {
    const { renderIndex, aggregateReviews, buildAxisReports } = await import('./index.js');
    const data = aggregateReviews([]);
    const axisReports = buildAxisReports(data);
    const result = renderIndex(data, axisReports, undefined, undefined, undefined, undefined, { mode: 'off' });
    expect(result).toContain('Documentation: off');
  });

  it('renderIndex shows lite mode with token count', async () => {
    const { renderIndex, aggregateReviews, buildAxisReports } = await import('./index.js');
    const data = aggregateReviews([]);
    const axisReports = buildAxisReports(data);
    const result = renderIndex(data, axisReports, undefined, undefined, undefined, undefined, { mode: 'lite', digestTokens: 3200 });
    expect(result).toContain('Documentation: lite (digest 3200 tokens)');
  });

  it('renderIndex shows full mode with last coherence date', async () => {
    const { renderIndex, aggregateReviews, buildAxisReports } = await import('./index.js');
    const data = aggregateReviews([]);
    const axisReports = buildAxisReports(data);
    const result = renderIndex(data, axisReports, undefined, undefined, undefined, undefined, { mode: 'full', lastCoherence: '2026-05-10' });
    expect(result).toContain('Documentation: full (last coherence: 2026-05-10)');
  });

  it('renderPublicIndex also includes Documentation mode line', async () => {
    const { renderPublicIndex, aggregateReviews, buildAxisReports } = await import('./index.js');
    const data = aggregateReviews([]);
    const axisReports = buildAxisReports(data);
    const result = renderPublicIndex(data, axisReports, undefined, undefined, undefined, undefined, undefined, { mode: 'off' });
    expect(result).toContain('Documentation: off');
  });
});

// AC4: doc-mode is surfaced in `anatoly runs attach` snapshot view (post-refactor).
describe('Story 54.9 — AC4: anatoly runs attach surfaces doc mode', () => {
  it('attach.ts renders doc mode in terminated-run snapshot', () => {
    const content = readFileSync(resolve(__dirname, '../../commands/attach.ts'), 'utf-8');
    expect(content).toContain('renderDocModeLine');
    expect(content).toContain('resolveDocMode');
  });
});

// AC3 supplemental: divergences don't affect F1 scoring
describe('Story 54.9 — FR17: divergences are non-penalizing', () => {
  it('computeFileVerdict ignores doc_divergences (verdict stays CLEAN)', async () => {
    const { computeFileVerdict } = await import('./index.js');
    const review = {
      version: 2 as const,
      file: 'src/foo.ts',
      is_generated: false,
      verdict: 'CLEAN' as const,
      symbols: [],
      actions: [],
      file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
      doc_divergences: [{
        kind: 'doc_divergence' as const,
        severity: 'warn' as const,
        file: 'src/foo.ts',
        reference_excerpt: 'some excerpt',
        reference_source: 'README.md',
        observed_behavior: 'different behavior',
        axis_origin: 'correction' as const,
      }],
    };
    expect(computeFileVerdict(review as Parameters<typeof computeFileVerdict>[0])).toBe('CLEAN');
  });
});
