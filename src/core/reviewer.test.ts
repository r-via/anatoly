import { describe, it, expect } from 'vitest';
import { parseReviewResponse, tryParseReview, formatRetryFeedback } from './reviewer.js';

const validReview = {
  version: 1,
  file: 'src/utils/format.ts',
  is_generated: false,
  verdict: 'CLEAN',
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
      detail: 'Well-structured function with clear naming and proper type annotations.',
    },
  ],
  actions: [],
  file_level: {
    unused_imports: [],
    circular_dependencies: [],
    general_notes: '',
  },
};

describe('parseReviewResponse', () => {
  it('should parse valid JSON response', () => {
    const result = parseReviewResponse(JSON.stringify(validReview), 'src/utils/format.ts');
    expect(result.verdict).toBe('CLEAN');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('formatName');
  });

  it('should extract JSON from markdown code fences', () => {
    const response = `Here's the review:\n\n\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\`\n\nDone.`;
    const result = parseReviewResponse(response, 'src/utils/format.ts');
    expect(result.verdict).toBe('CLEAN');
  });

  it('should extract JSON from surrounding text', () => {
    const response = `Analysis complete. ${JSON.stringify(validReview)} End of review.`;
    const result = parseReviewResponse(response, 'src/utils/format.ts');
    expect(result.verdict).toBe('CLEAN');
  });

  it('should throw for empty response', () => {
    expect(() => parseReviewResponse('', 'test.ts')).toThrow('No valid JSON');
  });

  it('should throw for invalid JSON', () => {
    expect(() => parseReviewResponse('{invalid json}', 'test.ts')).toThrow('Invalid JSON');
  });

  it('should throw for JSON that fails Zod validation', () => {
    const invalid = { version: 1, file: 'test.ts' }; // Missing required fields
    expect(() =>
      parseReviewResponse(JSON.stringify(invalid), 'test.ts'),
    ).toThrow('Zod validation failed');
  });

  it('should validate all 5 axes on symbols', () => {
    const review = {
      ...validReview,
      symbols: [
        {
          ...validReview.symbols[0],
          correction: 'NEEDS_FIX',
          overengineering: 'OVER',
          utility: 'DEAD',
          duplication: 'DUPLICATE',
          tests: 'NONE',
          duplicate_target: {
            file: 'src/other.ts',
            symbol: 'otherFn',
            similarity: '95% identical',
          },
        },
      ],
      verdict: 'NEEDS_REFACTOR',
    };
    const result = parseReviewResponse(JSON.stringify(review), 'test.ts');
    expect(result.symbols[0].correction).toBe('NEEDS_FIX');
    expect(result.symbols[0].duplicate_target?.file).toBe('src/other.ts');
  });
});

describe('tryParseReview', () => {
  it('should return success for valid response', () => {
    const result = tryParseReview(JSON.stringify(validReview), 'test.ts');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe('CLEAN');
    }
  });

  it('should return error for no JSON', () => {
    const result = tryParseReview('no json here', 'test.ts');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No valid JSON');
    }
  });

  it('should return error for invalid JSON syntax', () => {
    const result = tryParseReview('{not: valid: json}', 'test.ts');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON syntax');
    }
  });

  it('should return formatted Zod errors for schema violations', () => {
    const incomplete = { version: 1, file: 'test.ts', verdict: 'CLEAN' };
    const result = tryParseReview(JSON.stringify(incomplete), 'test.ts');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('symbols');
    }
  });
});

describe('formatRetryFeedback', () => {
  it('should include the validation error', () => {
    const feedback = formatRetryFeedback('symbols: Required', 1, 3);
    expect(feedback).toContain('symbols: Required');
  });

  it('should include the attempt number', () => {
    const feedback = formatRetryFeedback('error', 2, 3);
    expect(feedback).toContain('attempt 2/3');
  });

  it('should include instructions for fixing', () => {
    const feedback = formatRetryFeedback('error', 1, 3);
    expect(feedback).toContain('fix these issues');
    expect(feedback).toContain('ONLY the JSON');
  });
});
