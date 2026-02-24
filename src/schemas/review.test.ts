import { describe, it, expect } from 'vitest';
import { ReviewFileSchema, SymbolReviewSchema, ActionSchema } from './review.js';

const validSymbol = {
  name: 'useAuth',
  kind: 'hook' as const,
  exported: true,
  line_start: 10,
  line_end: 45,
  correction: 'OK' as const,
  overengineering: 'LEAN' as const,
  utility: 'DEAD' as const,
  duplication: 'UNIQUE' as const,
  tests: 'NONE' as const,
  confidence: 98,
  detail: 'Exported hook with zero imports across the entire codebase.',
};

const validReview = {
  version: 1 as const,
  file: 'src/hooks/use-auth.ts',
  verdict: 'NEEDS_REFACTOR' as const,
  symbols: [validSymbol],
  actions: [
    {
      id: 1,
      description: 'Remove dead hook useAuth',
      severity: 'medium' as const,
      target_symbol: 'useAuth',
      target_lines: '10-45',
    },
  ],
  file_level: {
    unused_imports: ['react-query'],
    circular_dependencies: [],
    general_notes: '',
  },
};

describe('ReviewFileSchema', () => {
  it('should validate a complete valid review', () => {
    const result = ReviewFileSchema.safeParse(validReview);
    expect(result.success).toBe(true);
  });

  it('should reject invalid verdict', () => {
    const result = ReviewFileSchema.safeParse({ ...validReview, verdict: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('should apply defaults for is_generated and actions', () => {
    const minimal = {
      version: 1,
      file: 'src/index.ts',
      verdict: 'CLEAN',
      symbols: [],
      file_level: {},
    };
    const result = ReviewFileSchema.parse(minimal);
    expect(result.is_generated).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.file_level.unused_imports).toEqual([]);
  });

  it('should require duplicate_target when duplication is DUPLICATE (enforced by convention)', () => {
    const withDuplicate = {
      ...validSymbol,
      duplication: 'DUPLICATE' as const,
      duplicate_target: {
        file: 'src/utils/pricing.ts',
        symbol: 'calculateTotal',
        similarity: '95% identical logic',
      },
    };
    const result = SymbolReviewSchema.safeParse(withDuplicate);
    expect(result.success).toBe(true);
  });

  it('should accept null duplicate_target and normalize to undefined', () => {
    const withNull = { ...validSymbol, duplicate_target: null };
    const result = SymbolReviewSchema.safeParse(withNull);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duplicate_target).toBeUndefined();
    }
  });

  it('should reject confidence outside 0-100 range', () => {
    const result = SymbolReviewSchema.safeParse({ ...validSymbol, confidence: 101 });
    expect(result.success).toBe(false);
  });

  it('should reject detail shorter than 10 chars', () => {
    const result = SymbolReviewSchema.safeParse({ ...validSymbol, detail: 'short' });
    expect(result.success).toBe(false);
  });
});

describe('ActionSchema', () => {
  it('should validate a valid action', () => {
    const result = ActionSchema.safeParse({
      id: 1,
      description: 'Remove dead code',
      severity: 'high',
      target_symbol: 'useAuth',
      target_lines: '10-45',
    });
    expect(result.success).toBe(true);
  });

  it('should allow null target_symbol and target_lines', () => {
    const result = ActionSchema.safeParse({
      id: 1,
      description: 'General cleanup needed',
      severity: 'low',
      target_symbol: null,
      target_lines: null,
    });
    expect(result.success).toBe(true);
  });
});
