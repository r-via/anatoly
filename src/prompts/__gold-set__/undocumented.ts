// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: documentation axis — one well-documented function
 * (DOCUMENTED) and one completely undocumented function (UNDOCUMENTED).
 */

// ---------------------------------------------------------------------------
// DOCUMENTED — full JSDoc with params, returns, throws, and example
// ---------------------------------------------------------------------------

/**
 * Computes the weighted average of a set of values.
 *
 * Each entry pairs a numeric value with its weight. Weights must be positive
 * and at least one entry is required.
 *
 * @param entries - Array of `[value, weight]` tuples.
 * @returns The weighted average.
 * @throws {RangeError} If `entries` is empty or any weight is ≤ 0.
 *
 * @example
 * ```ts
 * weightedAverage([[90, 0.6], [80, 0.4]]); // → 86
 * ```
 */
export function weightedAverage(entries: [number, number][]): number {
  if (entries.length === 0) {
    throw new RangeError('At least one entry is required');
  }
  let sumProduct = 0;
  let sumWeight = 0;
  for (const [value, weight] of entries) {
    if (weight <= 0) {
      throw new RangeError(`Weight must be positive, got ${weight}`);
    }
    sumProduct += value * weight;
    sumWeight += weight;
  }
  return sumProduct / sumWeight;
}

// ---------------------------------------------------------------------------
// UNDOCUMENTED — no JSDoc, non-obvious parameter names, unclear purpose
// ---------------------------------------------------------------------------

export function proc(
  xs: Map<string, number[]>,
  thr: number,
  mode: 'avg' | 'max',
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, vs] of xs) {
    const filtered = vs.filter((v) => v >= thr);
    if (filtered.length === 0) continue;
    const val =
      mode === 'max'
        ? Math.max(...filtered)
        : filtered.reduce((a, b) => a + b, 0) / filtered.length;
    out.set(k, val);
  }
  return out;
}
