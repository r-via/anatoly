// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: utility axis — all symbols are actively used (imported
 * by other files). Tests that the model does not produce false DEAD verdicts
 * when import analysis confirms usage.
 */

// ---------------------------------------------------------------------------
// USED — exported and imported by multiple consumers
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  delayMs: 1000,
  backoffFactor: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  let lastError: Error | undefined;
  let delay = opts.delayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < opts.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= opts.backoffFactor;
      }
    }
  }

  throw lastError;
}

export function isRetryable(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}
