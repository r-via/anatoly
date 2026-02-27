import { describe, it, expect } from 'vitest';
import {
  DeliberationResponseSchema,
  buildDeliberationSystemPrompt,
  buildDeliberationUserMessage,
  needsDeliberation,
  applyDeliberation,
} from './deliberation.js';
import type { DeliberationResponse } from './deliberation.js';
import type { ReviewFile } from '../schemas/review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReview(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    version: 2,
    file: 'src/example.ts',
    is_generated: false,
    verdict: 'CLEAN',
    symbols: [
      {
        name: 'doWork',
        kind: 'function',
        exported: true,
        line_start: 1,
        line_end: 10,
        correction: 'OK',
        overengineering: 'LEAN',
        utility: 'USED',
        duplication: 'UNIQUE',
        tests: 'GOOD',
        confidence: 95,
        detail: 'All good',
      },
    ],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    ...overrides,
  };
}

function makeDeliberationResponse(overrides: Partial<DeliberationResponse> = {}): DeliberationResponse {
  return {
    verdict: 'CLEAN',
    symbols: [
      {
        name: 'doWork',
        original: { correction: 'OK', confidence: 95 },
        deliberated: { correction: 'OK', confidence: 95 },
        reasoning: 'Assessment is correct, no changes needed',
      },
    ],
    removed_actions: [],
    reasoning: 'All findings are consistent and accurate',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('DeliberationResponseSchema', () => {
  it('should validate a correct response', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'foo',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'The pattern is safe in this library version',
        },
      ],
      removed_actions: [1, 3],
      reasoning: 'Overall the code is clean after reclassification',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject response with missing reasoning', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [],
      removed_actions: [],
      reasoning: 'short', // < 10 chars
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject invalid verdict', () => {
    const input = {
      verdict: 'UNKNOWN',
      symbols: [],
      removed_actions: [],
      reasoning: 'Overall assessment is fine',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should default removed_actions to empty array', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [],
      reasoning: 'Overall assessment is fine enough',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.removed_actions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt builder tests
// ---------------------------------------------------------------------------

describe('buildDeliberationSystemPrompt', () => {
  it('should define the judge role', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('Deliberation Judge');
    expect(prompt).toContain('FINAL validation pass');
  });

  it('should forbid adding new findings', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('MUST NOT add new findings');
  });

  it('should require confidence >= 85', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('85');
  });

  it('should protect ERROR findings', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('ERROR → OK');
    expect(prompt).toContain('95');
  });
});

describe('buildDeliberationUserMessage', () => {
  it('should include ReviewFile JSON', () => {
    const review = makeReview();
    const msg = buildDeliberationUserMessage(review, 'const x = 1;');
    expect(msg).toContain('"file": "src/example.ts"');
    expect(msg).toContain('"verdict": "CLEAN"');
  });

  it('should include source code', () => {
    const review = makeReview();
    const msg = buildDeliberationUserMessage(review, 'export function doWork() { return 42; }');
    expect(msg).toContain('export function doWork()');
  });

  it('should include the file name', () => {
    const review = makeReview({ file: 'src/utils/helper.ts' });
    const msg = buildDeliberationUserMessage(review, 'code');
    expect(msg).toContain('src/utils/helper.ts');
  });
});

// ---------------------------------------------------------------------------
// needsDeliberation tests
// ---------------------------------------------------------------------------

describe('needsDeliberation', () => {
  it('should return false for CLEAN with all confidence >= 95', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 95, detail: 'Clean symbol ok' },
        { name: 'b', kind: 'function', exported: true, line_start: 6, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 98, detail: 'Clean symbol ok' },
      ],
    });
    expect(needsDeliberation(review)).toBe(false);
  });

  it('should return true for symbol with NEEDS_FIX', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 80, detail: 'Has a bug here' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with ERROR', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 90, detail: 'Critical error found' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with DEAD utility', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'DEAD', duplication: 'UNIQUE', tests: 'NONE', confidence: 85, detail: 'Dead code found' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with DUPLICATE', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'DUPLICATE', tests: 'GOOD', confidence: 85, detail: 'Duplicated elsewhere' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with OVER overengineering', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'OVER', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 85, detail: 'Over-engineered stuff' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for CLEAN with low confidence (< 70)', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 65, detail: 'Low confidence symbol' },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return false for CLEAN with medium confidence (70-94)', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 80, detail: 'Medium confidence ok' },
      ],
    });
    expect(needsDeliberation(review)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDeliberation tests
// ---------------------------------------------------------------------------

describe('applyDeliberation', () => {
  it('should reclassify NEEDS_FIX to OK', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 72, detail: 'Possible bug here' },
      ],
      actions: [{ id: 1, description: 'Fix the bug', severity: 'high', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L1-L10' }],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'The pattern is safe in this context',
        },
      ],
      removed_actions: [1],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.verdict).toBe('CLEAN');
    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].confidence).toBe(90);
    expect(result.symbols[0].detail).toContain('deliberated: NEEDS_FIX → OK');
    expect(result.actions).toHaveLength(0);
  });

  it('should protect ERROR when Opus confidence < 95', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 90, detail: 'Critical error here' },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'ERROR', confidence: 90 },
          deliberated: { correction: 'OK', confidence: 88 },
          reasoning: 'I think this is actually fine',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    // ERROR should be protected — correction stays ERROR
    expect(result.symbols[0].correction).toBe('ERROR');
    expect(result.symbols[0].detail).toContain('ERROR protected');
    expect(result.symbols[0].detail).toContain('88 < 95');
  });

  it('should allow ERROR downgrade when Opus confidence >= 95', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 90, detail: 'Critical error here' },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'ERROR', confidence: 90 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'After careful analysis this is a false positive',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].confidence).toBe(95);
  });

  it('should remove invalidated actions', () => {
    const review = makeReview({
      actions: [
        { id: 1, description: 'Fix bug A', severity: 'high', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L1-L5' },
        { id: 2, description: 'Fix bug B', severity: 'medium', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L6-L10' },
        { id: 3, description: 'Cleanup', severity: 'low', effort: 'trivial', category: 'hygiene', target_symbol: null, target_lines: null },
      ],
    });

    const deliberation = makeDeliberationResponse({
      removed_actions: [1, 3],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].id).toBe(2);
  });

  it('should enrich detail with confirmed reasoning', () => {
    const review = makeReview();
    const deliberation = makeDeliberationResponse({
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'OK', confidence: 95 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'Assessment is correct, no changes needed',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].detail).toContain('deliberated: confirmed');
    expect(result.symbols[0].detail).toContain('Assessment is correct');
  });

  it('should leave unmentioned symbols unchanged', () => {
    const review = makeReview({
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 95, detail: 'All good stuff' },
        { name: 'helper', kind: 'function', exported: false, line_start: 11, line_end: 20, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', confidence: 90, detail: 'Also fine code' },
      ],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'OK', confidence: 95 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'Assessment is correct for this symbol',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[1].detail).toBe('Also fine code');
    expect(result.symbols[1].confidence).toBe(90);
  });

  it('should apply Opus verdict', () => {
    const review = makeReview({ verdict: 'NEEDS_REFACTOR' });
    const deliberation = makeDeliberationResponse({ verdict: 'CLEAN' });

    const result = applyDeliberation(review, deliberation);
    expect(result.verdict).toBe('CLEAN');
  });
});
