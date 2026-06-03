// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { SymbolReview } from '../../../schemas/review.js';

/**
 * Recompute a file's verdict from its symbol data (mirrors axis-merger logic).
 * Shared by tier1 and tier2, which both recompute the verdict after mutating
 * symbols and previously carried byte-identical copies of this.
 */
export function computeVerdict(symbols: SymbolReview[]): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
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
