// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Fixture module for the orchestration handoff golden. Nothing imports these
 * exports, so the usage graph resolves each as DEAD without any LLM call
 * (UtilityEvaluator auto-resolves exported, zero-importer symbols). That
 * makes the run hermetic AND produces non-zero handoff values
 * (filesReviewed / evaluated / findings) that the golden constrains.
 *
 * Do not import this anywhere. Do not "fix" the dead code: the DEAD verdicts
 * are the point.
 */

export function unusedAlpha(a: number, b: number): number {
  const scaled = a * 2 + b;
  return scaled > 0 ? scaled : 0;
}

export function unusedBeta(items: string[]): string {
  return items.filter((x) => x.length > 0).join(',');
}
