// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: duplication axis — two functions that are genuine
 * duplicates (same logic, same semantics, different names). Both should
 * be classified as DUPLICATE.
 */

// ---------------------------------------------------------------------------
// DUPLICATE pair: findMax and getHighestValue do the exact same thing
// ---------------------------------------------------------------------------

/**
 * Returns the maximum value from an array of numbers.
 * Throws if the array is empty.
 */
export function findMax(numbers: number[]): number {
  if (numbers.length === 0) {
    throw new Error('Cannot find max of empty array');
  }
  let max = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] > max) {
      max = numbers[i];
    }
  }
  return max;
}

/**
 * Returns the highest value from a list of numbers.
 * Throws if the list is empty.
 */
export function getHighestValue(values: number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot get highest value of empty array');
  }
  let highest = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > highest) {
      highest = values[i];
    }
  }
  return highest;
}
