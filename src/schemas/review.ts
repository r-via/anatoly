// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

export const VerdictSchema = z.enum(['CLEAN', 'NEEDS_REFACTOR', 'CRITICAL']);

export const SeveritySchema = z.enum(['high', 'medium', 'low']);

export const DuplicateTargetSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  similarity: z.string(),
});

/**
 * One distinct defect on a symbol, addressed at a specific line range.
 *
 * Symbols that carry several independent defects (e.g. a function with
 * both a wrong-sign multiplier and a Math.ceil-rounding bug) populate
 * the `findings` array on `SymbolReviewSchema` with one entry per
 * defect. Single-defect symbols leave `findings` empty and rely on the
 * top-level `detail` string.
 *
 * Findings are currently emitted only by the `correction` axis; other
 * axes may opt in later.
 */
export const SymbolFindingSchema = z.object({
  axis: z.enum(['correction', 'overengineering', 'utility', 'duplication', 'tests', 'documentation', 'best_practices']).default('correction'),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  detail: z.string().min(10),
});

/**
 * Zod schema for a single symbol-level review entry.
 *
 * Each axis field (correction, overengineering, utility, duplication, tests,
 * documentation) uses `'-'` as a sentinel value meaning "not evaluated" --
 * the axis was skipped or not applicable for this symbol.
 */
