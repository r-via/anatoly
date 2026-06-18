// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The `flow` evaluation axis (doc 23, section 7).
 *
 * Parcours-level structural-quality axis. Unlike the six LLM axes, `flow` is
 * fully DETERMINISTIC and LLM-free: it reads the artifact written by the
 * deterministic `flows` phase (`.anatoly/state/internal-flows/flows.json`) and
 * scores defects that are only visible across the cross-file flow graph, never
 * to a per-symbol pass. It never calls a model, so it returns a zero-cost
 * {@link AxisResult} (the {@link UtilityEvaluator} auto-resolution shape).
 *
 * Five natures, in display-precedence order:
 *
 * 1. `unwired_flow`      — an entry whose path reaches no effect AND whose
 *                          export is imported by zero files (dead intent). The
 *                          public read-only queries (`loadSummary`, …) are also
 *                          unwired but are imported through the barrel, so the
 *                          usage-graph DEAD check separates a dead orphan from a
 *                          legitimate query (the false-positive guard).
 * 2. `redundant_flow`    — two or more distinct wired flows with an identical
 *                          step set and identical effect set (duplicate twins).
 * 3. `inconsistent_siblings` — a wired flow whose step set is a strict subset
 *                          of a DIRECT sibling reaching the same effect, the
 *                          only difference being pure-transform guard steps the
 *                          sibling performs and this one omits (missing
 *                          validation). Only the deficient member is flagged.
 * 4. `over_indirect`     — a wired flow routed through `INDIRECTION_CAP` or more
 *                          pure pass-through transform hops to reach its effect.
 * 5. `effect_asymmetry`  — a wired flow that reaches a create/enqueue effect on
 *                          an entity the codebase never tears down (asymmetric
 *                          lifecycle).
 *
 * The bench scorer matches on `(axis, verdict, file, symbol)` only; the `nature`
 * label is display-only text in the detail string. So the union of the five
 * detectors must equal exactly the cataloged `(file, symbol)` NEEDS_FIX anchors
 * with ZERO false positives. Every detector is therefore tuned for precision:
 * recall lands incrementally (`unwired_flow` first), precision never regresses.
 */

import { readFileSync } from 'node:fs';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../contract.js';
import { flowArtifactPath } from '../../flows/index.js';
import { resolveExportedSymbolUtility } from '../../scanning/index.js';
import { UserFlowArtifactSchema, type UserFlow, type UserFlowArtifact } from '../../../schemas/user-flow.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A wired flow with this many pure-transform pass-through hops or more is over-indirect. */
const INDIRECTION_CAP = 2;

/**
 * Verb roots that mark an effect as *creating/growing* an entity. Matched as a
 * camelCase-word prefix (`insertTask` -> create), so a teardown counterpart is
 * required for the lifecycle to be symmetric.
 */
const CREATE_VERBS = [
  'insert', 'create', 'add', 'enqueue', 'push', 'register', 'seed', 'append', 'notify', 'announce', 'post', 'emit',
] as const;

/**
 * Verb roots that mark a symbol as *tearing down/shrinking* an entity. Matched
 * as a camelCase-word prefix; `archive` covers `archiveProject` /
 * `markProjectArchived` (a lifecycle-ending state change counts as teardown).
 */
const TEARDOWN_VERBS = [
  'remove', 'delete', 'drop', 'archive', 'clear', 'drain', 'dequeue', 'pop', 'flush', 'unregister', 'retire', 'purge',
] as const;

/** camelCase words that are neither verb nor entity noun (dropped from noun extraction). */
const NOUN_STOPWORDS = new Set(['cmd', 'async', 'via', 'the', 'to', 'a', 'record', 'records', 'store', 'fn', 'impl']);

// ---------------------------------------------------------------------------
// Lexical helpers (deterministic, naming-based)
// ---------------------------------------------------------------------------

