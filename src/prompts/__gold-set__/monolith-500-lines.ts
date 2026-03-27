// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Data Transformation Utilities
 *
 * A collection of general-purpose utility functions for transforming,
 * validating, and manipulating data structures. Designed for use across
 * service layers where raw data must be normalized, paginated, or
 * otherwise reshaped before consumption.
 */

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * Configuration for the `retry` function. Controls how many attempts are
 * made, the initial delay between retries, and the maximum delay cap.
 */
export interface RetryOptions {
  /** Maximum number of attempts (must be >= 1). */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelayMs: number;
  /** Upper bound on the delay between retries in milliseconds. */
  maxDelayMs: number;
  /**
   * Optional predicate that receives the error from a failed attempt.
   * Return `true` to allow the retry to proceed, or `false` to bail
   * out immediately. Defaults to always retrying.
   */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Result wrapper returned by `paginate`. Contains the current page of
 * data along with metadata needed to render pagination controls.
 */
export interface PaginateResult<T> {
  /** The slice of items for the requested page. */
  data: T[];
  /** Total number of items in the full dataset. */
  total: number;
  /** The 1-based page number that was requested. */
  page: number;
  /** Total number of pages given the requested page size. */
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Object Utilities
// ---------------------------------------------------------------------------

/**
 * Creates a deep clone of the provided value using the platform-native
 * `structuredClone` API. This correctly handles nested objects, arrays,
 * Maps, Sets, Dates, RegExps, and other structured-cloneable types.
 *
 * @param obj - The value to clone.
 * @returns A deeply-cloned copy of `obj`.
 * @throws {DOMException} If `obj` contains non-cloneable values such as
 *   functions, DOM nodes, or `SharedArrayBuffer` instances.
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  try {
    return structuredClone(obj);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error during structured clone';
    throw new Error(
      `deepClone failed: ${message}. Ensure the value does not contain ` +
        'functions, DOM nodes, or other non-cloneable types.',
    );
  }
}

/**
 * Returns a new object containing only the specified keys from the
 * source object. Keys that do not exist on `obj` are silently ignored.
 *
 * @param obj  - The source object.
 * @param keys - An array of keys to retain.
 * @returns A new object with only the picked keys.
 */
export function pick<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T> {
  if (obj === null || obj === undefined) {
    throw new TypeError('pick: source object must not be null or undefined');
  }

  const result: Partial<T> = {};

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }

