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
  /**
   * True when the symbol is the file's default export (`export default ...`).
   * Default imports record their usage edge under the synthetic symbol name
   * `default`, so usage resolution must also consult that key for these
   * symbols. Optional for backward compatibility with older task caches.
   */
  is_default: z.boolean().optional(),
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
  /**
   * Imported binding names (the exported names in the source module).
   * `['default']` for a default import. Absent for a side-effect import
   * (`import './x'`) or a namespace import (see `namespace`). Populated by
   * AST extraction so the usage graph can build per-symbol edges.
   */
  symbols: z.array(z.string()).optional(),
  /** Type-only import/re-export (`import type`, `import { type X }`, `export type`). */
  typeOnly: z.boolean().optional(),
  /** Namespace import (`import * as X`) or star re-export (`export * from`): consumes all exports of the source. */
  namespace: z.boolean().optional(),
  /**
   * This ref is a RE-EXPORT (`export { x } from`, `export * from`), not a plain
   * import: the file forwards the binding to its own importers rather than using
   * it. Lets the usage graph tell a public passthrough barrel apart from a real
   * consumer (see `UsageGraph.reExports` / `getRealConsumers`).
   */
  reExport: z.boolean().optional(),
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
  /**
   * True when `imports` were extracted via AST at symbol-level granularity
   * (per-symbol names + type-only + namespace). The usage graph uses the
   * precise per-symbol path when set; otherwise it falls back to coarse
   * module-level expansion (marks all of the target's exports used). Absent on
   * pre-enrichment caches and heuristic (no-grammar) parses.
   */
  imports_enriched: z.boolean().optional(),
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