export const SymbolReviewSchema = z.object({
  name: z.string(),
  kind: z.enum(['function', 'class', 'method', 'type', 'constant', 'variable', 'enum', 'hook']),
  exported: z.boolean(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),

  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR', '-']),
  overengineering: z.enum(['LEAN', 'OVER', 'ACCEPTABLE', '-']),
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE', '-']),
  duplication: z.enum(['UNIQUE', 'DUPLICATE', '-']),
  tests: z.enum(['GOOD', 'WEAK', 'NONE', '-']),
  documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED', '-']).default('-'),

  confidence: z.int().min(0).max(100),

  detail: z.string().min(10),
  duplicate_target: DuplicateTargetSchema.nullable()
    .optional()
    .transform((v) => v ?? undefined),
  // When a symbol carries multiple independent defects (typically on
  // the correction axis), each defect is recorded here with its own
  // line range and detail. Empty / absent means "single defect, see
  // top-level detail" — fully backward-compatible.
  findings: z.array(SymbolFindingSchema).optional(),
}).transform((sym) => {
  // Invariant: duplicate_target populated ⇒ duplication = DUPLICATE.
  // A populated target without the matching verdict is an incoherent state;
  // promote the verdict to preserve the downstream evidence.
  if (sym.duplicate_target && sym.duplication !== 'DUPLICATE' && sym.duplication !== '-') {
    return { ...sym, duplication: 'DUPLICATE' as const };
  }
  return sym;
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
  'documentation',
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

export const BestPracticesRuleSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM']);

/** Lenient severity: coerce unknown values (e.g. "LOW", "INFO") to "MEDIUM". */
const LenientSeveritySchema = z.string().transform((v) => {
  const upper = v.toUpperCase();
  if (upper === 'CRITICAL' || upper === 'HIGH' || upper === 'MEDIUM') return upper as 'CRITICAL' | 'HIGH' | 'MEDIUM';
  return 'MEDIUM' as const;
});

export const BestPracticesRuleStatusSchema = z.enum(['PASS', 'WARN', 'FAIL']);

/**
 * Zod schema for a single best-practices rule evaluation.
 *
 * `rule_id` is clamped to 1..17, matching the total number of rules in
 * the best-practices checklist. Values outside the range are clamped rather
 * than rejected, to tolerate models that invent extra rule IDs.
 */
export const BestPracticesRuleSchema = z.object({
  rule_id: z.number().int().transform((v) => Math.max(1, Math.min(17, v))),
  rule_name: z.string().min(1),
  status: BestPracticesRuleStatusSchema,
  severity: LenientSeveritySchema,
  detail: z.string().optional(),
  lines: z.string().nullable().transform((v) => v ?? undefined).optional(),
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
// Documentation recommendations (Epic 29)
// ---------------------------------------------------------------------------

export const DocRecommendationTypeSchema = z.enum([
  'missing_page',
  'missing_section',
  'outdated_content',
  'empty_page',
  'broken_link',
  'missing_index_entry',
  'missing_jsdoc',
  'incomplete_jsdoc',
]);

/**
 * Zod schema for a documentation recommendation (Epic 29).
 *
 * - `path_ideal` — canonical documentation path where the content should live.
 * - `path_user` — actual file path in the user's project (may differ from ideal).
 * - `content_ref` — reference to the source-code symbol or concept this recommendation covers.
 */
export const DocRecommendationSchema = z.object({
  type: DocRecommendationTypeSchema,
  path_ideal: z.string(),
  path_user: z.string(),
  content_ref: z.string(),
  rationale: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  section: z.string().optional(),
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

/**
 * Zod schema for a complete per-file review output.
 *
 * Accepts both version 1 and version 2 payloads for backward compatibility.
 * Version 2 adds optional fields: `best_practices`, `docs_coverage`,
 * `doc_recommendations`, `axis_meta`, and `deliberation`.
 */
export const ReviewFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  file: z.string(),
  is_generated: z.boolean().default(false),
  skip_reason: z.string().optional(),

  /** Detected programming language (e.g. 'bash', 'python', 'rust') — Story 31.20 */
  language: z.string().optional(),
  /** Parse method used for symbol extraction: 'ast' or 'heuristic' — Story 31.20 */
  parse_method: z.enum(['ast', 'heuristic']).optional(),

  verdict: VerdictSchema,
  symbols: z.array(SymbolReviewSchema),
  actions: z.array(ActionSchema).default([]),

  file_level: FileLevelSchema,

  /** Best practices evaluation (v2 only) */
  best_practices: BestPracticesSchema.optional(),

  /** Documentation concept coverage (v2 only) */
  docs_coverage: z.object({
    concepts: z.array(z.object({
      name: z.string(),
      status: z.enum(['COVERED', 'PARTIAL', 'MISSING', 'OUTDATED']),
      doc_path: z.string().nullable(),
      detail: z.string(),
    })),
    score_pct: z.number().min(0).max(100),
  }).optional(),

  /** Documentation recommendations with dual paths (Epic 29) */
  doc_recommendations: z.array(DocRecommendationSchema).optional(),

  /** Per-axis evaluation metadata (v2 only) — partial record, only axes that ran */
  axis_meta: z.record(AxisIdSchema, AxisMetaEntrySchema.optional()).optional(),

  /** Deliberation pass summary (when Opus deliberation ran for this file) */
  deliberation: z.object({
    verdict_before: VerdictSchema,
    verdict_after: VerdictSchema,
    reclassified: z.int().min(0),
    actions_removed: z.int().min(0),
    reasoning: z.string(),
  }).optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type DuplicateTarget = z.infer<typeof DuplicateTargetSchema>;
export type SymbolFinding = z.infer<typeof SymbolFindingSchema>;
export type SymbolReview = z.infer<typeof SymbolReviewSchema>;

/**
 * Enforces the invariant: `duplicate_target` populated ⇒ `duplication === 'DUPLICATE'`.
 *
 * A populated target without the matching verdict is an incoherent state that
 * downstream consumers (scorer, TUI, bench) should never have to disambiguate.
 * We promote the verdict rather than clearing the target: the evidence (similarity,
 * matched file/symbol) came from deeper analysis (deliberation / cross-file pass)
 * than the auto-resolve that set the verdict, so it should win.
 */
export function enforceDuplicationInvariant<
  T extends { duplication: 'UNIQUE' | 'DUPLICATE' | '-'; duplicate_target?: DuplicateTarget | undefined },
>(sym: T): T {
  if (sym.duplicate_target && sym.duplication !== 'DUPLICATE' && sym.duplication !== '-') {
    return { ...sym, duplication: 'DUPLICATE' };
  }
  return sym;
}
export type Action = z.infer<typeof ActionSchema>;
export type FileLevel = z.infer<typeof FileLevelSchema>;
export type BestPracticesRule = z.infer<typeof BestPracticesRuleSchema>;
export type BestPracticesSuggestion = z.infer<typeof BestPracticesSuggestionSchema>;
export type BestPractices = z.infer<typeof BestPracticesSchema>;
export type AxisMetaEntry = z.infer<typeof AxisMetaEntrySchema>;
export type ReviewFile = z.infer<typeof ReviewFileSchema>;
export type DocsCoverage = NonNullable<ReviewFile['docs_coverage']>;
export type DocRecommendation = z.infer<typeof DocRecommendationSchema>;
