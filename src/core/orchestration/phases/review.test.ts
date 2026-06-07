// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { selectFileEvaluators } from './review.js';
import type { AxisId } from '../../evaluation/index.js';

// The full enabled-axes set used for these cases. `evaluatorAxesForSkip`
// returns {correction, duplication, utility} for the 'trivial' reason and the
// empty set for barrel-export / type-only / constants-only.
const EVALUATORS: { id: AxisId }[] = [
  { id: 'correction' },
  { id: 'duplication' },
  { id: 'utility' },
  { id: 'overengineering' },
  { id: 'tests' },
  { id: 'best_practices' },
];

const ids = (evals: { id: AxisId }[]) => evals.map((e) => e.id).sort();

describe('selectFileEvaluators', () => {
  it('runs every stale evaluator when triage is disabled', () => {
    const out = selectFileEvaluators(EVALUATORS, ['correction', 'tests'], false, undefined);
    expect(ids(out)).toEqual(['correction', 'tests']);
  });

  it('runs every stale evaluator for a non-skip (evaluate) tier', () => {
    const out = selectFileEvaluators(EVALUATORS, ['tests'], true, { tier: 'evaluate', reason: '' });
    expect(ids(out)).toEqual(['tests']);
  });

  it('narrows a trivial skip-tier file to the stale ∩ partial-policy axes', () => {
    const out = selectFileEvaluators(
      EVALUATORS,
      ['correction', 'tests'], // tests is outside the trivial policy
      true,
      { tier: 'skip', reason: 'trivial' },
    );
    expect(ids(out)).toEqual(['correction']);
  });

  // The "9/10 never reaches 10/10" regression: a trivial skip-tier file whose
  // partial-policy axes (correction/duplication/utility) are ALL reusable from
  // cache, while a non-policy axis (tests) is stale. item.cached is false (a
  // stale axis exists), but no evaluator should run — so it must NOT be counted
  // toward the denominator, exactly as the handler takes the pure-skip path.
  it('returns no evaluators when a skip-tier file has only non-policy stale axes', () => {
    const out = selectFileEvaluators(
      EVALUATORS,
      ['tests', 'best_practices'], // both outside the trivial policy
      true,
      { tier: 'skip', reason: 'trivial' },
    );
    expect(out).toEqual([]);
  });

  it('returns no evaluators for a barrel-export skip (empty policy) even with stale axes', () => {
    const out = selectFileEvaluators(
      EVALUATORS,
      ['correction', 'tests'],
      true,
      { tier: 'skip', reason: 'barrel-export' },
    );
    expect(out).toEqual([]);
  });

  it('keeps only stale partial axes, dropping reusable ones, for a trivial skip', () => {
    // correction stale + duplication stale (both in policy), utility reusable.
    const out = selectFileEvaluators(
      EVALUATORS,
      ['correction', 'duplication'],
      true,
      { tier: 'skip', reason: 'trivial' },
    );
    expect(ids(out)).toEqual(['correction', 'duplication']);
  });
});
