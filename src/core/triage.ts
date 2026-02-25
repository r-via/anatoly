import type { Task, SymbolInfo } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';

export type TriageTier = 'skip' | 'evaluate';

export interface TriageResult {
  tier: TriageTier;
  reason: string;
}

const TYPE_KINDS = new Set(['type', 'enum']);
const CONSTANT_KINDS = new Set(['constant']);

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
 */
export function triageFile(task: Task, source: string): TriageResult {
  const lineCount = source.split('\n').length;
  const symbols = task.symbols;

  // --- Skip tier ---

  // Barrel export: 0 symbols, only re-export lines
  if (isBarrelExport(task, source)) {
    return { tier: 'skip', reason: 'barrel-export' };
  }

  // Trivial: < 10 lines with 0-1 symbol
  if (lineCount < 10 && symbols.length <= 1) {
    return { tier: 'skip', reason: 'trivial' };
  }

  // Type-only: all symbols are type or enum
  if (symbols.length > 0 && symbols.every((s) => TYPE_KINDS.has(s.kind))) {
    return { tier: 'skip', reason: 'type-only' };
  }

  // Constants-only: all symbols are constants
  if (symbols.length > 0 && symbols.every((s) => CONSTANT_KINDS.has(s.kind))) {
    return { tier: 'skip', reason: 'constants-only' };
  }

  // --- Evaluate tier (all non-skip files) ---

  // Internal: has symbols but none are exported
  if (symbols.length > 0 && !symbols.some((s) => s.exported)) {
    return { tier: 'evaluate', reason: 'internal' };
  }

  return { tier: 'evaluate', reason: symbols.length < 3 ? 'simple' : 'complex' };
}

/**
 * Generate a synthetic CLEAN review for a skipped file.
 * Produces a valid ReviewFile with is_generated=true and skip_reason.
 * Zero API calls.
 */
export function generateSkipReview(task: Task, reason: string): ReviewFile {
  const detail = `Trivial file — auto-skipped by triage (${reason})`;

  const symbols = task.symbols.map((s: SymbolInfo) => ({
    name: s.name,
    kind: s.kind,
    exported: s.exported,
    line_start: s.line_start,
    line_end: s.line_end,
    correction: 'OK' as const,
    overengineering: 'LEAN' as const,
    utility: 'USED' as const,
    duplication: 'UNIQUE' as const,
    tests: 'NONE' as const,
    confidence: 100,
    detail,
    duplicate_target: undefined,
  }));

  return {
    version: 2,
    file: task.file,
    is_generated: true,
    skip_reason: reason,
    verdict: 'CLEAN',
    symbols,
    actions: [],
    file_level: {
      unused_imports: [],
      circular_dependencies: [],
      general_notes: '',
    },
  };
}
