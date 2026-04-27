// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Task, SymbolInfo } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import { contextLogger } from '../utils/log-context.js';
import type { AxisId } from './axis-evaluator.js';
import { resolveExportedSymbolUtility, type UsageGraph } from './usage-graph.js';

export type TriageTier = 'skip' | 'evaluate';

export interface TriageResult {
  tier: TriageTier;
  reason: string;
}

const TYPE_KINDS = new Set(['type', 'enum']);
const CONSTANT_KINDS = new Set(['constant']);

/**
 * For a file that triage classified into skip tier, return the subset of
 * axes that should still run their full evaluator anyway.
 *
 * Per-axis policy:
 *
 * - **barrel-export** — no own symbols; no axis has anything to find.
 *   Nothing to run.
 * - **trivial** — small file (≤10 lines, ≤1 symbol) can absolutely have
 *   business-logic bugs (e.g. a 4-line helper with the wrong formula) and
 *   can be a duplicate of another helper. Run `correction` and
 *   `duplication`. Skip the others (overengineering, tests, doc, BP) —
 *   small surface, low signal.
 * - **type-only** — declarations only, no runtime behavior to validate.
 *   Skip everything; utility is recovered cheaply by
 *   {@link generateSkipReview} via the usage graph (catches dead type
 *   exports without an LLM call).
 * - **constants-only** — same as type-only.
 *
 * The "skip" tier no longer means "no LLM, ever" — it means "LLM only
 * for the axes whose signal a small / type-only file can plausibly
 * carry". Small surfaces with high domain weight (a 4-line wild-bonus
 * helper) are the exact cases where the bench surfaced silent misses
 * under the previous all-or-nothing policy.
 */
export function evaluatorAxesForSkip(reason: string): Set<AxisId> {
  switch (reason) {
    case 'trivial':
      // Utility runs cheaply via the usage-graph auto-resolver (no LLM
      // unless a non-exported symbol forces it); correction and
      // duplication may invoke the LLM but on a 4-line file the cost
      // is trivial and the signal — bugs, helper duplications — high.
      return new Set<AxisId>(['correction', 'duplication', 'utility']);
    case 'barrel-export':
    case 'type-only':
    case 'constants-only':
      return new Set<AxisId>();
    default:
      return new Set<AxisId>();
  }
}

/**
 * Check if a file is a barrel export (re-export only, no own symbols).
 * Barrel files contain lines like `export { X } from './path'` or `export * from './path'`
 * but no own declarations.
 */
function isBarrelExport(task: Task, source: string): boolean {
  if (task.symbols.length > 0) return false;
  const lines = source.split('\n').filter((l) => l.trim().length > 0);
  return lines.length > 0 && lines.every((l) => /^\s*export\s/.test(l));
}

/**
 * Classify a file into skip or evaluate tier for review dispatch.
 *
 * In the axis-based pipeline, there is no distinction between fast/deep —
 * all non-skip files go through the same per-axis evaluator pipeline.
 *
 * Skip reasons: `barrel-export`, `trivial`, `type-only`, `constants-only`.
 * Evaluate reasons: `internal`, `simple`, `complex`.
 *
 * @param task - Scanned task containing file path and parsed symbols.
 * @param source - Raw source code of the file.
 * @returns A {@link TriageResult} with the assigned tier and a reason string.
 */
