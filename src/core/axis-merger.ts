import type { Task, SymbolInfo } from '../schemas/task.js';
import type { ReviewFile, SymbolReview, Action, BestPractices } from '../schemas/review.js';
import type { AxisResult, AxisId, AxisSymbolResult } from './axis-evaluator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Defaults for axes when an evaluator didn't produce a result for a symbol. */
const AXIS_DEFAULTS: Record<AxisId, string> = {
  utility: 'USED',
  duplication: 'UNIQUE',
  correction: 'OK',
  overengineering: 'LEAN',
  tests: 'NONE',
  best_practices: 'N/A',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge per-axis evaluation results into a single ReviewFile v2.
 *
 * - Combines symbol-level results from each axis
 * - Applies inter-axis coherence rules (e.g. DEAD → tests:NONE)
 * - Merges actions from all axes
 * - Computes verdict from merged symbols
 * - Builds axis_meta from cost/duration data
 */
export function mergeAxisResults(
  task: Task,
  results: AxisResult[],
  bestPractices?: BestPractices,
): ReviewFile {
  const axisMap = buildAxisMap(results);

  const symbols: SymbolReview[] = task.symbols.map((sym) => {
    const merged = mergeSymbol(sym, axisMap);
    return applyCoherenceRules(merged);
  });

  const actions = mergeActions(results);
  const fileLevel = mergeFileLevels(results);
  const verdict = computeVerdict(symbols);
  const axisMeta = buildAxisMeta(results);

  return {
    version: 2,
    file: task.file,
    is_generated: false,
    verdict,
    symbols,
    actions,
    file_level: fileLevel,
    ...(bestPractices ? { best_practices: bestPractices } : {}),
    ...(Object.keys(axisMeta).length > 0 ? { axis_meta: axisMeta } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type AxisMap = Map<AxisId, Map<string, AxisSymbolResult>>;

function buildAxisMap(results: AxisResult[]): AxisMap {
  const map: AxisMap = new Map();
  for (const r of results) {
    const symMap = new Map<string, AxisSymbolResult>();
    for (const s of r.symbols) {
      symMap.set(s.name, s);
    }
    map.set(r.axisId, symMap);
  }
  return map;
}

function findAxisValue(axisMap: AxisMap, axisId: AxisId, symbolName: string): AxisSymbolResult | undefined {
  return axisMap.get(axisId)?.get(symbolName);
}

function mergeSymbol(sym: SymbolInfo, axisMap: AxisMap): SymbolReview {
  const utility = findAxisValue(axisMap, 'utility', sym.name);
  const duplication = findAxisValue(axisMap, 'duplication', sym.name);
  const correction = findAxisValue(axisMap, 'correction', sym.name);
  const overengineering = findAxisValue(axisMap, 'overengineering', sym.name);
  const tests = findAxisValue(axisMap, 'tests', sym.name);

  const confidences = [utility, duplication, correction, overengineering, tests]
    .filter((r): r is AxisSymbolResult => r !== undefined)
    .map((r) => r.confidence);

  const confidence = confidences.length > 0
    ? Math.min(...confidences)
    : 80;

  const details = [utility, duplication, correction, overengineering, tests]
    .filter((r): r is AxisSymbolResult => r !== undefined)
    .map((r) => `[${r.value}] ${r.detail}`);

  return {
    name: sym.name,
    kind: sym.kind,
    exported: sym.exported,
    line_start: sym.line_start,
    line_end: sym.line_end,
    correction: (correction?.value ?? AXIS_DEFAULTS.correction) as 'OK' | 'NEEDS_FIX' | 'ERROR',
    overengineering: (overengineering?.value ?? AXIS_DEFAULTS.overengineering) as 'LEAN' | 'OVER' | 'ACCEPTABLE',
    utility: (utility?.value ?? AXIS_DEFAULTS.utility) as 'USED' | 'DEAD' | 'LOW_VALUE',
    duplication: (duplication?.value ?? AXIS_DEFAULTS.duplication) as 'UNIQUE' | 'DUPLICATE',
    tests: (tests?.value ?? AXIS_DEFAULTS.tests) as 'GOOD' | 'WEAK' | 'NONE',
    confidence,
    detail: details.length > 0 ? details.join(' | ') : 'No axis evaluators produced results for this symbol.',
    duplicate_target: duplication?.duplicate_target,
  };
}

/**
 * Apply inter-axis coherence rules.
 * - If utility=DEAD, force tests=NONE (no point testing dead code)
 * - If correction=ERROR, force overengineering=ACCEPTABLE (complexity is secondary to correctness)
 */
function applyCoherenceRules(sym: SymbolReview): SymbolReview {
  let result = sym;

  // DEAD code doesn't need tests
  if (result.utility === 'DEAD' && result.tests !== 'NONE') {
    result = { ...result, tests: 'NONE' };
  }

  // ERROR corrections make complexity assessment moot
  if (result.correction === 'ERROR' && result.overengineering !== 'ACCEPTABLE') {
    result = { ...result, overengineering: 'ACCEPTABLE' };
  }

  return result;
}

function mergeActions(results: AxisResult[]): Action[] {
  const allActions = results.flatMap((r) => r.actions);
  // Re-assign IDs sequentially
  return allActions.map((a, i) => ({ ...a, id: i + 1 }));
}

function mergeFileLevels(results: AxisResult[]) {
  const unused: string[] = [];
  const circular: string[] = [];
  const notes: string[] = [];

  for (const r of results) {
    if (r.fileLevel?.unused_imports) unused.push(...r.fileLevel.unused_imports);
    if (r.fileLevel?.circular_dependencies) circular.push(...r.fileLevel.circular_dependencies);
    if (r.fileLevel?.general_notes) notes.push(r.fileLevel.general_notes);
  }

  return {
    unused_imports: [...new Set(unused)],
    circular_dependencies: [...new Set(circular)],
    general_notes: notes.join(' | '),
  };
}

function computeVerdict(symbols: SymbolReview[]): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
  let hasCorrection = false;
  let hasFinding = false;

  for (const s of symbols) {
    if (s.correction === 'ERROR') return 'CRITICAL';
    if (s.correction === 'NEEDS_FIX') hasCorrection = true;
    if (s.utility === 'DEAD' || s.duplication === 'DUPLICATE' || s.overengineering === 'OVER') {
      hasFinding = true;
    }
  }

  if (hasCorrection || hasFinding) return 'NEEDS_REFACTOR';
  return 'CLEAN';
}

function buildAxisMeta(results: AxisResult[]): Record<string, { model: string; cost_usd: number; duration_ms: number }> {
  const meta: Record<string, { model: string; cost_usd: number; duration_ms: number }> = {};
  for (const r of results) {
    // Extract model from transcript (init line) — simplified fallback
    const modelMatch = r.transcript.match(/\*\*Model:\*\*\s*(\S+)/);
    meta[r.axisId] = {
      model: modelMatch?.[1] ?? 'unknown',
      cost_usd: r.costUsd,
      duration_ms: r.durationMs,
    };
  }
  return meta;
}
