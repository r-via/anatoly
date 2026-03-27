// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Rate limiter using the token bucket algorithm.
 * Thread-safe for single-process Node.js applications.
 */

/** Configuration for the rate limiter. */
export interface RateLimiterConfig {
  /** Maximum number of tokens in the bucket. */
  readonly maxTokens: number;
  /** Number of tokens added per second. */
  readonly refillRate: number;
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Number of tokens remaining after the check. */
  readonly remaining: number;
  /** Seconds until the next token is available (0 if allowed). */
  readonly retryAfterSec: number;
}

const MIN_TOKENS = 1;
const MIN_REFILL_RATE = 0.1;

/**
 * Create a rate limiter with the token bucket algorithm.
 *
 * @param config - Rate limiter configuration.
 * @returns An object with `check` and `reset` methods.
 * @throws {RangeError} If maxTokens or refillRate is below minimum.
 *
 * @example
 * ```typescript
 * const limiter = createRateLimiter({ maxTokens: 100, refillRate: 10 });
 * const result = limiter.check();
 * if (!result.allowed) {
 *   console.log(`Rate limited. Retry in ${result.retryAfterSec}s`);
 * }
 * ```
 */
export function createRateLimiter(config: RateLimiterConfig): {
  check: (cost?: number) => RateLimitResult;
  reset: () => void;
} {
  if (config.maxTokens < MIN_TOKENS) {
    throw new RangeError(`maxTokens must be at least ${MIN_TOKENS}`);
  }
  if (config.refillRate < MIN_REFILL_RATE) {
    throw new RangeError(`refillRate must be at least ${MIN_REFILL_RATE}`);
  }

  let tokens = config.maxTokens;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(config.maxTokens, tokens + elapsed * config.refillRate);
    lastRefill = now;
  }

  function check(cost = 1): RateLimitResult {
    refill();

    if (tokens >= cost) {
      tokens -= cost;
      return { allowed: true, remaining: Math.floor(tokens), retryAfterSec: 0 };
    }

    const deficit = cost - tokens;
    return {
      allowed: false,
      remaining: Math.floor(tokens),
      retryAfterSec: Math.ceil(deficit / config.refillRate),
    };
  }

  function reset(): void {
    tokens = config.maxTokens;
    lastRefill = Date.now();
  }

  return { check, reset };
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds (negative values clamped to 0).
 * @returns Formatted string like "350ms", "1.2s", or "2m 15s".
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  let minutes = Math.floor(ms / 60_000);
  let seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 60) { minutes += 1; seconds = 0; }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Clamp a numeric value between a minimum and maximum.
 *
 * @param value - The value to clamp.
 * @param min - Lower bound (inclusive).
 * @param max - Upper bound (inclusive).
 * @returns The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
