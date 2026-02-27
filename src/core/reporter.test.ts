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
  generateReport,
  sortFindingFiles,
  buildShards,
  renderIndex,
  renderShard,
  type TriageStats,
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

describe('renderIndex', () => {
  it('should show "All files clean" when no findings', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).toContain('All files clean');
    expect(md).not.toContain('## Shards');
  });

  it('should include executive summary', () => {
    const data = aggregateReviews([
      makeReview({ file: 'a.ts' }),
      makeReview({ file: 'b.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 90 })] }),
    ]);
    const shards = buildShards(data);
    const md = renderIndex(data, shards);
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
    const shards = buildShards(data);
    const md = renderIndex(data, shards);
    expect(md).toContain('Utility');
    expect(md).toContain('| Category |');
  });

  it('should include checkbox list with shard links', () => {
    const reviews = Array.from({ length: 15 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderIndex(data, shards);
    expect(md).toContain('## Shards');
    expect(md).toContain('- [ ] [report.1.md](./report.1.md)');
    expect(md).toContain('- [ ] [report.2.md](./report.2.md)');
    expect(md).toContain('10 files');
    expect(md).toContain('5 files');
  });

  it('should include CRITICAL/NEEDS_REFACTOR composition in shard description', () => {
    const reviews = [
      makeReview({ file: 'crit.ts', symbols: [makeSymbol({ correction: 'ERROR', confidence: 90 })] }),
      makeReview({ file: 'ref.ts', symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    ];
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderIndex(data, shards);
    expect(md).toContain('1 CRITICAL');
    expect(md).toContain('1 NEEDS_REFACTOR');
  });

  it('should keep index compact (detailed methodology included)', () => {
    const reviews = Array.from({ length: 62 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const md = renderIndex(data, shards);
    const lineCount = md.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(130);
  });

  it('should include error files section', () => {
    const data = aggregateReviews([], ['broken.ts']);
    const md = renderIndex(data, []);
    expect(md).toContain('## Files in Error');
    expect(md).toContain('`broken.ts`');
  });

  it('should include Methodology section with axis pipeline description', () => {
    const data = aggregateReviews([makeReview()]);
    const md = renderIndex(data, []);
    expect(md).toContain('## Methodology');
    expect(md).toContain('6 independent axis evaluators');
    expect(md).toContain('Utility');
    expect(md).toContain('Duplication');
    expect(md).toContain('Correction');
    expect(md).toContain('Overengineering');
    expect(md).toContain('Tests');
    expect(md).toContain('Best Practices');
    expect(md).toContain('haiku');
    expect(md).toContain('sonnet');
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

  it('should keep index compact with triage stats and 62 findings', () => {
    const reviews = Array.from({ length: 62 }, (_, i) =>
      makeReview({ file: `f${i}.ts`, symbols: [makeSymbol({ utility: 'DEAD', confidence: 80 })] }),
    );
    const data = aggregateReviews(reviews);
    const shards = buildShards(data);
    const stats: TriageStats = { total: 100, skip: 30, evaluate: 70, estimatedTimeSaved: 15.0 };
    const md = renderIndex(data, shards, stats);
    const lineCount = md.split('\n').length;
    // Allow a bit more room for the triage section
    expect(lineCount).toBeLessThanOrEqual(140);
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

describe('renderShard', () => {
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
          rules: [{ rule_id: 1, rule_name: 'Error handling', status: 'PASS' as const, severity: 'CRITIQUE' as const }],
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

  it('should write shard files for finding reviews', () => {
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

    const { reportPath } = generateReport(tmpDir);
    const indexContent = readFileSync(reportPath, 'utf-8');
    expect(indexContent).toContain('report.1.md');
    expect(indexContent).toContain('report.2.md');

    const shard1 = readFileSync(join(tmpDir, '.anatoly', 'report.1.md'), 'utf-8');
    expect(shard1).toContain('# Shard 1');
    expect(shard1).toContain('## Findings');

    const shard2 = readFileSync(join(tmpDir, '.anatoly', 'report.2.md'), 'utf-8');
    expect(shard2).toContain('# Shard 2');
  });

  it('should not write shard files when all clean', () => {
    const reviewsDir = join(tmpDir, '.anatoly', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(
      join(reviewsDir, 'clean.rev.json'),
      JSON.stringify(makeReview({ file: 'clean.ts' })),
    );

    generateReport(tmpDir);
    expect(() => readFileSync(join(tmpDir, '.anatoly', 'report.1.md'))).toThrow();
  });

  it('should return report.md path even with shards', () => {
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
    expect(reportPath).not.toContain('report.1.md');
  });
});