  return result;
}

/**
 * Returns a new object with the specified keys removed. All other
 * own-enumerable properties are copied into the result.
 *
 * @param obj  - The source object.
 * @param keys - An array of keys to exclude.
 * @returns A new object without the omitted keys.
 */
export function omit<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T> {
  if (obj === null || obj === undefined) {
    throw new TypeError('omit: source object must not be null or undefined');
  }

  const exclusionSet = new Set<keyof T>(keys);
  const result: Partial<T> = {};

  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (!exclusionSet.has(key)) {
      result[key] = obj[key];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Array Utilities
// ---------------------------------------------------------------------------

/**
 * Groups the elements of an array into a record keyed by the string
 * representation of the specified property. Each key maps to an array
 * of all elements whose property matches that key.
 *
 * @param arr - The array to group.
 * @param key - The property name to group by.
 * @returns A record mapping each distinct key value to its group.
 */
export function groupBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): Record<string, T[]> {
  if (!Array.isArray(arr)) {
    throw new TypeError('groupBy: first argument must be an array');
  }

  const groups: Record<string, T[]> = {};

  for (const item of arr) {
    const groupKey = String(item[key]);

    if (groups[groupKey] === undefined) {
      groups[groupKey] = [];
    }

    groups[groupKey].push(item);
  }

  return groups;
}

/**
 * Splits an array into sub-arrays (chunks) of the given size. The last
 * chunk may contain fewer than `size` elements if the array length is
 * not evenly divisible.
 *
 * @param arr  - The array to split.
 * @param size - The maximum number of elements per chunk (must be >= 1).
 * @returns An array of chunks.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (!Array.isArray(arr)) {
    throw new TypeError('chunk: first argument must be an array');
  }

  if (!Number.isFinite(size) || size < 1) {
    throw new RangeError('chunk: size must be a finite number >= 1');
  }

  const intSize = Math.floor(size);
  const chunks: T[][] = [];

  for (let i = 0; i < arr.length; i += intSize) {
    chunks.push(arr.slice(i, i + intSize));
  }

  return chunks;
}

/**
 * Flattens one level of array nesting. Elements that are themselves
 * arrays are spread into the result; all other elements are kept as-is.
 *
 * @param arr - The array to flatten.
 * @returns A new array with one level of nesting removed.
 */
export function flatten<T>(arr: (T | T[])[]): T[] {
  if (!Array.isArray(arr)) {
    throw new TypeError('flatten: argument must be an array');
  }

  const result: T[] = [];

  for (const element of arr) {
    if (Array.isArray(element)) {
      for (const inner of element) {
        result.push(inner);
      }
    } else {
      result.push(element);
    }
  }

  return result;
}

/**
 * Removes duplicate elements from an array based on the value of the
 * specified key. When duplicates exist, the first occurrence is kept
 * and subsequent ones are discarded.
 *
 * @param arr - The array to deduplicate.
 * @param key - The property whose value determines uniqueness.
 * @returns A new array with duplicates removed.
 */
export function uniqueBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): T[] {
  if (!Array.isArray(arr)) {
    throw new TypeError('uniqueBy: first argument must be an array');
  }

  const seen = new Set<unknown>();
  const result: T[] = [];

  for (const item of arr) {
    const value = item[key];

    if (!seen.has(value)) {
      seen.add(value);
      result.push(item);
    }
  }

  return result;
}

/**
 * Returns a sorted copy of the array based on the value of the given
 * key. Supports ascending (default) and descending order. The original
 * array is not mutated.
 *
 * @param arr   - The array to sort.
 * @param key   - The property to sort by.
 * @param order - Sort direction: `'asc'` (default) or `'desc'`.
 * @returns A new sorted array.
 */
export function sortBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
  order: 'asc' | 'desc' = 'asc',
): T[] {
  if (!Array.isArray(arr)) {
    throw new TypeError('sortBy: first argument must be an array');
  }

  const copy = [...arr];
  const direction = order === 'desc' ? -1 : 1;

  copy.sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];

    if (aVal === bVal) {
      return 0;
    }

    if (aVal === null || aVal === undefined) {
      return 1;
    }

    if (bVal === null || bVal === undefined) {
      return -1;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return direction * aVal.localeCompare(bVal);
    }

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return direction * (aVal - bVal);
    }

    return direction * (String(aVal) < String(bVal) ? -1 : 1);
  });

  return copy;
}

/**
 * Paginates an array by returning the slice of data corresponding to
 * the requested 1-based page number and page size. Also provides
 * metadata for rendering pagination controls.
 *
 * @param arr  - The full array of items.
 * @param page - The 1-based page number to retrieve.
 * @param size - The number of items per page (must be >= 1).
 * @returns An object containing the page data and pagination metadata.
 */
export function paginate<T>(
  arr: T[],
  page: number,
  size: number,
): PaginateResult<T> {
  if (!Array.isArray(arr)) {
    throw new TypeError('paginate: first argument must be an array');
  }

  if (!Number.isFinite(page)) {
    throw new RangeError('paginate: page must be a finite number');
  }

  if (!Number.isFinite(size) || size < 1) {
    throw new RangeError('paginate: size must be a finite number >= 1');
  }

  const intSize = Math.floor(size);
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / intSize));
  const normalizedPage = Math.max(1, Math.min(Math.floor(page), totalPages));
  const startIndex = (normalizedPage - 1) * intSize;
  const data = arr.slice(startIndex, startIndex + intSize);

  return {
    data,
    total,
    page: normalizedPage,
    totalPages,
  };
}

// ---------------------------------------------------------------------------
// Async Utilities
// ---------------------------------------------------------------------------

