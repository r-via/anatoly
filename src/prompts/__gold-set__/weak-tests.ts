// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: tests axis — a module with only superficial, happy-path
 * tests that miss edge cases, error paths, and boundary conditions.
 *
 * The "test file" is embedded as a comment block below so the LLM can see
 * what tests exist for these functions.
 */

// ---------------------------------------------------------------------------
// Source: divide and formatList
// ---------------------------------------------------------------------------

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error('Division by zero');
  }
  return a / b;
}

export function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Existing tests (WEAK): only happy path, no edge cases
// ---------------------------------------------------------------------------
//
//   describe('divide', () => {
//     it('divides two numbers', () => {
//       expect(divide(10, 2)).toBe(5);
//     });
//   });
//
//   describe('formatList', () => {
//     it('formats a list of three items', () => {
//       expect(formatList(['a', 'b', 'c'])).toBe('a, b, and c');
//     });
//   });
//
// Missing: divide-by-zero, negative numbers, NaN, Infinity,
//          empty array, single item, two items, large arrays,
//          items with special characters.
// ---------------------------------------------------------------------------
