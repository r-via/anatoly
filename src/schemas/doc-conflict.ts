// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Verdicts & statuses — Story 55.3 FR2
// ---------------------------------------------------------------------------

export const DocConflictVerdictSchema = z.enum(['pending', 'doc-wins', 'code-wins', 'skip']);
export type DocConflictVerdict = z.infer<typeof DocConflictVerdictSchema>;

export const DocConflictStatusSchema = z.enum(['active', 'stale-by-codechange', 'applied', 'skipped']);
export type DocConflictStatus = z.infer<typeof DocConflictStatusSchema>;

export const PresumptionSchema = z.enum(['doc-stale', 'code-drift', 'unknown']);
export type Presumption = z.infer<typeof PresumptionSchema>;

// ---------------------------------------------------------------------------
// Anchor — locates the code fragment this conflict is about
// ---------------------------------------------------------------------------

export const CodeAnchorSchema = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  line_range: z.tuple([z.int().min(1), z.int().min(1)]).optional(),
  /** SHA-256 of the normalised code content at the anchor location. */
  code_hash: z.string(),
});

export type CodeAnchor = z.infer<typeof CodeAnchorSchema>;

// ---------------------------------------------------------------------------
// Reference excerpt — the human-doc fragment that diverges
// ---------------------------------------------------------------------------

export const ReferenceExcerptSchema = z.object({
  path: z.string(),
  line_range: z.tuple([z.int().min(1), z.int().min(1)]).optional(),
  text: z.string(),
});

export type ReferenceExcerpt = z.infer<typeof ReferenceExcerptSchema>;

// ---------------------------------------------------------------------------
// Arbitration signals
// ---------------------------------------------------------------------------

export const ArbitrationSignalsSchema = z.object({
  doc_last_touched: z.string(),
  code_last_touched: z.string(),
  test_covers_current_behavior: z.boolean().optional(),
  presumption: PresumptionSchema,
});

export type ArbitrationSignals = z.infer<typeof ArbitrationSignalsSchema>;

// ---------------------------------------------------------------------------
// Single conflict entry — FR2
// ---------------------------------------------------------------------------

export const DocConflictSchema = z.object({
  /** Stable hash-based ID for this conflict. */
  id: z.string(),
  detected_at: z.string(),
  anchor: CodeAnchorSchema,
  reference_excerpt: ReferenceExcerptSchema,
  code_summary: z.string(),
  signals: ArbitrationSignalsSchema,
  verdict: DocConflictVerdictSchema,
  verdict_set_at: z.string().optional(),
  verdict_note: z.string().optional(),
  status: DocConflictStatusSchema,
});

export type DocConflict = z.infer<typeof DocConflictSchema>;

// ---------------------------------------------------------------------------
// Lock file envelope — FR3
// ---------------------------------------------------------------------------

export const DocConflictsLockSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  entries: z.array(DocConflictSchema),
});

export type DocConflictsLock = z.infer<typeof DocConflictsLockSchema>;