/**
 * Retries an asynchronous function with exponential backoff. The delay
 * between attempts doubles after each failure, capped at `maxDelayMs`.
 * An optional `shouldRetry` predicate can short-circuit retries for
 * errors that are not transient (e.g. 4xx HTTP responses).
 *
 * @param fn   - The async function to execute. Called with no arguments.
 * @param opts - Configuration controlling retry behaviour.
 * @returns The resolved value of `fn` on a successful attempt.
 * @throws The error from the final failed attempt if all retries are
 *   exhausted, or immediately if `shouldRetry` returns `false`.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    shouldRetry = () => true,
  } = opts;

  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('retry: maxAttempts must be a finite number >= 1');
  }

  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new RangeError(
      'retry: initialDelayMs must be a finite non-negative number',
    );
  }

  let lastError: unknown;
  let currentDelay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error: unknown) {
      lastError = error;

      if (!shouldRetry(error)) {
        throw error;
      }

      if (attempt < maxAttempts) {
        const jitter = Math.random() * currentDelay * 0.1;
        const delayWithJitter = Math.min(currentDelay + jitter, maxDelayMs);

        await new Promise<void>((resolve) =>
          setTimeout(resolve, delayWithJitter),
        );

        currentDelay = Math.min(currentDelay * 2, maxDelayMs);
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Memoization
// ---------------------------------------------------------------------------

/**
 * Returns a memoized version of the provided function. Results are
 * cached in a `Map` keyed by the JSON-serialized arguments. Subsequent
 * calls with the same arguments return the cached result without
 * invoking the original function.
 *
 * **Caveat:** argument serialization uses `JSON.stringify`, so functions
 * whose arguments include circular references, `undefined` values, or
 * non-deterministic key ordering may produce unexpected cache behaviour.
 *
 * @param fn - The function to memoize.
 * @returns A memoized wrapper with the same signature as `fn`.
 */
export function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const cache = new Map<string, unknown>();

  const memoized = function (this: unknown, ...args: unknown[]): unknown {
    let cacheKey: string;

    try {
      cacheKey = JSON.stringify(args);
    } catch {
      // If serialization fails (e.g. circular references), skip the cache
      // and call the original function directly.
      return fn.apply(this, args);
    }

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const result = fn.apply(this, args);
    cache.set(cacheKey, result);

    return result;
  } as unknown as T;

  return memoized;
}

// ---------------------------------------------------------------------------
// String Utilities
// ---------------------------------------------------------------------------

/**
 * Truncates a string to the specified maximum length. If the string
 * exceeds `maxLen`, it is cut and the `suffix` (default `"..."`) is
 * appended. The total length of the returned string will never exceed
 * `maxLen`.
 *
 * @param str    - The string to truncate.
 * @param maxLen - Maximum allowed length of the returned string.
 * @param suffix - The suffix to append when truncation occurs. Defaults
 *   to `"..."`.
 * @returns The original string if it fits, or a truncated version with
 *   the suffix appended.
 */
export function truncate(
  str: string,
  maxLen: number,
  suffix: string = '...',
): string {
  if (typeof str !== 'string') {
    throw new TypeError('truncate: first argument must be a string');
  }

  if (!Number.isFinite(maxLen) || maxLen < 0) {
    throw new RangeError(
      'truncate: maxLen must be a finite non-negative number',
    );
  }

  if (str.length <= maxLen) {
    return str;
  }

  if (suffix.length >= maxLen) {
    return suffix.slice(0, maxLen);
  }

  const cutLength = maxLen - suffix.length;
  return str.slice(0, cutLength) + suffix;
}

/**
 * Converts a camelCase or PascalCase string to snake_case. Consecutive
 * uppercase letters are treated as acronyms (e.g. `"parseJSON"` becomes
 * `"parse_json"`).
 *
 * @param str - The camelCase / PascalCase string to convert.
 * @returns The snake_case equivalent.
 */
