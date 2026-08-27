// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Action, SymbolReview } from '../../../schemas/review.js';
import { synthesizeActionsFromSymbols, groupIdenticalActions } from '../axis-merger.js';

/**
 * For every action `source` whose existence is justified by a per-symbol
 * verdict, the set of verdicts that still JUSTIFY the action. An action
 * survives reconciliation only while its target symbol's verdict on the
 * `source` axis is in this set. Sources not listed here (e.g. doc
 * divergences, file-level notes) are never reconciled — we cannot prove
 * them stale from a per-symbol verdict, so they pass through untouched.
 *
 * This mirrors the synthesis rules in axis-merger's
 * `synthesizeActionsFromSymbols` plus the LLM-emitted `correction` actions,
 * which axis-merger does not synthesize but which are equally invalidated
 * once a symbol's correction verdict is downgraded to OK.
 */
export const ACTIONABLE_VERDICTS: Record<string, ReadonlySet<string>> = {
  utility: new Set(['DEAD', 'LOW_VALUE']),
  duplication: new Set(['DUPLICATE']),
  overengineering: new Set(['OVER']),
  documentation: new Set(['UNDOCUMENTED', 'PARTIAL']),
  correction: new Set(['NEEDS_FIX', 'ERROR']),
};

/**
 * Reconcile a review's actions against its final per-symbol verdicts.
 *
 * The review phase (axis-merger) synthesizes and GROUPS actions from the
 * verdicts known at merge time. Later phases — tier1 auto-resolve
 * (`DEAD → USED`, `DUPLICATE → UNIQUE`, ...), tier2 coherence, and tier3
 * deliberation (`NEEDS_FIX → OK`) — mutate those verdicts but do not rebuild
 * the actions. Without this pass a symbol resolved to USED still carries a
 * "Remove dead code" action, and a barrel grouped into one whole-file action
 * keeps listing every export even after most are reclassified USED (the
 * exact ui-kit-app `Card`/`Dialog`/`Table` false positive).
 *
 * For each action whose `source` is verdict-driven:
 *  - split the (possibly comma-joined, grouped) `target_symbol` into names;
 *  - keep only the names whose current verdict still justifies the action;
 *  - all survive  → keep the action unchanged;
 *  - none survive → drop the action (its verdict flipped away);
 *  - some survive → re-derive the canonical action(s) for the survivors via
 *    the same synthesize+group helpers the review phase uses, so the
 *    description/target name only the symbols that still warrant it.
 *
 * Unknown target symbols are kept conservatively (we cannot evaluate the
 * verdict, so we never silently drop). Actions are re-numbered sequentially.
 */
export function reconcileActionsWithVerdicts(
  actions: Action[],
  symbols: SymbolReview[],
  language?: string,
): Action[] {
  const bySymbol = new Map(symbols.map((s) => [s.name, s]));

  const reconciled = actions.flatMap((a): Action[] => {
    const source = a.source;
    if (!a.target_symbol || !source) return [a];
    const actionable = ACTIONABLE_VERDICTS[source];
    if (!actionable) return [a]; // not a verdict-driven source — never reconcile

    // Grouped actions carry a comma-joined target_symbol ("Card, CardHeader, ...").
    // deliberation.ts applies the same split for its auto-prune.
    const names = a.target_symbol.split(/,\s*/).filter(Boolean);
    const survivors = names.filter((name) => {
      const sym = bySymbol.get(name);
      if (!sym) return true; // unknown symbol — cannot evaluate, keep conservatively
      const verdict = String((sym as unknown as Record<string, unknown>)[source]);
      return actionable.has(verdict);
    });

    if (survivors.length === names.length) return [a]; // every target still justifies it
    if (survivors.length === 0) return []; // verdict(s) flipped — drop the stale action

    // Partial survival: re-derive the canonical action(s) for the surviving
    // symbols so neither the target nor the description names the resolved ones.
    const survivingSymbols = survivors
      .map((n) => bySymbol.get(n))
      .filter((s): s is SymbolReview => s !== undefined);
    const rebuilt = groupIdenticalActions(synthesizeActionsFromSymbols(survivingSymbols, language))
      .filter((na) => na.source === source);
    // synthesize covers utility/duplication/overengineering/documentation; a
    // partial correction group (LLM-authored, never grouped) cannot be
    // re-derived, so fall back to keeping the original rather than dropping a
    // still-valid finding.
    return rebuilt.length > 0 ? rebuilt : [a];
  });

  // Re-ID sequentially so the review has stable, non-colliding action IDs.
  return reconciled.map((a, i) => ({ ...a, id: i + 1 }));
}
