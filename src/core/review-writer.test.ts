import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeReviewOutput, renderReviewMarkdown } from './review-writer.js';
import type { ReviewFile } from '../schemas/review.js';

const sampleReview: ReviewFile = {
  version: 1,
  file: 'src/utils/format.ts',
  is_generated: false,
  verdict: 'NEEDS_REFACTOR',
  symbols: [
    {
      name: 'formatName',
      kind: 'function',
      exported: true,
      line_start: 1,
      line_end: 5,
      correction: 'OK',
      overengineering: 'LEAN',
      utility: 'USED',
      duplication: 'UNIQUE',
      tests: 'GOOD',
      confidence: 90,
      detail: 'Well-structured function with clear naming.',
    },
    {
      name: 'unusedHelper',
      kind: 'function',
      exported: true,
      line_start: 7,
      line_end: 12,
      correction: 'OK',
      overengineering: 'LEAN',
      utility: 'DEAD',
      duplication: 'DUPLICATE',
      tests: 'NONE',
      confidence: 85,
      detail: 'This function is not imported anywhere in the codebase.',
      duplicate_target: {
        file: 'src/utils/other.ts',
        symbol: 'helperFn',
        similarity: '90% identical logic',
      },
    },
  ],
  actions: [
    {
      id: 1,
      description: 'Remove dead code unusedHelper',
      severity: 'medium',
      effort: 'trivial',
      category: 'quickwin',
      target_symbol: 'unusedHelper',
      target_lines: 'L7-L12',
    },
  ],
  file_level: {
    unused_imports: ['lodash'],
    circular_dependencies: [],
    general_notes: 'Consider consolidating utility functions.',
  },
};

describe('writeReviewOutput', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-rw-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write both .rev.json and .rev.md files', () => {
    const { jsonPath, mdPath } = writeReviewOutput(tempDir, sampleReview);

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    expect(jsonPath).toContain('src-utils-format.rev.json');
    expect(mdPath).toContain('src-utils-format.rev.md');
  });

  it('should write valid JSON matching the review', () => {
    const { jsonPath } = writeReviewOutput(tempDir, sampleReview);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(parsed.file).toBe('src/utils/format.ts');
    expect(parsed.verdict).toBe('NEEDS_REFACTOR');
    expect(parsed.symbols).toHaveLength(2);
  });

  it('should write readable Markdown', () => {
    const { mdPath } = writeReviewOutput(tempDir, sampleReview);
    const md = readFileSync(mdPath, 'utf-8');
    expect(md).toContain('# Review: `src/utils/format.ts`');
    expect(md).toContain('NEEDS_REFACTOR');
    expect(md).toContain('formatName');
    expect(md).toContain('unusedHelper');
  });
});

describe('renderReviewMarkdown', () => {
  it('should include verdict and file path', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('`src/utils/format.ts`');
    expect(md).toContain('NEEDS_REFACTOR');
  });

  it('should render symbols table', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('| formatName |');
    expect(md).toContain('| unusedHelper |');
    expect(md).toContain('90%');
  });

  it('should render symbol details with duplicate info', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('Duplicate of');
    expect(md).toContain('src/utils/other.ts:helperFn');
    expect(md).toContain('90% identical');
  });

  it('should render actions', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('[medium]');
    expect(md).toContain('Remove dead code');
  });

  it('should render file-level notes', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('Unused imports');
    expect(md).toContain('lodash');
    expect(md).toContain('consolidating utility');
  });

  it('should handle clean review with no actions', () => {
    const clean: ReviewFile = {
      version: 1,
      file: 'src/clean.ts',
      is_generated: false,
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'main',
          kind: 'function',
          exported: true,
          line_start: 1,
          line_end: 3,
          correction: 'OK',
          overengineering: 'LEAN',
          utility: 'USED',
          duplication: 'UNIQUE',
          tests: 'GOOD',
          confidence: 95,
          detail: 'Clean function with proper tests.',
        },
      ],
      actions: [],
      file_level: {
        unused_imports: [],
        circular_dependencies: [],
        general_notes: '',
      },
    };
    const md = renderReviewMarkdown(clean);
    expect(md).toContain('CLEAN');
    expect(md).not.toContain('## Actions');
    expect(md).not.toContain('File-Level Notes');
  });
});
