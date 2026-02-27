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
  failedAxes: AxisId[] = [],
): ReviewFile {
  const axisMap = buildAxisMap(results);
  const failedSet = new Set(failedAxes);

  const rawSymbols: SymbolReview[] = task.symbols.map((sym) => {
    const merged = mergeSymbol(sym, axisMap, failedSet);
    return applyCoherenceRules(merged);
  });

  const symbols = detectContradictions(rawSymbols, bestPractices);
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

/** Validate that a value is a member of the expected enum, falling back to a default. */
function validateEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

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

function mergeSymbol(sym: SymbolInfo, axisMap: AxisMap, failedAxes: Set<AxisId>): SymbolReview {
  const utility = findAxisValue(axisMap, 'utility', sym.name);
  const duplication = findAxisValue(axisMap, 'duplication', sym.name);
  const correction = findAxisValue(axisMap, 'correction', sym.name);
  const overengineering = findAxisValue(axisMap, 'overengineering', sym.name);
  const tests = findAxisValue(axisMap, 'tests', sym.name);

  const axisResults: Array<{ id: AxisId; result: AxisSymbolResult | undefined }> = [
    { id: 'utility', result: utility },
    { id: 'duplication', result: duplication },
    { id: 'correction', result: correction },
    { id: 'overengineering', result: overengineering },
    { id: 'tests', result: tests },
  ];

  const confidences = axisResults
    .filter((a): a is { id: AxisId; result: AxisSymbolResult } => a.result !== undefined)
    .map((a) => a.result.confidence);

  // Detect when all symbol-level axes crashed (no real results but failures recorded)
  const crashedSymbolAxes = axisResults.filter(
    (a) => a.result === undefined && failedAxes.has(a.id),
  ).length;
  const allSymbolAxesFailed = confidences.length === 0 && crashedSymbolAxes > 0;

  const confidence = confidences.length > 0
    ? Math.min(...confidences)
    : allSymbolAxesFailed ? 0 : 80;

  // Build detail segments: include crash sentinels for failed axes
  const details: string[] = [];
  for (const { id, result } of axisResults) {
    if (result) {
      details.push(`[${result.value}] ${result.detail}`);
    } else if (failedAxes.has(id)) {
      const defaultValue = AXIS_DEFAULTS[id];
      details.push(`[${defaultValue}] *(axis crashed — see transcript)*`);
    }
    // If not in results AND not crashed → omitted (review-writer shows "default" message)
  }

  return {
    name: sym.name,
    kind: sym.kind,
    exported: sym.exported,
    line_start: sym.line_start,
    line_end: sym.line_end,
    correction: validateEnum(correction?.value ?? AXIS_DEFAULTS.correction, ['OK', 'NEEDS_FIX', 'ERROR'] as const, 'OK'),
    overengineering: validateEnum(overengineering?.value ?? AXIS_DEFAULTS.overengineering, ['LEAN', 'OVER', 'ACCEPTABLE'] as const, 'LEAN'),
    utility: validateEnum(utility?.value ?? AXIS_DEFAULTS.utility, ['USED', 'DEAD', 'LOW_VALUE'] as const, 'USED'),
    duplication: validateEnum(duplication?.value ?? AXIS_DEFAULTS.duplication, ['UNIQUE', 'DUPLICATE'] as const, 'UNIQUE'),
    tests: validateEnum(tests?.value ?? AXIS_DEFAULTS.tests, ['GOOD', 'WEAK', 'NONE'] as const, 'NONE'),
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
  const allActions = results.flatMap((r) =>
    r.actions.map((a) => ({ ...a, source: r.axisId })),
  );
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

/**
 * Detect contradictions between correction findings and best_practices results.
 * When correction flags NEEDS_FIX on a pattern that best_practices explicitly PASSes,
 * downgrade the correction confidence below the 60-threshold so it is excluded from verdict.
 *
 * Currently handled: async/error handling (Rule 12).
 */
function detectContradictions(
  symbols: SymbolReview[],
  bestPractices?: BestPractices,
): SymbolReview[] {
  if (!bestPractices) return symbols;

  // Rule 12 = Async/Promises/Error handling
  const rule12 = bestPractices.rules.find((r) => r.rule_id === 12);
  if (!rule12 || rule12.status !== 'PASS') return symbols;

  return symbols.map((sym) => {
    if (sym.correction !== 'NEEDS_FIX') return sym;

    const detail = sym.detail.toLowerCase();
    const isAsyncRelated =
      detail.includes('async') ||
      detail.includes('promise') ||
      detail.includes('try-catch') ||
      detail.includes('try/catch') ||
      detail.includes('rejection') ||
      detail.includes('unhandled');

    if (!isAsyncRelated) return sym;

    // Downgrade below the reporter's 60 threshold → excluded from verdict
    // but above the 30 discard threshold → still visible in .rev.md
    return { ...sym, confidence: Math.min(sym.confidence, 55) };
  });
}

/** Confidence threshold: only symbols above this are considered for verdict. */
const VERDICT_CONFIDENCE_THRESHOLD = 60;

function computeVerdict(symbols: SymbolReview[]): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
  let hasCorrection = false;
  let hasFinding = false;

  for (const s of symbols) {
    if (s.confidence < VERDICT_CONFIDENCE_THRESHOLD) continue;
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
