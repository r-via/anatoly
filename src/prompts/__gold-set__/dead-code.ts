// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Dead code fixture — all exports are orphaned (never imported by any other file).
 * The utility axis should classify these as DEAD.
 */

/**
 * Formats a numeric amount as a localised currency string (en-US locale).
 * @param amount - The numeric value to format.
 * @param currency - ISO 4217 currency code, e.g. `'USD'` or `'EUR'`.
 * @returns Formatted string, e.g. `'$1,234.56'`.
 */
export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

/**
 * Converts a text string into a URL-friendly slug by lowercasing,
 * stripping special characters, and replacing whitespace with hyphens.
 * @param text - The input string to slugify.
 * @returns A lowercase, hyphen-separated slug string.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Creates a debounced version of a function that delays invocation until
 * after `delay` milliseconds have elapsed since the last call.
 * @typeParam T - The function type to debounce.
 * @param fn - The function to debounce.
 * @param delay - Delay in milliseconds before invoking `fn`.
 * @returns A debounced wrapper that resets its timer on each call.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export const MAX_RETRIES = 3;

export const DEFAULT_TIMEOUT_MS = 5000;