export function triageFile(task: Task, source: string): TriageResult {
  const lineCount = source.split('\n').length;
  const symbols = task.symbols;
  const log = contextLogger();

  // --- Skip tier ---

  // Barrel export: 0 symbols, only re-export lines
  if (isBarrelExport(task, source)) {
    log.debug({ file: task.file, tier: 'skip', reason: 'barrel-export' }, 'triage classification');
    return { tier: 'skip', reason: 'barrel-export' };
  }

  // Trivial: < 10 lines with 0-1 symbol
  if (lineCount < 10 && symbols.length <= 1) {
    log.debug({ file: task.file, tier: 'skip', reason: 'trivial' }, 'triage classification');
    return { tier: 'skip', reason: 'trivial' };
  }

  // Type-only: all symbols are type or enum
  if (symbols.length > 0 && symbols.every((s) => TYPE_KINDS.has(s.kind))) {
    log.debug({ file: task.file, tier: 'skip', reason: 'type-only' }, 'triage classification');
    return { tier: 'skip', reason: 'type-only' };
  }

  // Constants-only: all symbols are constants
  if (symbols.length > 0 && symbols.every((s) => CONSTANT_KINDS.has(s.kind))) {
    log.debug({ file: task.file, tier: 'skip', reason: 'constants-only' }, 'triage classification');
    return { tier: 'skip', reason: 'constants-only' };
  }

  // --- Evaluate tier (all non-skip files) ---

  // Internal: has symbols but none are exported
  if (symbols.length > 0 && !symbols.some((s) => s.exported)) {
    log.debug({ file: task.file, tier: 'evaluate', reason: 'internal' }, 'triage classification');
    return { tier: 'evaluate', reason: 'internal' };
  }

  const reason = symbols.length < 3 ? 'simple' : 'complex';
  log.debug({ file: task.file, tier: 'evaluate', reason }, 'triage classification');
  return { tier: 'evaluate', reason };
}

/**
 * Generate a synthetic review for a skipped file.
 * Produces a valid ReviewFile with is_generated=true and skip_reason.
 * Zero LLM calls — but consults the usage graph (when provided) so
 * that exported symbols on type-only / constants-only / trivial files
 * with no importers are correctly classified `DEAD` instead of blanket
 * `USED`.
 *
 * @param task - Scanned task whose symbols are populated with safe defaults.
 * @param reason - Triage skip reason (e.g. `barrel-export`, `trivial`).
 * @param enabledAxes - Optional axes filter; non-listed axes are marked `'-'`.
 * @param usageGraph - Optional usage graph; when supplied, the utility axis
 *   verdict is computed per-symbol via {@link resolveExportedSymbolUtility}.
 *   Non-exported symbols and missing graph entries fall back to `USED`.
 * @returns A complete {@link ReviewFile} with `is_generated: true`.
 */
export function generateSkipReview(
  task: Task,
  reason: string,
  enabledAxes?: string[],
  usageGraph?: UsageGraph,
): ReviewFile {
  const skipDetail = `Trivial file — auto-skipped by triage (${reason})`;
  const active = enabledAxes ? new Set(enabledAxes) : undefined;
  const utilityActive = !active || active.has('utility');

  let anyDead = false;
  const symbols = task.symbols.map((s: SymbolInfo) => {
    let utilityValue: 'USED' | 'DEAD' | '-' = utilityActive ? 'USED' : '-';
    let utilityDetail = skipDetail;

    if (utilityActive && usageGraph && s.exported) {
      const resolved = resolveExportedSymbolUtility(
        { name: s.name, exported: s.exported },
        usageGraph,
        task.file,
      );
      if (resolved) {
        utilityValue = resolved.value;
        utilityDetail = resolved.detail;
        if (resolved.value === 'DEAD') anyDead = true;
      }
    }

    return {
      name: s.name,
      kind: s.kind,
      exported: s.exported,
      line_start: s.line_start,
      line_end: s.line_end,
      correction: (!active || active.has('correction') ? 'OK' : '-') as 'OK' | '-',
      overengineering: (!active || active.has('overengineering') ? 'LEAN' : '-') as 'LEAN' | '-',
      utility: utilityValue,
      duplication: (!active || active.has('duplication') ? 'UNIQUE' : '-') as 'UNIQUE' | '-',
      tests: '-' as const,
      documentation: '-' as const,
      confidence: 100,
      detail: utilityDetail,
      duplicate_target: undefined,
    };
  });

  return {
    version: 2,
    file: task.file,
    is_generated: true,
    skip_reason: reason,
    ...(task.language ? { language: task.language } : {}),
    ...(task.parse_method ? { parse_method: task.parse_method } : {}),
    verdict: anyDead ? 'NEEDS_REFACTOR' : 'CLEAN',
    symbols,
    actions: [],
    file_level: {
      unused_imports: [],
      circular_dependencies: [],
      general_notes: '',
    },
  };
}
