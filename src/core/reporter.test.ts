// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewFile } from '../schemas/review.js';
import {
  loadReviews,
  computeGlobalVerdict,
  computeFileVerdict,
  aggregateReviews,
  generateReport,
  sortFindingFiles,
  buildShards,
  buildAxisReports,
  renderIndex,
  renderShard,
  renderAxisIndex,
  renderAxisShard,
  makeActId,
  hasAxisFinding,
  type TriageStats,
  type ReportAxisId,
} from './reporter.js';

function makeReview(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    version: 1,
    file: 'src/utils/helper.ts',
    is_generated: false,
    verdict: 'CLEAN',
    symbols: [],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    ...overrides,
  };
}

function makeSymbol(overrides: Record<string, unknown> = {}) {
  return {
    name: 'doSomething',
    kind: 'function' as const,
    exported: true,
    line_start: 1,
    line_end: 10,
    correction: 'OK' as const,
    overengineering: 'LEAN' as const,
    utility: 'USED' as const,
    duplication: 'UNIQUE' as const,
    tests: 'GOOD' as const,
    documentation: '-' as const,
    confidence: 85,
    detail: 'This function is well-implemented and tested.',
    duplicate_target: undefined,
    ...overrides,
  };
}

describe('computeFileVerdict', () => {
  it('should return CLEAN for review with no symbols', () => {
    expect(computeFileVerdict(makeReview())).toBe('CLEAN');
  });

  it('should return NEEDS_REFACTOR when only issue is tests: NONE', () => {
    const review = makeReview({
      symbols: [makeSymbol({ tests: 'NONE', confidence: 90 })],
    });
    expect(computeFileVerdict(review)).toBe('NEEDS_REFACTOR');
  });

  it('should return NEEDS_REFACTOR for dead code with confidence >= 60', () => {
    const review = makeReview({
      symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
    });
    expect(computeFileVerdict(review)).toBe('NEEDS_REFACTOR');
  });

  it('should return CLEAN for dead code with confidence < 60', () => {
    const review = makeReview({
      symbols: [makeSymbol({ utility: 'DEAD', confidence: 40 })],
    });
    expect(computeFileVerdict(review)).toBe('CLEAN');
  });

  it('should return CLEAN for ERROR with confidence < 60', () => {
    const review = makeReview({
      symbols: [makeSymbol({ correction: 'ERROR', confidence: 10 })],
    });
    expect(computeFileVerdict(review)).toBe('CLEAN');
  });

  it('should return CRITICAL for ERROR with confidence >= 60', () => {
    const review = makeReview({
      symbols: [makeSymbol({ correction: 'ERROR', confidence: 80 })],
    });
    expect(computeFileVerdict(review)).toBe('CRITICAL');
  });
});

