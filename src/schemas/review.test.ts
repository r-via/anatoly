import { describe, it, expect } from 'vitest';
import { ReviewFileSchema, SymbolReviewSchema, ActionSchema, BestPracticesSchema, BestPracticesRuleSchema } from './review.js';

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
  it('should validate a complete valid review (v1)', () => {
    const result = ReviewFileSchema.safeParse(validReview);
    expect(result.success).toBe(true);
  });

  it('should validate a v2 review with best_practices and axis_meta', () => {
    const v2Review = {
      ...validReview,
      version: 2,
      best_practices: {
        score: 8.5,
        rules: [
          { rule_id: 1, rule_name: 'Strict mode', status: 'PASS', severity: 'HAUTE' },
          { rule_id: 2, rule_name: 'No any', status: 'WARN', severity: 'CRITIQUE', detail: 'Found 1 any usage' },
        ],
        suggestions: [{ description: 'Replace any with unknown', before: 'any', after: 'unknown' }],
      },
      axis_meta: {
        utility: { model: 'claude-haiku-4-5-20251001', cost_usd: 0.0001, duration_ms: 1200 },
        correction: { model: 'claude-sonnet-4-6', cost_usd: 0.002, duration_ms: 3500 },
      },
    };
    const result = ReviewFileSchema.safeParse(v2Review);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.best_practices?.score).toBe(8.5);
      expect(result.data.best_practices?.rules).toHaveLength(2);
      expect(result.data.axis_meta?.utility?.model).toBe('claude-haiku-4-5-20251001');
    }
  });

  it('should accept v1 review without best_practices or axis_meta (backward compatible)', () => {
    const result = ReviewFileSchema.safeParse(validReview);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.best_practices).toBeUndefined();
      expect(result.data.axis_meta).toBeUndefined();
    }
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

describe('BestPracticesSchema', () => {
  it('should validate a complete best practices object', () => {
    const bp = {
      score: 7.5,
      rules: [
        { rule_id: 1, rule_name: 'Strict mode', status: 'PASS', severity: 'HAUTE' },
        { rule_id: 2, rule_name: 'No any', status: 'FAIL', severity: 'CRITIQUE', detail: '3 any usages', lines: 'L10-L20' },
      ],
      suggestions: [{ description: 'Use unknown instead of any' }],
    };
    const result = BestPracticesSchema.safeParse(bp);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(2);
      expect(result.data.suggestions).toHaveLength(1);
    }
  });

  it('should default suggestions to empty array', () => {
    const bp = {
      score: 10,
      rules: [{ rule_id: 1, rule_name: 'Strict mode', status: 'PASS', severity: 'HAUTE' }],
    };
    const result = BestPracticesSchema.parse(bp);
    expect(result.suggestions).toEqual([]);
  });

  it('should reject score outside 0-10 range', () => {
    expect(BestPracticesSchema.safeParse({ score: 11, rules: [] }).success).toBe(false);
    expect(BestPracticesSchema.safeParse({ score: -1, rules: [] }).success).toBe(false);
  });
});

describe('BestPracticesRuleSchema', () => {
  it('should validate a valid rule', () => {
    const rule = { rule_id: 13, rule_name: 'Security', status: 'FAIL', severity: 'CRITIQUE', detail: 'Hardcoded secret' };
    expect(BestPracticesRuleSchema.safeParse(rule).success).toBe(true);
  });

  it('should reject rule_id outside 1-17', () => {
    expect(BestPracticesRuleSchema.safeParse({ rule_id: 0, rule_name: 'X', status: 'PASS', severity: 'MOYENNE' }).success).toBe(false);
    expect(BestPracticesRuleSchema.safeParse({ rule_id: 18, rule_name: 'X', status: 'PASS', severity: 'MOYENNE' }).success).toBe(false);
  });

  it('should reject invalid status', () => {
    expect(BestPracticesRuleSchema.safeParse({ rule_id: 1, rule_name: 'X', status: 'INVALID', severity: 'MOYENNE' }).success).toBe(false);
  });

  it('should reject invalid severity', () => {
    expect(BestPracticesRuleSchema.safeParse({ rule_id: 1, rule_name: 'X', status: 'PASS', severity: 'LOW' }).success).toBe(false);
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
