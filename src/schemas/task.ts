// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

const SymbolKindSchema = z.enum([
  'function',
  'class',
  'method',
  'type',
  'constant',
  'variable',
  'enum',
  'hook',
]);

const SymbolInfoSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  exported: z.boolean(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
});

const CoverageDataSchema = z.object({
  statements_total: z.int().min(0),
  statements_covered: z.int().min(0),
  branches_total: z.int().min(0),
  branches_covered: z.int().min(0),
  functions_total: z.int().min(0),
  functions_covered: z.int().min(0),
  lines_total: z.int().min(0),
  lines_covered: z.int().min(0),
});

const ImportRefSchema = z.object({
  source: z.string(),
  type: z.enum(['import', 'source', 'require']),
});

/**
 * Zod schema for a scanner task — the unit of work produced by `scanProject`.
 *
 * Each task represents a single source file with its SHA-256 content hash,
 * extracted symbols, and optional metadata (coverage, language, framework).
 * The `version: 1` literal enables future schema migrations.
 */
export const TaskSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  hash: z.string(),
  symbols: z.array(SymbolInfoSchema),
  imports: z.array(ImportRefSchema).optional(),
  coverage: CoverageDataSchema.optional(),
  language: z.string().optional(),
  parse_method: z.enum(['ast', 'heuristic']).optional(),
  framework: z.string().optional(),
  scanned_at: z.string(),
});

export type SymbolKind = z.infer<typeof SymbolKindSchema>;
export type SymbolInfo = z.infer<typeof SymbolInfoSchema>;
export type CoverageData = z.infer<typeof CoverageDataSchema>;
export type Task = z.infer<typeof TaskSchema>;
