// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: correction axis — mix of clean code (OK), a logic bug
 * (NEEDS_FIX), and a critical crash (ERROR).
 */

// ---------------------------------------------------------------------------
// OK — correct, no issues
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`min (${min}) must be <= max (${max})`);
  }
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// NEEDS_FIX — off-by-one: should be `i < arr.length` not `i <= arr.length`
// ---------------------------------------------------------------------------

export function sumArray(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i]; // reads undefined on last iteration → NaN propagation
  }
  return total;
}

// ---------------------------------------------------------------------------
// ERROR — unchecked JSON.parse on user input, crashes on invalid JSON
// ---------------------------------------------------------------------------

export function parseUserPayload(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw); // throws on malformed input — no try/catch
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  // Mutates prototype — prototype pollution vulnerability
  for (const [key, value] of Object.entries(parsed)) {
    Object.defineProperty(parsed, key, { value, writable: false });
  }
  return parsed;
}
