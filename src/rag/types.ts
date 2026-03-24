// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

export const BehavioralProfileSchema = z.enum([
  'pure',
  'sideEffectful',
  'async',
  'memoized',
  'stateful',
  'utility',
]);

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

/** A doc section entry for listing purposes. */
export interface DocSectionEntry {
  id: string;
  filePath: string;
  name: string;
  summary: string;
  lastIndexed: string;
  /** 'internal' (.anatoly/docs/) or 'project' (docs/). */
  source: 'internal' | 'project';
}
