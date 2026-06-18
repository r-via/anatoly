// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { dirname } from 'node:path';
import type { ReviewFile, SymbolReview } from '../../../schemas/review.js';
import { setAxisSegment, getAxisSegmentText } from './detail-segment.js';
import { computeVerdict } from './verdict.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalatedFinding {
  /** Project-relative file path. */
  file: string;
  /** Symbol name with the finding. */
  symbolName: string;
  /** Axis that produced the finding. */
  axis: string;
  /** Axis value (e.g. 'ERROR', 'NEEDS_FIX', 'DEAD'). */
  value: string;
  /** Reason for escalation to tier 3. */
  reason: string;
  /**
   * Self-contained detail for findings that have no per-symbol review entry to
   * look up (e.g. file-level best_practices rules, keyed by rule name rather
   * than a real symbol). When set, tier 3 uses it directly in the prompt.
   */
  detail?: string;
}

export interface Tier2Stats {
  /** Number of findings resolved by coherence rules. */
  resolved: number;
  /** Number of findings escalated to tier 3. */
  escalated: number;
}

export interface Tier2Result {
  review: ReviewFile;
  escalated: EscalatedFinding[];
  stats: Tier2Stats;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOW_CONFIDENCE_THRESHOLD = 75;
const SYSTEMIC_DEAD_THRESHOLD = 10;

/** Keywords that indicate behavioral / config changes — should be investigated by tier 3. */
const BEHAVIORAL_KEYWORDS = [
  'default', 'config', 'configuration', 'fallback', 'threshold',
  'timeout', 'limit', 'flag', 'toggle', 'env', 'environment',
  'setting', 'preference', 'option',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply tier 2 inter-axis coherence rules to a ReviewFile.
 *
 * Resolves contradictions between axes (e.g. DEAD + NEEDS_FIX is moot)
 * and escalates ambiguous findings to tier 3 for agentic investigation.
 *
 * Deterministic rules (no LLM needed for the enumerated patterns):
 * - DEAD + NEEDS_FIX → correction = OK
 * - DEAD + OVER → overengineering = skip
 * - DEAD + WEAK/NONE → tests = skip
 * - DEAD + UNDOCUMENTED → documentation = skip
 * - DEAD + DUPLICATE → **kept**. A dead symbol that duplicates a live
 *   one is the most actionable shape of dead code: the maintainer
 *   knows where the surviving copy lives and can delete the dead
 *   one without losing functionality. Suppressing it strips the
 *   single fact that makes the cleanup safe.
 * - ERROR → always escalated to tier 3
 * - NEEDS_FIX isolated → escalated regardless of confidence. Isolation
 *   (no other axis corroborates) is a stronger FP signal than the
 *   evaluator's own confidence: a single axis flagging a symbol at
 *   80-90% with no support from utility/duplication/overeng/tests/docs
 *   is precisely the shape of an over-confident hallucination. The
 *   previous `< 75` cap left this band unreviewed and accounted for
 *   the bulk of high-severity false positives surviving to the report.
 * - Behavioral/config changes → escalated
 *
 * Returns a new ReviewFile (input not mutated).
 */
export async function applyTier2(review: ReviewFile): Promise<Tier2Result> {
  const stats: Tier2Stats = { resolved: 0, escalated: 0 };
  const escalated: EscalatedFinding[] = [];

  const newSymbols = review.symbols.map((sym) => {
    const s = { ...sym };

    // --- Escalation: flow axis (deterministic graph facts) ---
    // Hoisted above every coherence rule because a flow finding is independent
    // of the per-symbol axes: the DEAD coherence block below returns early, and
    // the six dead orphans are exactly the dual-anchored unwired_flow cases, so
    // escalating flow after that return would never fire for them. Per the
    // deliberation engagement (doc 05), escalation is selective: only the
    // FP-prone natures (`unwired_flow`, which leans on usage-graph completeness)
    // and low-confidence resolutions warrant an Opus check; high-confidence
    // structural facts (over_indirect, redundant_flow, ...) are confirmed by the
    // deterministic proof itself.
    if (s.flow === 'NEEDS_FIX' && shouldEscalateFlow(s)) {
      escalated.push({
        file: review.file,
        symbolName: s.name,
        axis: 'flow',
        value: 'NEEDS_FIX',
        reason: flowEscalationReason(s),
      });
      stats.escalated++;
    }

    // --- Rule: ERROR → always escalate (never auto-resolve) ---
    if (s.correction === 'ERROR') {
      escalated.push({
        file: review.file,
        symbolName: s.name,
        axis: 'correction',
        value: 'ERROR',
        reason: 'ERROR findings always require tier 3 investigation',
      });
      stats.escalated++;
    }

    // --- Coherence: DEAD + other findings → moot ---
    // Dead code does not need correctness fixes, complexity reductions,
    // tests, or documentation — those axes are silenced. Duplication is
    // explicitly NOT silenced: knowing that a dead symbol duplicates a
    // live one tells the maintainer where the surviving copy lives, so
    // the dead one can be removed without losing functionality. That is
    // exactly the action the bench wants surfaced (cf. DUP-PAYOUT on
    // legacy.ts → engine.ts in the slot-engine fixture).
    if (s.utility === 'DEAD') {
      if (s.correction === 'NEEDS_FIX') {
        const originalText = getAxisSegmentText(s.detail, 'NEEDS_FIX');
        const newText = originalText
          ? `Moot — symbol is DEAD (was NEEDS_FIX: ${originalText})`
          : 'Moot — symbol is DEAD';
        s.correction = 'OK';
        s.detail = setAxisSegment(s.detail, 'NEEDS_FIX', 'OK', newText);
        stats.resolved++;
      }
      if (s.overengineering === 'OVER') {
        s.overengineering = '-';
        stats.resolved++;
      }
      // Intentionally preserve s.duplication and s.duplicate_target.
      if (s.tests === 'WEAK' || s.tests === 'NONE') {
        s.tests = '-';
        stats.resolved++;
      }
      if (s.documentation === 'UNDOCUMENTED' || s.documentation === 'PARTIAL') {
        s.documentation = '-';
        stats.resolved++;
      }
      return s;
    }

    // --- Coherence: LOW_VALUE + OVER/UNDOCUMENTED → moot ---
    if (s.utility === 'LOW_VALUE') {
      if (s.overengineering === 'OVER') {
        s.overengineering = '-';
        stats.resolved++;
      }
      if (s.documentation === 'UNDOCUMENTED' || s.documentation === 'PARTIAL') {
        s.documentation = '-';
        stats.resolved++;
      }
    }

    const correctionAlreadyEscalated = (): boolean =>
      escalated.some((e) => e.file === review.file && e.symbolName === s.name && e.axis === 'correction');

    // --- Escalation: Behavioral/config change detection (more informative
    // reason than "isolated") — check before the isolated rule so the
    // behavioral label wins when both apply. ---
    if (s.correction === 'NEEDS_FIX' && isBehavioralChange(s.detail) && !correctionAlreadyEscalated()) {
      escalated.push({
        file: review.file,
        symbolName: s.name,
        axis: 'correction',
        value: 'NEEDS_FIX',
        reason: 'Behavioral change — needs investigation',
      });
      stats.escalated++;
    }

    // --- Escalation: Isolated NEEDS_FIX (any confidence) ---
    // Isolation = no other axis corroborates. That signal beats the
    // evaluator's self-reported confidence at predicting false positives,
    // so we escalate the whole NEEDS_FIX band, not just conf < 75.
    if (s.correction === 'NEEDS_FIX' && isIsolatedFinding(s) && !correctionAlreadyEscalated()) {
      const band = s.confidence < LOW_CONFIDENCE_THRESHOLD ? 'low' : 'high';
      escalated.push({
        file: review.file,
        symbolName: s.name,
        axis: 'correction',
        value: 'NEEDS_FIX',
        reason: `Isolated ${band}-confidence finding (confidence: ${s.confidence})`,
      });
      stats.escalated++;
    }

    // NOTE: invariant findings (the invariants pipeline phase) are deliberately
    // NOT escalated to tier 3 here. Tier 3 reclassifies the DELIBERATION_AXES
    // (the six LLM axes plus flow) and prunes `sym.findings`; it has no path to
    // read or clear `sym.invariant_findings`, so escalating one would burn a
    // tier-3 call without any ability to overturn it — a false safety layer.
    // The invariants phase's own adversarial judge (same-quantity AND
    // disagreement required, default-to-no-finding, confidence floor) is the
    // precision gate; a real deliberation-overturn path is a future increment.

    return s;
  });

  // --- File-level escalation: best_practices rules ---
  // best_practices is LLM-produced and has no per-symbol verdict; it lives on
  // review.best_practices as a list of rules. Per the deliberation engagement
  // (doc 05), it is eligible for arbitration via the file-level channel: each
  // FAILED rule is escalated keyed by its rule name (WARN is advisory and left
  // as-is to bound cost). Tier 3 verifies the rule against the source and may
  // reclassify it; applyDeliberation writes the result back onto the rules.
  if (review.best_practices) {
    for (const rule of review.best_practices.rules) {
      if (rule.status !== 'FAIL') continue;
      escalated.push({
        file: review.file,
        symbolName: rule.rule_name,
        axis: 'best_practices',
        value: 'FAIL',
        reason: `Best-practice rule failed${rule.lines ? ` (lines ${rule.lines})` : ''} — verify against the source`,
        detail: rule.detail ?? rule.rule_name,
      });
      stats.escalated++;
    }
  }

  const newVerdict = computeVerdict(newSymbols);

  return {
    review: { ...review, symbols: newSymbols, verdict: newVerdict },
    escalated,
    stats,
  };
}

/**
 * Detect cross-file systemic patterns across multiple ReviewFiles.
 *
 * Currently detects: modules with > 10 DEAD symbols, which suggests
 * the entire module may be deprecated rather than individual symbols.
 */
export function detectCrossFilePatterns(reviews: ReviewFile[]): EscalatedFinding[] {
  const escalated: EscalatedFinding[] = [];

  // Group DEAD symbols by parent directory (module)
  const deadByModule = new Map<string, { file: string; symbol: string }[]>();

  for (const review of reviews) {
    for (const sym of review.symbols) {
      if (sym.utility === 'DEAD') {
        const dir = dirname(review.file);
        const entries = deadByModule.get(dir) ?? [];
        entries.push({ file: review.file, symbol: sym.name });
        deadByModule.set(dir, entries);
      }
    }
  }

  for (const [module, entries] of deadByModule) {
    if (entries.length > SYSTEMIC_DEAD_THRESHOLD) {
      escalated.push({
        file: module,
        symbolName: '*',
        axis: 'utility',
        value: 'DEAD',
        reason: `Systemic pattern: ${entries.length} DEAD symbols in ${module}`,
      });
    }
  }

  return escalated;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Check if a symbol's finding is "isolated" — correction has a finding
 * but no other axis does.
 */
function isIsolatedFinding(sym: SymbolReview): boolean {
  return (
    sym.utility === 'USED' &&
    sym.duplication === 'UNIQUE' &&
    sym.overengineering === 'LEAN' &&
    (sym.tests === 'GOOD' || sym.tests === '-') &&
    (sym.documentation === 'DOCUMENTED' || sym.documentation === '-')
  );
}

/**
 * Detect if a finding's detail suggests a behavioral/config change
 * that requires human or agentic investigation.
 */
function isBehavioralChange(detail: string): boolean {
  const lower = detail.toLowerCase();
  return BEHAVIORAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Flow finding natures whose precision leans on usage-graph completeness, so a
 * tier-3 read of the real source can catch a static-analysis false positive. */
const FP_PRONE_FLOW_NATURES = ['unwired_flow'] as const;

/** Extract the flow finding nature from the merged detail string (the flow axis
 * prefixes its rationale with the nature, e.g. `unwired_flow: ...`). */
function flowNature(detail: string): string | undefined {
  return detail.match(/\b(unwired_flow|redundant_flow|inconsistent_siblings|over_indirect|effect_asymmetry)\b/)?.[1];
}

/**
 * Whether a flow NEEDS_FIX should be escalated to tier 3. Escalate FP-prone
 * natures (regardless of confidence) and any flow whose resolution confidence
 * is low; leave clean high-confidence structural facts deterministically
 * confirmed. See the deliberation engagement (doc 05).
 */
function shouldEscalateFlow(sym: SymbolReview): boolean {
  const nature = flowNature(sym.detail);
  if (nature && (FP_PRONE_FLOW_NATURES as readonly string[]).includes(nature)) return true;
  return sym.confidence < LOW_CONFIDENCE_THRESHOLD;
}

/** Human-readable escalation reason for a flow finding. */
function flowEscalationReason(sym: SymbolReview): string {
  const nature = flowNature(sym.detail);
  if (nature && (FP_PRONE_FLOW_NATURES as readonly string[]).includes(nature)) {
    return `FP-prone flow nature (${nature}) — verify the usage graph against real callers`;
  }
  return `Low-confidence flow resolution (confidence: ${sym.confidence})`;
}

