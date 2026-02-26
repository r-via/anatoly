import { z } from 'zod';

export const VerdictSchema = z.enum(['CLEAN', 'NEEDS_REFACTOR', 'CRITICAL']);

export const SeveritySchema = z.enum(['high', 'medium', 'low']);

export const DuplicateTargetSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  similarity: z.string(),
});

export const SymbolReviewSchema = z.object({
  name: z.string(),
  kind: z.enum(['function', 'class', 'method', 'type', 'constant', 'variable', 'enum', 'hook']),
  exported: z.boolean(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),

  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  overengineering: z.enum(['LEAN', 'OVER', 'ACCEPTABLE']),
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE']),
  duplication: z.enum(['UNIQUE', 'DUPLICATE']),
  tests: z.enum(['GOOD', 'WEAK', 'NONE']),

  confidence: z.int().min(0).max(100),

  detail: z.string().min(10),
  duplicate_target: DuplicateTargetSchema.nullable()
    .optional()
    .transform((v) => v ?? undefined),
});

export const EffortSchema = z.enum(['trivial', 'small', 'large']);
export const CategorySchema = z.enum(['quickwin', 'refactor', 'hygiene']);

export const AxisIdSchema = z.enum([
  'utility',
  'duplication',
  'correction',
  'overengineering',
  'tests',
  'best_practices',
]);

export const ActionSchema = z.object({
  id: z.int().min(1),
  description: z.string().min(1),
  severity: SeveritySchema,
  effort: EffortSchema.default('small'),
  category: CategorySchema.default('refactor'),
  source: AxisIdSchema.optional(),
  target_symbol: z.string().nullable(),
  target_lines: z.string().nullable(),
});

export const FileLevelSchema = z.object({
  unused_imports: z.array(z.string()).default([]),
  circular_dependencies: z.array(z.string()).default([]),
  general_notes: z.string().default(''),
});

// ---------------------------------------------------------------------------
// Best Practices (new axis, v2)
// ---------------------------------------------------------------------------

export const BestPracticesRuleSeveritySchema = z.enum(['CRITIQUE', 'HAUTE', 'MOYENNE']);

export const BestPracticesRuleStatusSchema = z.enum(['PASS', 'WARN', 'FAIL']);

export const BestPracticesRuleSchema = z.object({
  rule_id: z.int().min(1).max(17),
  rule_name: z.string().min(1),
  status: BestPracticesRuleStatusSchema,
  severity: BestPracticesRuleSeveritySchema,
  detail: z.string().optional(),
  lines: z.string().optional(),
});

export const BestPracticesSuggestionSchema = z.object({
  description: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
});

export const BestPracticesSchema = z.object({
  score: z.number().min(0).max(10),
  rules: z.array(BestPracticesRuleSchema),
  suggestions: z.array(BestPracticesSuggestionSchema).default([]),
});

// ---------------------------------------------------------------------------
// Axis metadata (v2)
// ---------------------------------------------------------------------------

export const AxisMetaEntrySchema = z.object({
  model: z.string(),
  cost_usd: z.number().min(0),
  duration_ms: z.number().min(0),
});

// ---------------------------------------------------------------------------
// ReviewFile — accepts version 1 or 2 for backward compatibility
// ---------------------------------------------------------------------------

export const ReviewFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  file: z.string(),
  is_generated: z.boolean().default(false),
  skip_reason: z.string().optional(),

  verdict: VerdictSchema,
  symbols: z.array(SymbolReviewSchema),
  actions: z.array(ActionSchema).default([]),

  file_level: FileLevelSchema,

  /** Best practices evaluation (v2 only) */
  best_practices: BestPracticesSchema.optional(),

  /** Per-axis evaluation metadata (v2 only) — partial record, only axes that ran */
  axis_meta: z.record(AxisIdSchema, AxisMetaEntrySchema.optional()).optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type DuplicateTarget = z.infer<typeof DuplicateTargetSchema>;
export type SymbolReview = z.infer<typeof SymbolReviewSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type FileLevel = z.infer<typeof FileLevelSchema>;
export type BestPracticesRule = z.infer<typeof BestPracticesRuleSchema>;
export type BestPracticesSuggestion = z.infer<typeof BestPracticesSuggestionSchema>;
export type BestPractices = z.infer<typeof BestPracticesSchema>;
export type AxisMetaEntry = z.infer<typeof AxisMetaEntrySchema>;
export type ReviewFile = z.infer<typeof ReviewFileSchema>;
