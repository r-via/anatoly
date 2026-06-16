// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

/**
 * Zod enum schema classifying a function's runtime behaviour for the RAG
 * index.  Values: `pure` (no side effects, deterministic), `sideEffectful`
 * (I/O or external mutations), `async` (returns a promise), `memoized`
 * (caches results), `stateful` (maintains internal state across calls),
 * `utility` (generic helper without domain logic).
 */
export const BehavioralProfileSchema = z.enum([
  'pure',
  'sideEffectful',
  'async',
  'memoized',
  'stateful',
  'utility',
]);

/**
 * Zod object schema defining the canonical shape of a function card stored
 * in the RAG index.  Each card captures a function's identity, signature,
 * and analysis metadata.  Notable constraints: `summary` and `docSummary`
 * are capped at 400 characters; `complexityScore` is an integer from 1 to 5;
 * `lastIndexed` must be an ISO-8601 datetime string.  `summary` is the
 * LLM-generated behavioural summary while `docSummary` is extracted from
 * existing JSDoc or inline documentation.
 */
export const FunctionCardSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  name: z.string(),
  signature: z.string(),
  summary: z.string().max(400).optional(),
  docSummary: z.string().max(400).optional(),
  keyConcepts: z.array(z.string()).optional(),
  behavioralProfile: BehavioralProfileSchema.optional(),
  complexityScore: z.number().int().min(1).max(5),
  calledInternals: z.array(z.string()),
  /**
   * Names of project symbols this function imports AND references in its body
   * (the cross-file reference edge, captured at index time). Unlike
   * `calledInternals` (same-file calls only), this records dependencies on OTHER
   * files. Name-only — file-level resolution is supplied by the usage graph at
   * query time; inverting this field yields the precise consumer functions of
   * any exported symbol. Defaults to [] for cards indexed before this field
   * existed (graceful pre-rebuild degradation).
   */
  referencedImports: z.array(z.string()).default([]),
  /**
   * Card category. `function` (default) is the LLM-summarized callable unit
   * (function/method/hook). `declaration` is a non-callable top-level symbol
   * (const/variable/type/enum) indexed so data-only files (no functions) still
   * get an NLP vector for per-file reference-doc routing. Declaration cards
   * carry an AST-synthesized summary (no LLM call) and are excluded from
   * code-similarity / duplication / gap detection — they participate only in
   * the per-file average NLP vector used to retrieve reference docs. Absent is
   * treated as `function` (graceful degradation for cards built before this
   * field existed).
   */
  kind: z.enum(['function', 'declaration']).optional(),
  lastIndexed: z.string().datetime(),
});

export type FunctionCard = z.infer<typeof FunctionCardSchema>;

/** Result from a similarity search. */
export interface SimilarityResult {
  card: FunctionCard;
  score: number;
}

/** RAG index stats for status display. */
export interface RagStats {
  totalCards: number;
  totalFiles: number;
  lastIndexed: string | null;
  /** Actual code vector dimension stored in the table. */
  codeDim?: number;
  /** Actual NLP vector dimension stored in the table. */
  nlpDim?: number;
  /** Number of doc_section rows in the index. */
  docSections: number;
  /** Number of function cards that have a non-empty summary. */
  cardsWithSummary: number;
}

/**
 * Where a doc section was indexed from:
 * - `'internal'`: `.anatoly/state/internal-docs/` — Anatoly-generated module docs,
 *   context-only (never scored).
 * - `'project'`: `docs/` — human-authored project docs, the scored ground-truth.
 * - `'flow'`: `.anatoly/state/internal-flows/` — the generated user-flow page
 *   (doc 23). Internal-like: context-only, watched by doc-conflict, retrievable by
 *   the documentation axis, arbitrable; never project-scored.
 */
export type DocSource = 'internal' | 'project' | 'flow';

/** A doc section entry for listing purposes. */
export interface DocSectionEntry {
  id: string;
  filePath: string;
  name: string;
  summary: string;
  lastIndexed: string;
  /** Where the section was indexed from (see {@link DocSource}). */
  source: DocSource;
}
