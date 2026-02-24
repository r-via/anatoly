import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewFile } from '../schemas/review.js';
import {
  loadReviews,
  computeGlobalVerdict,
  computeFileVerdict,
  aggregateReviews,
  renderReport,
  generateReport,
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

  it('should return CLEAN when only issue is tests: NONE', () => {
    const review = makeReview({
      symbols: [makeSymbol({ tests: 'NONE', confidence: 90 })],
    });
    expect(computeFileVerdict(review)).toBe('CLEAN');
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

  it('should return CRITICAL for any ERROR regardless of confidence', () => {
    const review = makeReview({
      symbols: [makeSymbol({ correction: 'ERROR', confidence: 10 })],
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

describe('renderReport', () => {
  it('should render a report with executive summary', () => {
    const data = aggregateReviews([
      makeReview({ file: 'a.ts', verdict: 'CLEAN' }),
      makeReview({ file: 'b.ts', verdict: 'NEEDS_REFACTOR', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ]);
    const md = renderReport(data);
    expect(md).toContain('# Anatoly Audit Report');
    expect(md).toContain('**Files reviewed:** 2');
    expect(md).toContain('**Global verdict:** NEEDS_REFACTOR');
    expect(md).toContain('Dead code');
  });

  it('should render findings table with links', () => {
    const data = aggregateReviews([
      makeReview({
        file: 'src/core/foo.ts',
        verdict: 'CRITICAL',
        symbols: [makeSymbol({ correction: 'ERROR', confidence: 95 })],
      }),
    ]);
    const md = renderReport(data);
    expect(md).toContain('## Findings');
    expect(md).toContain('`src/core/foo.ts`');
    expect(md).toContain('[details](./reviews/src-core-foo.rev.md)');
  });

  it('should render clean files section', () => {
    const data = aggregateReviews([makeReview({ file: 'clean.ts', verdict: 'CLEAN' })]);
    const md = renderReport(data);
    expect(md).toContain('## Clean Files');
    expect(md).toContain('`clean.ts`');
  });

  it('should render error files section', () => {
    const data = aggregateReviews([], ['broken.ts']);
    const md = renderReport(data);
    expect(md).toContain('## Files in Error');
    expect(md).toContain('`broken.ts`');
  });

  it('should render actions by category', () => {
    const data = aggregateReviews([
      makeReview({
        file: 'a.ts',
        actions: [
          { id: 1, description: 'Remove dead export', severity: 'high' as const, effort: 'trivial' as const, category: 'quickwin' as const, target_symbol: 'fn', target_lines: null },
          { id: 2, description: 'Add unit tests', severity: 'low' as const, effort: 'small' as const, category: 'hygiene' as const, target_symbol: null, target_lines: null },
        ],
      }),
    ]);
    const md = renderReport(data);
    expect(md).toContain('## Quick Wins');
    expect(md).toContain('**[high · trivial]**');
    expect(md).toContain('## Hygiene');
    expect(md).toContain('**[low · small]**');
    expect(md).not.toContain('## Recommended Actions');
  });

  it('should include metadata section', () => {
    const data = aggregateReviews([]);
    const md = renderReport(data);
    expect(md).toContain('## Metadata');
    expect(md).toContain('**Generated:**');
    expect(md).toContain('**Version:** 1');
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

describe('generateReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reporter-gen-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write report.md and return data', () => {
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
  });
});