/** Split an identifier into lowercase camelCase / snake_case words. */
function words(symbol: string): string[] {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasVerb(symbol: string, verbs: readonly string[]): boolean {
  return words(symbol).some((w) => verbs.some((v) => w.startsWith(v)));
}

const isCreateClass = (symbol: string): boolean => hasVerb(symbol, CREATE_VERBS);
const isTeardownClass = (symbol: string): boolean => hasVerb(symbol, TEARDOWN_VERBS);

/**
 * The entity noun an effect/command operates on: the identifier words with all
 * known verb roots and stopwords removed (e.g. `insertTask` -> "task",
 * `markProjectArchived` -> "project"). Falls back to the last word when nothing
 * remains, so it is never empty.
 */
function entityNoun(symbol: string): string {
  const ws = words(symbol);
  const isVerb = (w: string): boolean =>
    CREATE_VERBS.some((v) => w.startsWith(v)) || TEARDOWN_VERBS.some((v) => w.startsWith(v)) ||
    w === 'mark' || w === 'set' || w === 'update' || w === 'reopen';
  const nouns = ws.filter((w) => !isVerb(w) && !NOUN_STOPWORDS.has(w));
  if (nouns.length > 0) return nouns.join('');
  return ws[ws.length - 1] ?? symbol.toLowerCase();
}

/** Two entity nouns refer to the same store when either contains the other (task/tasks, project/projects). */
function sameEntity(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------------------
// Flow-shape helpers
// ---------------------------------------------------------------------------

/** Sorted `file::symbol` keys of a flow's steps (the path hops, effects excluded). */
function stepKeys(flow: UserFlow): string[] {
  return flow.steps.map((s) => `${s.file}::${s.symbol}`).sort();
}

/** Sorted `file::symbol` keys of a flow's terminal effects. */
function effectKeys(flow: UserFlow): string[] {
  return flow.effects.map((e) => `${e.file}::${e.symbol}`).sort();
}

/** Count of pure pass-through (`transform`) hops in a flow's path. */
function transformCount(flow: UserFlow): number {
  return flow.steps.filter((s) => s.role === 'transform').length;
}

/** True when every element of `sub` is in `sup` (set membership over keys). */
function isSubset(sub: string[], sup: string[]): boolean {
  const set = new Set(sup);
  return sub.every((k) => set.has(k));
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Nature computation (global, cross-flow)
// ---------------------------------------------------------------------------

type FlowNature = 'unwired_flow' | 'redundant_flow' | 'inconsistent_siblings' | 'over_indirect' | 'effect_asymmetry';

interface FlowVerdict {
  nature: FlowNature;
  detail: string;
}

/**
 * Compute the defect verdict (if any) for every flow in the artifact. Returns a
 * map keyed by `flow.id`. Higher-precedence natures win when a flow matches
 * several detectors (the natures are evaluated in precedence order and a flow is
 * only marked once).
 *
 * `usageGraph` is required for the `unwired_flow` DEAD confirmation; without it
 * the unwired detector is skipped entirely (no false positive), the cross-flow
 * detectors are unaffected.
 */
export function computeFlowVerdicts(
  flows: UserFlow[],
  resolveDead: (entry: { file: string; symbol: string }) => boolean,
): Map<string, FlowVerdict> {
  const verdicts = new Map<string, FlowVerdict>();
  const mark = (flow: UserFlow, nature: FlowNature, detail: string): void => {
    if (!verdicts.has(flow.id)) verdicts.set(flow.id, { nature, detail });
  };

  const wired = flows.filter((f) => !f.unwired);

  // --- 1. unwired_flow: dead-intent orphan (unwired AND export imported by 0 files) ---
  for (const flow of flows) {
    if (!flow.unwired) continue;
    if (resolveDead(flow.entry)) {
      mark(
        flow,
        'unwired_flow',
        `Flow entry '${flow.entry.symbol}' resolves out-edges to pure reads/formats but reaches no state-mutation or outbox effect, and the export is imported by 0 files (dead intent).`,
      );
    }
  }

  // --- 2. redundant_flow: distinct wired flows with identical step + effect sets ---
  const byShape = new Map<string, UserFlow[]>();
  for (const flow of wired) {
    if (flow.effects.length === 0) continue;
    const key = `${stepKeys(flow).join('|')}##${effectKeys(flow).join('|')}`;
    const bucket = byShape.get(key);
    if (bucket) bucket.push(flow);
    else byShape.set(key, [flow]);
  }
  for (const bucket of byShape.values()) {
    if (bucket.length < 2) continue;
    for (const flow of bucket) {
      const twins = bucket.filter((o) => o.id !== flow.id).map((o) => o.entry.symbol);
      mark(
        flow,
        'redundant_flow',
        `Identical step and effect path to ${twins.join(', ')} (redundant duplicate flow that should be collapsed into one command).`,
      );
    }
  }

  // --- 3. inconsistent_siblings: strict-subset deficient flow missing a sibling's guard steps ---
  for (const deficient of wired) {
    if (verdicts.has(deficient.id)) continue;
    const defSteps = stepKeys(deficient);
    const defEffects = effectKeys(deficient);
    for (const reference of wired) {
      if (reference.id === deficient.id) continue;
      // The reference must reach the same effect, be a DIRECT command (not itself
      // over-indirect — otherwise a clean command looks "deficient" against a long
      // pipeline), and strictly contain the deficient flow's steps.
      if (!arraysEqual(defEffects, effectKeys(reference))) continue;
      if (transformCount(reference) >= INDIRECTION_CAP) continue;
      const refSteps = stepKeys(reference);
      if (refSteps.length <= defSteps.length) continue;
      if (!isSubset(defSteps, refSteps)) continue;
      // The only difference must be pure-transform guard steps (the missing validation).
      const defSet = new Set(defSteps);
      const missing = reference.steps.filter((s) => !defSet.has(`${s.file}::${s.symbol}`));
      if (missing.length === 0) continue;
      if (!missing.every((s) => s.role === 'transform')) continue;
      mark(
        deficient,
        'inconsistent_siblings',
        `Reaches the same effect as sibling '${reference.entry.symbol}' but omits its guard step(s) ${missing.map((s) => s.symbol).join(', ')} (missing validation the sibling performs).`,
      );
      break;
    }
  }

  // --- 4. over_indirect: wired flow with INDIRECTION_CAP+ pure pass-through hops ---
  for (const flow of wired) {
    if (verdicts.has(flow.id)) continue;
    const hops = flow.steps.filter((s) => s.role === 'transform');
    if (hops.length >= INDIRECTION_CAP) {
      mark(
        flow,
        'over_indirect',
        `Routes through ${hops.length} pass-through transform hops (${hops.map((s) => s.symbol).join(' -> ')}) to reach its effect; the direct command needs none.`,
      );
    }
  }

  // --- 5. effect_asymmetry: create/enqueue effect on an entity never torn down ---
  const teardownNouns: string[] = [];
  for (const flow of flows) {
    if (isTeardownClass(flow.entry.symbol)) teardownNouns.push(entityNoun(flow.entry.symbol));
    for (const eff of flow.effects) {
      if (isTeardownClass(eff.symbol)) teardownNouns.push(entityNoun(eff.symbol));
    }
  }
  const hasTeardown = (noun: string): boolean => teardownNouns.some((t) => sameEntity(noun, t));
  for (const flow of wired) {
    if (verdicts.has(flow.id)) continue;
    for (const eff of flow.effects) {
      if (!isCreateClass(eff.symbol)) continue;
      const noun = entityNoun(eff.symbol);
      if (!hasTeardown(noun)) {
        mark(
          flow,
          'effect_asymmetry',
          `Reaches a create/enqueue effect (${eff.symbol}) for '${noun}' but no flow ever tears that entity down (asymmetric lifecycle: missing teardown).`,
        );
        break;
      }
    }
  }

  return verdicts;
}

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

/** Read + validate flows.json. Returns null when the artifact is absent or malformed (no-op the axis). */
function loadFlowArtifact(projectRoot: string): UserFlowArtifact | null {
  let raw: string;
  try {
    raw = readFileSync(flowArtifactPath(projectRoot), 'utf8');
  } catch {
    return null; // flows phase disabled or not yet run
  }
  const parsed = UserFlowArtifactSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class FlowEvaluator implements AxisEvaluator {
  readonly id = 'flow' as const;
  // Deterministic, LLM-free: the model is never consulted. `defaultModel` is a
  // formality the SPI requires; no call is ever issued against it.
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, _abortController: AbortController): Promise<AxisResult> {
    const empty: AxisResult = {
      axisId: 'flow',
      symbols: [],
      actions: [],
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: '',
    };

    const artifact = loadFlowArtifact(ctx.projectRoot);
    if (!artifact || artifact.flows.length === 0) return empty;

    // `unwired_flow` needs the usage graph to separate a dead orphan (0 importers)
    // from a public read-only query re-exported through the barrel. Without it the
    // unwired detector is skipped (no false positive).
    const resolveDead = (entry: { file: string; symbol: string }): boolean => {
      if (!ctx.usageGraph) return false;
      const verdict = resolveExportedSymbolUtility(
        { name: entry.symbol, exported: true, is_default: false },
        ctx.usageGraph,
        entry.file,
      );
      return verdict?.value === 'DEAD';
    };

    const verdicts = computeFlowVerdicts(artifact.flows, resolveDead);

    // Emit one result per flow ENTRY rooted in the current file. Healthy entries
    // render OK; defective entries render NEEDS_FIX with the nature in the detail.
    // Non-entry symbols get no result and default to '-' (not applicable).
    const symbolLine = new Map(ctx.task.symbols.map((s) => [s.name, s]));
    const symbols: AxisSymbolResult[] = [];
    for (const flow of artifact.flows) {
      if (flow.entry.file !== ctx.task.file) continue;
      const sym = symbolLine.get(flow.entry.symbol);
      if (!sym) continue; // entry not among this file's catalogued symbols
      const verdict = verdicts.get(flow.id);
      symbols.push({
        name: sym.name,
        line_start: sym.line_start,
        line_end: sym.line_end,
        value: verdict ? 'NEEDS_FIX' : 'OK',
        // Propagate the flow's resolution confidence (100 clean, lower when the
        // walk was truncated or an import resolved ambiguously) rather than a
        // flat constant, so the refinement pipeline can escalate the genuinely
        // ambiguous flows (low confidence) while leaving clean structural facts
        // confirmed deterministically. See the deliberation engagement (doc 05).
        confidence: flow.confidence,
        detail: verdict
          ? `${verdict.nature}: ${verdict.detail}`
          : `Flow '${flow.entry.symbol}' is wired to a terminal effect with no structural defect.`,
      });
    }

    return { ...empty, symbols };
  }
}
