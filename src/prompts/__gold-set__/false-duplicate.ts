// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * False-duplicate fixture — two functions with similar structure
 * (iterate, accumulate, return) but completely different semantics.
 * The duplication axis should mark both as UNIQUE.
 */

/**
 * Calculate the arithmetic mean of a numeric array.
 * @param values - Array of numbers to average
 * @returns The arithmetic mean, or 0 if the array is empty
 */
export function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;

  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Concatenate an array of path segments into a single path string.
 * Handles leading/trailing slashes and normalizes separators.
 */
export function joinPath(segments: string[]): string {
  if (segments.length === 0) return '';

  let result = segments[0].replace(/\/+$/, '');
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].replace(/^\/+/, '').replace(/\/+$/, '');
    result += '/' + segment;
  }
  return result;
}
