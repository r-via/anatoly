// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The unit harness implementation (doc 14 §4). The single chokepoint every
 * agent flows through. Relocated verbatim from `evaluation/evaluator.ts` in
 * doc 14 PR 3a (see `./contract.ts` for why this is its own zero-dependency
 * context).
 *
 * Pure pass-through today (behaviour-preserving by construction): PR 2a
 * routes the single-turn axes through it; PR 3 brings the doc and refinement
 * agents; PR 2b folded the per-axis cost (harness-owned `recordAgentCosts`);
 * the sink / event emission / cost folding land on this seam in later PRs.
 */

import type { ExecutionUnit, HarnessCtx } from './contract.js';

export async function runUnit<I, O>(unit: ExecutionUnit<I, O>, input: I, h: HarnessCtx): Promise<O> {
  return unit.run(input, h);
}