describe('computeGlobalVerdict', () => {
  it('should return CLEAN for empty reviews', () => {
    expect(computeGlobalVerdict([])).toBe('CLEAN');
  });

  it('should return CLEAN when all reviews have no actionable issues', () => {
    const reviews = [makeReview(), makeReview()];
    expect(computeGlobalVerdict(reviews)).toBe('CLEAN');
  });

  it('should return CRITICAL if any review has ERROR symbols', () => {
    const reviews = [
      makeReview(),
      makeReview({ symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
      makeReview({ symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    expect(computeGlobalVerdict(reviews)).toBe('CRITICAL');
  });

  it('should return NEEDS_REFACTOR if worst is actionable issue with confidence >= 60', () => {
    const reviews = [
      makeReview(),
      makeReview({ symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    expect(computeGlobalVerdict(reviews)).toBe('NEEDS_REFACTOR');
  });
});

describe('aggregateReviews', () => {
  it('should count dead code findings by severity', () => {
    const reviews = [
      makeReview({
        verdict: 'NEEDS_REFACTOR',
        symbols: [
          makeSymbol({ utility: 'DEAD', confidence: 90 }),
          makeSymbol({ name: 'lowConf', utility: 'DEAD', confidence: 50 }),
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    expect(data.counts.dead.high).toBe(1);
    expect(data.counts.dead.medium).toBe(1);
  });

  it('should collect actions with file reference', () => {
    const reviews = [
      makeReview({
        file: 'src/foo.ts',
        actions: [
          { id: 1, description: 'Remove dead code', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, target_symbol: 'fn', target_lines: '1-5' },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    expect(data.actions).toHaveLength(1);
    expect(data.actions[0].file).toBe('src/foo.ts');
    expect(data.actions[0].severity).toBe('high');
    expect(data.actions[0].effort).toBe('trivial');
    expect(data.actions[0].category).toBe('quickwin');
  });

  it('should separate clean and finding files based on computeFileVerdict', () => {
    const reviews = [
      makeReview({ file: 'a.ts' }),
      makeReview({ file: 'b.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
      makeReview({ file: 'c.ts', symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
    ];
    const data = aggregateReviews(reviews);
    expect(data.cleanFiles).toHaveLength(1);
    expect(data.findingFiles).toHaveLength(2);
  });

  it('should skip symbols with confidence < 30 from counts', () => {
    const reviews = [
      makeReview({
        verdict: 'NEEDS_REFACTOR',
        symbols: [
          makeSymbol({ utility: 'DEAD', confidence: 90 }),
          makeSymbol({ name: 'veryLowConf', utility: 'DEAD', confidence: 20 }),
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    expect(data.counts.dead.high).toBe(1);
    expect(data.counts.dead.medium).toBe(0); // confidence 20 filtered out
  });

  it('should include error files passed in', () => {
    const data = aggregateReviews([], ['broken.ts', 'timeout.ts']);
    expect(data.errorFiles).toEqual(['broken.ts', 'timeout.ts']);
  });
});

describe('loadReviews', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reporter-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty array when no reviews directory', () => {
    expect(loadReviews(tmpDir)).toEqual([]);
  });

  it('should load valid .rev.json files', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    const review = makeReview({ file: 'test.ts' });
    writeFileSync(join(reviewsDir, 'test.rev.json'), JSON.stringify(review));
    const result = loadReviews(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('test.ts');
  });

  it('should skip malformed files', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, 'bad.rev.json'), 'not json');
    writeFileSync(join(reviewsDir, 'incomplete.rev.json'), JSON.stringify({ version: 1 }));
    expect(loadReviews(tmpDir)).toEqual([]);
  });
});

describe('sortFindingFiles', () => {
  it('should sort CRITICAL before NEEDS_REFACTOR', () => {
    const files = [
      makeReview({ file: 'b.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
    ];
    const sorted = sortFindingFiles(files);
    expect(sorted[0].file).toBe('a.ts');
    expect(sorted[1].file).toBe('b.ts');
  });

  it('should sort by finding count descending within same verdict', () => {
    const files = [
      makeReview({ file: 'one.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
      makeReview({ file: 'two.ts', symbols: [
        makeSymbol({ utility: 'DEAD', confidence: 80 }),
        makeSymbol({ name: 'dup', duplication: 'DUPLICATE', confidence: 80 }),
      ] }),
    ];
    const sorted = sortFindingFiles(files);
    expect(sorted[0].file).toBe('two.ts');
  });

  it('should sort by max confidence descending as tiebreaker', () => {
    const files = [
      makeReview({ file: 'low.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 70 })] }),
      makeReview({ file: 'high.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 95 })] }),
    ];
    const sorted = sortFindingFiles(files);
    expect(sorted[0].file).toBe('high.ts');
  });
});

describe('buildShards', () => {
  it('should return empty array for 0 findings', () => {
    const data = aggregateReviews([makeReview()]);
    expect(buildShards(data)).toEqual([]);
  });

  it('should create a single shard for <= 10 findings', () => {
    const reviews = Array.from({ length: 5 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    expect(shards).toHaveLength(1);
    expect(shards[0].files).toHaveLength(5);
    expect(shards[0].index).toBe(1);
  });

  it('should create multiple shards for > 10 findings', () => {
    const reviews = Array.from({ length: 22 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    expect(shards).toHaveLength(3);
    expect(shards[0].files).toHaveLength(10);
    expect(shards[1].files).toHaveLength(10);
    expect(shards[2].files).toHaveLength(2);
    expect(shards[0].index).toBe(1);
    expect(shards[1].index).toBe(2);
    expect(shards[2].index).toBe(3);
  });

  it('should scope actions to shard files', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [{ id: 1, description: 'Fix a', severity: 'high' as const, effort: 'small' as const, category: 'quickwin' as const, target_symbol: null, target_lines: null }],
      }),
      makeReview({
        file: 'b.ts',
        symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })],
        actions: [{ id: 2, description: 'Fix b', severity: 'high' as const, effort: 'small' as const, category: 'refactor' as const, target_symbol: null, target_lines: null }],
      }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    expect(shards).toHaveLength(1);
    expect(shards[0].actions).toHaveLength(2);
  });

  it('should count CRITICAL and NEEDS_REFACTOR per shard', () => {
    const reviews = [
      makeReview({ file: 'crit.ts', symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
      makeReview({ file: 'ref.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    expect(shards[0].criticalCount).toBe(1);
    expect(shards[0].refactorCount).toBe(1);
  });
});

describe('hasAxisFinding', () => {
  it('should detect correction findings', () => {
    const review = makeReview({ symbols: [makeSymbol({ correction: 'NEEDS_FIX', confidence: 80 })] });
    expect(hasAxisFinding(review, 'correction')).toBe(true);
    expect(hasAxisFinding(review, 'utility')).toBe(false);
  });

  it('should detect utility findings', () => {
    const review = makeReview({ symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] });
    expect(hasAxisFinding(review, 'utility')).toBe(true);
    expect(hasAxisFinding(review, 'correction')).toBe(false);
  });

  it('should detect best-practices findings', () => {
    const review = makeReview({
      best_practices: {
        score: 5,
        rules: [{ rule_id: 1, rule_name: 'No any', status: 'FAIL' as const, severity: 'CRITICAL' as const }],
        suggestions: [],
      },
    });
    expect(hasAxisFinding(review, 'best-practices')).toBe(true);
    expect(hasAxisFinding(review, 'correction')).toBe(false);
  });

  it('should ignore low confidence symbols', () => {
    const review = makeReview({ symbols: [makeSymbol({ utility: 'DEAD', confidence: 20 })] });
    expect(hasAxisFinding(review, 'utility')).toBe(false);
  });
});

describe('buildAxisReports', () => {
  it('should return empty array for all-clean reviews', () => {
    const data = aggregateReviews([makeReview()]);
    expect(buildAxisReports(data)).toEqual([]);
  });

  it('should create reports only for axes with findings', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const axes = reports.map((r) => r.axis);
    expect(axes).toContain('utility');
    expect(axes).not.toContain('correction');
  });

  it('should include a file in multiple axes if it has findings on multiple', () => {
    const reviews = [
      makeReview({
        file: 'multi.ts',
        symbols: [makeSymbol({ utility: 'DEAD', correction: 'NEEDS_FIX', confidence: 80 })],
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const axes = reports.map((r) => r.axis);
    expect(axes).toContain('utility');
    expect(axes).toContain('correction');
  });

  it('should scope actions by axis source', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, source: 'utility' as const, target_symbol: null, target_lines: null },
          { id: 2, description: 'Fix bug', severity: 'high' as const, effort: 'small' as const, category: 'refactor' as const, source: 'correction' as const, target_symbol: null, target_lines: null },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility');
    expect(utilityReport!.actions).toHaveLength(1);
    expect(utilityReport!.actions[0].description).toBe('Remove dead');
  });

  it('should shard files within each axis', () => {
    const reviews = Array.from({ length: 15 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility');
    expect(utilityReport!.shards).toHaveLength(2);
    expect(utilityReport!.shards[0].files).toHaveLength(10);
    expect(utilityReport!.shards[1].files).toHaveLength(5);
  });
});

describe('renderIndex', () => {
  it('should show "All files clean" when no findings', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).toContain('All files clean');
    expect(md).not.toContain('## Axes');
  });

  it('should include executive summary', () => {
    const data = aggregateReviews([
      makeReview({ file: 'a.ts' }),
      makeReview({ file: 'b.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ]);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    expect(md).toContain('# Anatoly Audit Report');
    expect(md).toContain('**Files reviewed:** 2');
    expect(md).toContain('**Global verdict:** NEEDS_REFACTOR');
    expect(md).toContain('**Clean files:** 1');
    expect(md).toContain('**Files with findings:** 1');
  });

  it('should include severity table', () => {
    const data = aggregateReviews([
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ]);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    expect(md).toContain('Utility');
    expect(md).toContain('| Category |');
  });

  it('should include axes navigation table', () => {
    const reviews = Array.from({ length: 15 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    expect(md).toContain('## Axes');
    expect(md).toContain('utility/index.md');
  });

  it('should include CRITICAL/NEEDS_REFACTOR info for axes', () => {
    const reviews = [
      makeReview({ file: 'crit.ts', symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
      makeReview({ file: 'ref.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    expect(md).toContain('correction/index.md');
    expect(md).toContain('utility/index.md');
  });

  it('should contain expected structural sections', () => {
    const reviews = Array.from({ length: 62 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('## Axes');
    expect(md).toContain('## Axis Summary');
    expect(md).toContain('## Methodology');
  });

  it('should include error files section', () => {
    const data = aggregateReviews([], ['broken.ts']);
    const md = renderIndex(data, []);
    expect(md).toContain('## Files in Error');
    expect(md).toContain('`broken.ts`');
  });

  it('should include compact methodology with axis reference table', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).toContain('## Methodology');
    expect(md).toContain('7 independent axis evaluators');
    expect(md).toContain('Utility');
    expect(md).toContain('Duplication');
    expect(md).toContain('Correction');
    expect(md).toContain('Overengineering');
    expect(md).toContain('Tests');
    expect(md).toContain('Documentation');
    expect(md).toContain('Best Practices');
    expect(md).toContain('haiku');
    expect(md).toContain('sonnet');
    expect(md).toContain('See each axis folder for detailed rating criteria');
  });

  it('should include Performance & Triage section when triageStats provided', () => {
    const data = aggregateReviews([makeReview()]);
    const stats: TriageStats = { total: 20, skip: 8, evaluate: 12, estimatedTimeSaved: 8.5 };
    const md = renderIndex(data, [], stats);
    expect(md).toContain('## Performance & Triage');
    expect(md).toContain('| Skip | 8 | 40% |');
    expect(md).toContain('| Evaluate | 12 | 60% |');
    expect(md).toContain('**8.5 min**');
  });

  it('should not include Performance & Triage section when triageStats absent', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).not.toContain('Performance & Triage');
  });

  it('should include triage and axis summary sections with triage stats', () => {
    const reviews = Array.from({ length: 62 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const stats: TriageStats = { total: 100, skip: 30, evaluate: 70, estimatedTimeSaved: 15.0 };
    const md = renderIndex(data, reports, stats);
    expect(md).toContain('## Performance & Triage');
    expect(md).toContain('## Axis Summary');
    expect(md).toContain('## Methodology');
  });
});

describe('degraded reviews', () => {
  it('should detect degraded reviews with crash sentinels', () => {
    const reviews = [
      makeReview({
        file: 'crashed.ts',
        symbols: [makeSymbol({
          confidence: 0,
          detail: '[USED] *(axis crashed — see transcript)* | [OK] *(axis crashed — see transcript)*',
        })],
      }),
      makeReview({ file: 'clean.ts' }),
    ];
    const data = aggregateReviews(reviews);
    expect(data.degradedFiles).toHaveLength(1);
    expect(data.degradedFiles[0].file).toBe('crashed.ts');
  });

  it('should show degraded reviews section in index', () => {
    const reviews = [
      makeReview({
        file: 'crashed.ts',
        symbols: [makeSymbol({
          confidence: 0,
          detail: '[USED] *(axis crashed — see transcript)*',
        })],
      }),
    ];
    const data = aggregateReviews(reviews);
    const md = renderIndex(data, []);
    expect(md).toContain('## Degraded Reviews');
    expect(md).toContain('`crashed.ts`');
    expect(md).toContain('**Degraded reviews (axis crashes):** 1');
  });

  it('should not show degraded section when no crashes', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).not.toContain('Degraded Reviews');
  });
});

describe('renderAxisIndex', () => {
  it('should include axis name and stats', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility')!;
    const md = renderAxisIndex(utilityReport);
    expect(md).toContain('# Utility');
    expect(md).toContain('**Files with findings:** 1');
    expect(md).toContain('## Methodology');
    expect(md).toContain('DEAD');
  });

  it('should include shard links', () => {
    const reviews = Array.from({ length: 15 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility')!;
    const md = renderAxisIndex(utilityReport);
    expect(md).toContain('shard.1.md');
    expect(md).toContain('shard.2.md');
  });

  it('should include best-practices methodology with 17 rules', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        best_practices: {
          score: 5,
          rules: [{ rule_id: 1, rule_name: 'No any', status: 'FAIL' as const, severity: 'CRITICAL' as const }],
          suggestions: [],
        },
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const bpReport = reports.find((r) => r.axis === 'best-practices')!;
    const md = renderAxisIndex(bpReport);
    expect(md).toContain('# Best Practices');
    expect(md).toContain('17 TypeGuard v2 rules');
    expect(md).toContain('Rule');
    expect(md).toContain('Penalty');
  });
});

describe('renderAxisShard', () => {
  it('should render axis-specific findings table', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility')!;
    const md = renderAxisShard('utility', utilityReport.shards[0]);
    expect(md).toContain('# Utility — Shard 1');
    expect(md).toContain('## Findings');
    expect(md).toContain('`a.ts`');
    expect(md).toContain('[details](../reviews/a.rev.md)');
  });

  it('should include actions scoped to axis', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, source: 'utility' as const, target_symbol: 'fn', target_lines: null },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility')!;
    const md = renderAxisShard('utility', utilityReport.shards[0]);
    expect(md).toContain('## Quick Wins');
    expect(md).toContain('Remove dead export');
  });

  it('should render best-practices shard with score and details', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        best_practices: {
          score: 7.5,
          rules: [{ rule_id: 1, rule_name: 'Error handling', status: 'FAIL' as const, severity: 'CRITICAL' as const }],
          suggestions: [{ description: 'Add error handling', before: 'fn()', after: 'try { fn() }' }],
        },
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const bpReport = reports.find((r) => r.axis === 'best-practices')!;
    const md = renderAxisShard('best-practices', bpReport.shards[0]);
    expect(md).toContain('Best Practices — Shard 1');
    expect(md).toContain('7.5/10');
    expect(md).toContain('Failed rules');
    expect(md).toContain('Error handling');
  });
});

describe('renderShard (legacy)', () => {
  it('should include findings table', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    expect(md).toContain('# Shard 1');
    expect(md).toContain('## Findings');
    expect(md).toContain('`a.ts`');
    expect(md).toContain('[details](./reviews/a.rev.md)');
  });

  it('should include actions scoped to shard', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, target_symbol: 'fn', target_lines: null },
          { id: 2, description: 'Add tests', severity: 'low' as const, effort: 'small' as const, category: 'hygiene' as const, target_symbol: null, target_lines: null },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    expect(md).toContain('## Quick Wins');
    expect(md).toContain('## Hygiene');
  });

  it('should include BP Score column with best_practices data', () => {
    const reviews = [
      makeReview({
        file: 'a.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        best_practices: {
          score: 7.5,
          rules: [{ rule_id: 1, rule_name: 'Error handling', status: 'PASS' as const, severity: 'CRITICAL' as const }],
          suggestions: [],
        },
      }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    expect(md).toContain('BP Score');
    expect(md).toContain('7.5/10');
  });

  it('should show dash for BP Score when no best_practices data', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    expect(md).toContain('BP Score');
    expect(md).toContain('| - |');
  });

  it('should not include actions section when no actions', () => {
    const reviews = [
      makeReview({ file: 'a.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    expect(md).not.toContain('## Quick Wins');
    expect(md).not.toContain('## Refactors');
    expect(md).not.toContain('## Hygiene');
  });
});

describe('makeActId', () => {
  it('should produce deterministic IDs', () => {
    const id1 = makeActId('src/foo.ts', 1);
    const id2 = makeActId('src/foo.ts', 1);
    expect(id1).toBe(id2);
  });

  it('should produce different IDs for different files', () => {
    const id1 = makeActId('src/foo.ts', 1);
    const id2 = makeActId('src/bar.ts', 1);
    expect(id1).not.toBe(id2);
  });

  it('should produce different IDs for different action numbers', () => {
    const id1 = makeActId('src/foo.ts', 1);
    const id2 = makeActId('src/foo.ts', 2);
    expect(id1).not.toBe(id2);
  });

  it('should match ACT-{6hex}-{number} format', () => {
    const id = makeActId('src/foo.ts', 42);
    expect(id).toMatch(/^ACT-[a-f0-9]{6}-42$/);
  });
});

describe('renderAction checkboxes', () => {
  it('should prefix actions with checkbox and ACT-ID in shards', () => {
    const reviews = [
      makeReview({
        file: 'src/foo.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, source: 'utility' as const, target_symbol: 'fn', target_lines: '1-5' },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderShard(shards[0]);
    const actId = makeActId('src/foo.ts', 1);
    expect(md).toContain(`- [ ] <!-- ${actId} -->`);
    expect(md).toContain('**[utility \u00B7 high \u00B7 trivial]**');
  });

  it('should have ACT-IDs in axis shards too', () => {
    const reviews = [
      makeReview({
        file: 'src/foo.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, source: 'utility' as const, target_symbol: 'fn', target_lines: '1-5' },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const utilityReport = reports.find((r) => r.axis === 'utility')!;
    const md = renderAxisShard('utility', utilityReport.shards[0]);
    const actId = makeActId('src/foo.ts', 1);
    expect(md).toContain(`- [ ] <!-- ${actId} -->`);
  });
});

describe('renderIndex no Checklist', () => {
  it('should not include ACT-IDs in master index', () => {
    const reviews = [
      makeReview({
        file: 'src/foo.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'small' as const, category: 'quickwin' as const, source: 'utility' as const, target_symbol: 'fn', target_lines: null },
        ],
      }),
    ];
    const data = aggregateReviews(reviews);
    const reports = buildAxisReports(data);
    const md = renderIndex(data, reports);
    const actId = makeActId('src/foo.ts', 1);
    expect(md).not.toContain(`<!-- ${actId} -->`);
  });
});

describe('generateReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reporter-gen-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write report.md index and return data', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(
      join(reviewsDir, 'a.rev.json'),
      JSON.stringify(makeReview({ file: 'a.ts', verdict: 'CLEAN' })),
    );

    const { reportPath, data } = generateReport(tmpDir);
    expect(reportPath).toContain('report.md');
    expect(data.totalFiles).toBe(1);
    expect(data.globalVerdict).toBe('CLEAN');

    const content = readFileSync(reportPath, 'utf-8');
    expect(content).toContain('# Anatoly Audit Report');
    expect(content).toContain('All files clean');
  });

  it('should create axis folders for finding reviews', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });

    for (let i = 0; i < 15; i++) {
      writeFileSync(
        join(reviewsDir, `f${i}.rev.json`),
        JSON.stringify(makeReview({
          file: `f${i}.ts`,
          symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
        })),
      );
    }

    const { reportPath, axisReports } = generateReport(tmpDir);
    const indexContent = readFileSync(reportPath, 'utf-8');
    expect(indexContent).toContain('axes/utility/index.md');

    // Check axis folder exists
    const utilityDir = join(tmpDir, '.anatoly', 'axes', 'utility');
    expect(existsSync(join(utilityDir, 'index.md'))).toBe(true);
    expect(existsSync(join(utilityDir, 'shard.1.md'))).toBe(true);
    expect(existsSync(join(utilityDir, 'shard.2.md'))).toBe(true);

    const utilityIndex = readFileSync(join(utilityDir, 'index.md'), 'utf-8');
    expect(utilityIndex).toContain('# Utility');
    expect(utilityIndex).toContain('shard.1.md');

    const shard1 = readFileSync(join(utilityDir, 'shard.1.md'), 'utf-8');
    expect(shard1).toContain('Utility — Shard 1');
    expect(shard1).toContain('## Findings');

    // Should have utility report
    const utilityReport = axisReports.find((r) => r.axis === 'utility');
    expect(utilityReport).toBeDefined();
    expect(utilityReport!.files).toHaveLength(15);
  });

  it('should not create axis folders when all clean', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(
      join(reviewsDir, 'clean.rev.json'),
      JSON.stringify(makeReview({ file: 'clean.ts' })),
    );

    generateReport(tmpDir);
    expect(existsSync(join(tmpDir, '.anatoly', 'utility'))).toBe(false);
    expect(existsSync(join(tmpDir, '.anatoly', 'correction'))).toBe(false);
  });

  it('should return report.md path even with axis reports', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(
      join(reviewsDir, 'f.rev.json'),
      JSON.stringify(makeReview({
        file: 'f.ts',
        symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })],
      })),
    );

    const { reportPath } = generateReport(tmpDir);
    expect(reportPath.endsWith('report.md')).toBe(true);
  });
});