export function camelToSnake(str: string): string {
  if (typeof str !== 'string') {
    throw new TypeError('camelToSnake: argument must be a string');
  }

  if (str.length === 0) {
    return str;
  }

  let result = '';
  let prevWasUpper = false;
  let prevWasUnderscore = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const isUpper = char >= 'A' && char <= 'Z';
    const nextIsLower =
      i + 1 < str.length && str[i + 1] >= 'a' && str[i + 1] <= 'z';

    if (isUpper) {
      // Insert underscore before an uppercase letter when:
      //   - It is not the first character
      //   - The previous character was not already an underscore
      //   - Either the previous character was lowercase, or the next is lowercase
      //     (to handle acronyms like "parseJSON" -> "parse_json")
      if (
        result.length > 0 &&
        !prevWasUnderscore &&
        (!prevWasUpper || nextIsLower)
      ) {
        result += '_';
      }

      result += char.toLowerCase();
      prevWasUpper = true;
      prevWasUnderscore = false;
    } else {
      result += char;
      prevWasUpper = false;
      prevWasUnderscore = char === '_';
    }
  }

  return result;
}

/**
 * Converts a snake_case string to camelCase. Leading underscores are
 * preserved, and consecutive underscores are collapsed into a single
 * boundary.
 *
 * @param str - The snake_case string to convert.
 * @returns The camelCase equivalent.
 */
export function snakeToCamel(str: string): string {
  if (typeof str !== 'string') {
    throw new TypeError('snakeToCamel: argument must be a string');
  }

  if (str.length === 0) {
    return str;
  }

  const parts = str.split('_');
  let result = '';
  let leadingUnderscores = '';

  // Count leading underscores directly from the original string
  let leadingCount = 0;
  while (leadingCount < str.length && str[leadingCount] === '_') {
    leadingCount++;
  }
  leadingUnderscores = '_'.repeat(leadingCount);

  // Skip the corresponding empty segments from split
  let startIndex = leadingCount;

  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i];

    if (part.length === 0) {
      // Skip empty segments caused by consecutive underscores
      continue;
    }

    if (i === startIndex) {
      // First meaningful segment stays lowercase
      result += part.toLowerCase();
    } else {
      // Subsequent segments are capitalised
      result +=
        part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }
  }

  return leadingUnderscores + result;
}

// ---------------------------------------------------------------------------
// URL / Query String Utilities
// ---------------------------------------------------------------------------

/**
 * Parses a URL query string into a plain object. Handles strings with
 * or without a leading `"?"`. Duplicate keys are resolved by keeping
 * the last occurrence. Keys and values are URI-decoded.
 *
 * @param qs - The query string to parse (e.g. `"?foo=1&bar=hello"`).
 * @returns A record mapping each parameter name to its decoded value.
 */
export function parseQueryString(qs: string): Record<string, string> {
  if (typeof qs !== 'string') {
    throw new TypeError('parseQueryString: argument must be a string');
  }

  const cleaned = qs.startsWith('?') ? qs.slice(1) : qs;

  if (cleaned.length === 0) {
    return {};
  }

  const result: Record<string, string> = {};
  const pairs = cleaned.split('&');

  for (const pair of pairs) {
    if (pair.length === 0) {
      continue;
    }

    const equalIndex = pair.indexOf('=');

    let rawKey: string;
    let rawValue: string;

    if (equalIndex === -1) {
      rawKey = pair;
      rawValue = '';
    } else {
      rawKey = pair.slice(0, equalIndex);
      rawValue = pair.slice(equalIndex + 1);
    }

    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      const value = decodeURIComponent(rawValue.replace(/\+/g, ' '));

      if (key.length > 0) {
        result[key] = value;
      }
    } catch {
      // Skip malformed percent-encoded sequences rather than throwing
      continue;
    }
  }

  return result;
}

/**
 * Builds a URL query string from a record of key-value pairs. Values
 * are converted to strings and URI-encoded. The returned string does
 * **not** include a leading `"?"`.
 *
 * @param params - An object whose values will be stringified and encoded.
 * @returns The encoded query string (e.g. `"foo=1&bar=hello"`).
 */
export function buildQueryString(
  params: Record<string, string | number | boolean>,
): string {
  if (params === null || params === undefined || typeof params !== 'object') {
    throw new TypeError('buildQueryString: argument must be a non-null object');
  }

  const segments: string[] = [];

  const sortedKeys = Object.keys(params).sort();

  for (const key of sortedKeys) {
    const value = params[key];

    if (value === undefined) {
      continue;
    }

    const encodedKey = encodeURIComponent(key);
    const encodedValue = encodeURIComponent(String(value));

    segments.push(`${encodedKey}=${encodedValue}`);
  }

  return segments.join('&');
}

