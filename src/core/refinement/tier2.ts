// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { dirname } from 'node:path';
import type { ReviewFile, SymbolReview } from '../../schemas/review.js';

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
 * - DEAD + DUPLICATE → duplication = skip
 * - DEAD + WEAK/NONE → tests = skip
 * - DEAD + UNDOCUMENTED → documentation = skip
 * - ERROR → always escalated to tier 3
 * - NEEDS_FIX confidence < 75 isolated → escalated
 * - Behavioral/config changes → escalated
 *
 * Returns a new ReviewFile (input not mutated).
 */
export async function applyTier2(review: ReviewFile): Promise<Tier2Result> {
  const stats: Tier2Stats = { resolved: 0, escalated: 0 };
  const escalated: EscalatedFinding[] = [];

  const newSymbols = review.symbols.map((sym) => {
    const s = { ...sym };

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
    if (s.utility === 'DEAD') {
      if (s.correction === 'NEEDS_FIX') {
        s.correction = 'OK';
        s.detail = `Moot — symbol is DEAD | ${s.detail}`;
        stats.resolved++;
      }
      if (s.overengineering === 'OVER' || s.overengineering === 'ACCEPTABLE') {
        s.overengineering = '-';
        stats.resolved++;
      }
      if (s.duplication === 'DUPLICATE') {
        s.duplication = '-';
        stats.resolved++;
      }
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
      if (s.overengineering === 'OVER' || s.overengineering === 'ACCEPTABLE') {
        s.overengineering = '-';
        stats.resolved++;
      }
      if (s.documentation === 'UNDOCUMENTED' || s.documentation === 'PARTIAL') {
        s.documentation = '-';
        stats.resolved++;
      }
    }

    // --- Escalation: Low confidence isolated NEEDS_FIX ---
    if (
      s.correction === 'NEEDS_FIX' &&
      s.confidence < LOW_CONFIDENCE_THRESHOLD &&
      isIsolatedFinding(s)
    ) {
      escalated.push({
        file: review.file,
        symbolName: s.name,
        axis: 'correction',
        value: 'NEEDS_FIX',
        reason: `Low confidence isolated finding (confidence: ${s.confidence})`,
      });
      stats.escalated++;
    }

    // --- Escalation: Behavioral/config change detection ---
    if (s.correction === 'NEEDS_FIX' && isBehavioralChange(s.detail)) {
      // Don't double-count if already escalated as isolated
      const alreadyEscalated = escalated.some(
        (e) => e.file === review.file && e.symbolName === s.name && e.axis === 'correction',
      );
      if (!alreadyEscalated) {
        escalated.push({
          file: review.file,
          symbolName: s.name,
          axis: 'correction',
          value: 'NEEDS_FIX',
          reason: 'Behavioral change — needs investigation',
        });
        stats.escalated++;
      }
    }

    return s;
  });

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

/**
 * Recompute file verdict from symbol data (mirrors axis-merger logic).
 */
function computeVerdict(symbols: SymbolReview[]): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
  const CONFIDENCE_THRESHOLD = 60;

  for (const s of symbols) {
    if (s.confidence < CONFIDENCE_THRESHOLD) continue;
    if (s.correction === 'ERROR') return 'CRITICAL';
  }

  for (const s of symbols) {
    if (s.confidence < CONFIDENCE_THRESHOLD) continue;
    if (s.correction === 'NEEDS_FIX') return 'NEEDS_REFACTOR';
    if (s.utility === 'DEAD') return 'NEEDS_REFACTOR';
    if (s.duplication === 'DUPLICATE') return 'NEEDS_REFACTOR';
    if (s.overengineering === 'OVER') return 'NEEDS_REFACTOR';
    if (s.exported && s.documentation === 'UNDOCUMENTED') return 'NEEDS_REFACTOR';
  }

  return 'CLEAN';
}
