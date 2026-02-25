import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeReviewOutput, renderReviewMarkdown, parseDetailSegments } from './review-writer.js';
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
      duplicate_target: undefined,
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

const sampleReviewV2: ReviewFile = {
  version: 2,
  file: 'src/commands/estimate.ts',
  is_generated: false,
  verdict: 'CLEAN',
  symbols: [
    {
      name: 'registerEstimateCommand',
      kind: 'function',
      exported: true,
      line_start: 8,
      line_end: 42,
      correction: 'OK',
      overengineering: 'LEAN',
      utility: 'USED',
      duplication: 'UNIQUE',
      tests: 'NONE',
      confidence: 95,
      detail: '[USED] Exported function imported at runtime by src/commands/index.ts | [UNIQUE] No similar functions found in codebase | [OK] No correctness issues detected | [LEAN] Straightforward CLI command | [NONE] No test file found',
      duplicate_target: undefined,
    },
  ],
  actions: [
    {
      id: 1,
      description: 'Add JSDoc to exported function',
      severity: 'low',
      effort: 'trivial',
      category: 'hygiene',
      target_symbol: 'registerEstimateCommand',
      target_lines: 'L8',
    },
    {
      id: 2,
      description: 'Replace existsSync with async alternative',
      severity: 'low',
      effort: 'small',
      category: 'refactor',
      target_symbol: null,
      target_lines: 'L19-L23',
    },
  ],
  file_level: {
    unused_imports: [],
    circular_dependencies: [],
    general_notes: 'Best practices score: 7.75/10 (1 FAIL, 5 WARN, 11 PASS)',
  },
  best_practices: {
    score: 7.75,
    rules: [
      { rule_id: 2, rule_name: 'No `any`', status: 'WARN', severity: 'CRITIQUE', detail: 'program.opts() returns implicit any' },
      { rule_id: 7, rule_name: 'File size', status: 'PASS', severity: 'HAUTE' },
      { rule_id: 9, rule_name: 'JSDoc on exports', status: 'FAIL', severity: 'MOYENNE', detail: 'registerEstimateCommand has no JSDoc', lines: 'L8' },
      { rule_id: 12, rule_name: 'Async/Error handling', status: 'PASS', severity: 'HAUTE', detail: 'Commander v14 handles async rejections natively' },
    ],
    suggestions: [
      {
        description: 'Use Commander generic opts<T>() to eliminate implicit any',
        before: 'const parentOpts = program.opts();',
        after: 'const parentOpts = program.opts<{ config?: string }>();',
      },
      {
        description: 'Add JSDoc to the exported function',
        before: 'export function registerEstimateCommand(program: Command): void {',
        after: '/** Registers the estimate subcommand. */\nexport function registerEstimateCommand(program: Command): void {',
      },
    ],
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

  it('should render symbols table with Exported column', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('| formatName |');
    expect(md).toContain('| unusedHelper |');
    expect(md).toContain('| Exported |');
    expect(md).toContain('| yes |');
    expect(md).toContain('90%');
  });

  it('should render symbol details with duplicate info', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('Duplicate of');
    expect(md).toContain('src/utils/other.ts:helperFn');
    expect(md).toContain('90% identical');
  });

  it('should render actions grouped by category with effort', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).toContain('### Quick Wins');
    expect(md).toContain('[medium · trivial]');
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
          duplicate_target: undefined,
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

  // --- Best Practices tests ---

  it('should render best practices section with score', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('## Best Practices — 7.75/10');
  });

  it('should render BP rules table with only WARN and FAIL rules', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('### Rules');
    expect(md).toContain('| 2 | No `any` | WARN |');
    expect(md).toContain('| 9 | JSDoc on exports | FAIL |');
    // PASS rules should not appear
    expect(md).not.toContain('| 7 | File size | PASS |');
    expect(md).not.toContain('| 12 | Async/Error handling | PASS |');
  });

  it('should render BP suggestions with before/after', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('### Suggestions');
    expect(md).toContain('Use Commander generic opts<T>()');
    expect(md).toContain('Before: `const parentOpts = program.opts();`');
    expect(md).toContain('After: `const parentOpts = program.opts<{ config?: string }>();`');
  });

  it('should render multi-line suggestions as fenced code blocks', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('Add JSDoc to the exported function');
    expect(md).toContain('```typescript');
    expect(md).toContain('// Before');
    expect(md).toContain('// After');
  });

  it('should not render BP section for v1 reviews without best_practices', () => {
    const md = renderReviewMarkdown(sampleReview);
    expect(md).not.toContain('## Best Practices');
  });

  it('should strip BP summary from general_notes when best_practices section exists', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).not.toContain('Best practices score: 7.75/10');
  });

  // --- Structured detail tests ---

  it('should render structured per-axis detail for pipe-delimited format', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('- **Utility [USED]**:');
    expect(md).toContain('- **Duplication [UNIQUE]**:');
    expect(md).toContain('- **Correction [OK]**:');
    expect(md).toContain('- **Overengineering [LEAN]**:');
    expect(md).toContain('- **Tests [NONE]**:');
  });

  it('should fallback to raw detail when not in pipe-delimited format', () => {
    const md = renderReviewMarkdown(sampleReview);
    // v1 detail is plain text, should be rendered as-is
    expect(md).toContain('Well-structured function with clear naming.');
    expect(md).toContain('This function is not imported anywhere');
  });

  it('should show defaulted axes when some evaluators did not produce results', () => {
    const partial: ReviewFile = {
      ...sampleReviewV2,
      symbols: [{
        ...sampleReviewV2.symbols[0],
        // Only 3 axes in detail — correction and tests missing
        detail: '[USED] Exported function | [UNIQUE] No duplicates | [LEAN] Straightforward',
      }],
    };
    const md = renderReviewMarkdown(partial);
    expect(md).toContain('- **Utility [USED]**: Exported function');
    expect(md).toContain('- **Correction [OK]**: *(default — evaluator did not produce a result)*');
    expect(md).toContain('- **Tests [NONE]**: *(default — evaluator did not produce a result)*');
    // These axes ran, should NOT have default marker
    expect(md).not.toContain('- **Duplication [UNIQUE]**: *(default');
    expect(md).not.toContain('- **Overengineering [LEAN]**: *(default');
  });

  // --- Actions category tests ---

  it('should render actions in multiple categories', () => {
    const md = renderReviewMarkdown(sampleReviewV2);
    expect(md).toContain('### Hygiene');
    expect(md).toContain('[low · trivial]');
    expect(md).toContain('### Refactors');
    expect(md).toContain('[low · small]');
  });
});

describe('parseDetailSegments', () => {
  it('should parse pipe-delimited detail into segments', () => {
    const detail = '[USED] Function is imported by 3 files | [UNIQUE] No duplicates | [OK] No bugs';
    const segments = parseDetailSegments(detail);
    expect(segments).toHaveLength(3);
    expect(segments![0]).toEqual({ value: 'USED', explanation: 'Function is imported by 3 files' });
    expect(segments![1]).toEqual({ value: 'UNIQUE', explanation: 'No duplicates' });
    expect(segments![2]).toEqual({ value: 'OK', explanation: 'No bugs' });
  });

  it('should return null for non-pipe-delimited text', () => {
    const result = parseDetailSegments('Just a plain text detail.');
    expect(result).toBeNull();
  });

  it('should handle all 5 axes', () => {
    const detail = '[USED] Used | [UNIQUE] Unique | [OK] OK | [LEAN] Lean | [GOOD] Good tests';
    const segments = parseDetailSegments(detail);
    expect(segments).toHaveLength(5);
  });
});