// ---------------------------------------------------------------------------
// Validation Utilities
// ---------------------------------------------------------------------------

/**
 * Validates whether a string conforms to a reasonable email address
 * format. This uses a practical regex that covers the vast majority of
 * real-world addresses without attempting full RFC 5322 compliance.
 *
 * Rules enforced:
 * - Local part: one or more characters from `[a-zA-Z0-9._%+-]`
 * - Domain: one or more labels separated by dots
 * - TLD: at least two alphabetic characters
 *
 * @param email - The string to validate.
 * @returns `true` if the string looks like a valid email address.
 */
export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') {
    return false;
  }

  if (email.length === 0 || email.length > 254) {
    return false;
  }

  // Practical email regex — intentionally not RFC 5322 complete
  const emailPattern =
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

  if (!emailPattern.test(email)) {
    return false;
  }

  // Additional structural checks
  const atIndex = email.indexOf('@');
  const localPart = email.slice(0, atIndex);
  const domainPart = email.slice(atIndex + 1);

  if (localPart.length > 64) {
    return false;
  }

  if (domainPart.length > 253) {
    return false;
  }

  // Reject consecutive dots in either part
  if (localPart.includes('..') || domainPart.includes('..')) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Computes a simple numeric hash of the input string using the djb2
 * algorithm. This is **not** a cryptographic hash — it is intended for
 * fast bucketing and non-security-sensitive fingerprinting only.
 *
 * The djb2 algorithm was first described by Daniel J. Bernstein. It
 * produces a 32-bit integer hash with good distribution for typical
 * string inputs.
 *
 * @param input - The string to hash.
 * @returns A 32-bit integer hash code.
 */
export function hashCode(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('hashCode: argument must be a string');
  }

  let hash = 5381;

  for (let i = 0; i < input.length; i++) {
    const charCode = input.charCodeAt(i);
    // hash * 33 + charCode, using bit shift for the multiplication
    hash = ((hash << 5) + hash + charCode) | 0;
  }

  // Ensure the result is a non-negative 32-bit integer
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Numeric Utilities
// ---------------------------------------------------------------------------

/**
 * Clamps a numeric value to the inclusive range `[min, max]`. If `value`
 * is less than `min` it returns `min`; if greater than `max` it returns
 * `max`; otherwise it returns `value` unchanged.
 *
 * @param value - The number to clamp.
 * @param min   - The lower bound of the range.
 * @param max   - The upper bound of the range.
 * @returns The clamped value.
 * @throws {RangeError} If `min` is greater than `max`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('clamp: value must be a finite number');
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError('clamp: min and max must be finite numbers');
  }

  if (min > max) {
    throw new RangeError(
      `clamp: min (${min}) must not be greater than max (${max})`,
    );
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Template Interpolation
// ---------------------------------------------------------------------------

/**
 * Performs simple template interpolation by replacing `{{key}}`
 * placeholders in the template string with the corresponding values
 * from the `vars` object. Placeholders that do not have a matching key
 * in `vars` are left in the output unchanged.
 *
 * Whitespace inside the braces is tolerated (e.g. `{{ name }}` works
 * identically to `{{name}}`).
 *
 * @param template - The template string containing `{{key}}` placeholders.
 * @param vars     - A record mapping placeholder names to their replacement
 *   values. Numbers are converted to strings automatically.
 * @returns The interpolated string.
 */
export function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  if (typeof template !== 'string') {
    throw new TypeError('interpolate: template must be a string');
  }

  if (vars === null || vars === undefined || typeof vars !== 'object') {
    throw new TypeError('interpolate: vars must be a non-null object');
  }

  // Match {{ key }} with optional internal whitespace
  const placeholderPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

  return template.replace(
    placeholderPattern,
    (match: string, key: string): string => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        return String(vars[key]);
      }

      // Leave unresolved placeholders intact
      return match;
    },
  );
}
