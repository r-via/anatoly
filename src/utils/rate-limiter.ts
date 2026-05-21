// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { AnatolyError, ERROR_CODES } from './errors.js';
import { contextLogger } from './log-context.js';

// ---------------------------------------------------------------------------
// Rate-limit standby error
// ---------------------------------------------------------------------------

/**
 * Thrown when the SDK emits a `rate_limit_event` with `status === 'rejected'`.
 * Carries the reset timestamp so callers can sleep until the limit lifts.
 */
export class RateLimitStandbyError extends AnatolyError {
  /** Unix-epoch milliseconds when the rate limit resets. */
  public readonly resetsAtMs: number;

  constructor(resetsAtMs: number) {
    const resetsDate = new Date(resetsAtMs);
    const timeStr = resetsDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    super(
      `Rate limit rejected — resets at ${timeStr}`,
      ERROR_CODES.SDK_ERROR,
      true,
      'sleeping until rate limit expires, then retrying automatically',
    );
    this.resetsAtMs = resetsAtMs;
  }
}

/**
 * Check whether an error is a {@link RateLimitStandbyError} (tier-level rate
 * limit with a known reset time).
 */
export function isRateLimitStandbyError(error: unknown): error is RateLimitStandbyError {
  return error instanceof RateLimitStandbyError;
}

// ---------------------------------------------------------------------------
// Retry options
// ---------------------------------------------------------------------------

export interface RetryWithBackoffOptions {
  /** Maximum number of retries on rate limit errors. */
  maxRetries: number;
  /** Base delay in milliseconds. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds. */
  maxDelayMs: number;
  /** Jitter factor (0.2 = +-20%). */
  jitterFactor: number;
  /** Optional callback for logging retry messages. */
  onRetry?: (attempt: number, delayMs: number, filePath: string) => void;
  /** Called when entering standby mode (tier-level rate limit with known reset time). */
  onStandby?: (resetsAtMs: number, filePath: string) => void;
  /** File path for error messages. */
  filePath: string;
  /** Called to check whether to abort retries early (e.g. SIGINT). */
  isInterrupted?: () => boolean;
}

/**
 * Check if an error is retryable: rate limit 429, overloaded 529, server
 * 500/503, transient network failures (socket closed / hang up / reset /
 * timeout / refused), or a Claude Code subprocess crash ("exited with code").
 * The Anthropic SDK wraps these in various ways.
 */
export function isRateLimitError(error: unknown): boolean {
  // Standby errors are handled separately — never treat as regular rate limit
  if (isRateLimitStandbyError(error)) return false;

  const check = (msg: string): boolean =>
    msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit')
    || msg.includes('529') || msg.includes('overloaded')
    || msg.includes('500') || msg.includes('503')
    || msg.includes('exited with code')
    || (msg.includes('socket') && (msg.includes('closed') || msg.includes('hang up')))
    || msg.includes('econnreset') || msg.includes('econnrefused')
    || msg.includes('etimedout') || msg.includes('socket hang up');

  if (error instanceof AnatolyError && (error.code === 'SDK_ERROR')) {
    return check(error.message.toLowerCase());
  }
  if (error instanceof Error) {
    return check(error.message.toLowerCase());
  }
  return false;
}

/**
 * Calculate backoff delay with jitter.
 * Formula: baseDelay * 2^attempt * (1 ± jitter)
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const clampedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * jitterFactor;
  return Math.round(clampedDelay * jitter);
}

/** Extra margin added after the reset time before retrying (5 minutes). */
const STANDBY_MARGIN_MS = 5 * 60 * 1000;
/** Max standby sleep cycles before giving up. */
const MAX_STANDBY_CYCLES = 3;
/**
 * Hard cap on a single standby sleep. Beyond this duration the call surfaces
 * a non-recoverable error instead of silently sleeping the interactive run
 * for hours: when the quota resets several hours away ("resets 11:20am"
 * encountered 3h before), waking up at 11:20am to finish a multi-file audit
 * is not useful — the user wants to know NOW that the run cannot proceed so
 * they can decide whether to wait, upgrade the plan, or change concurrency.
 * 15 minutes covers short minute-bucket bursts without lying about progress.
 */
const MAX_STANDBY_WAIT_MS = 15 * 60 * 1000;

/**
 * Execute an async function with automatic retry on rate limit (429) errors.
 * Uses exponential backoff with jitter.
 *
 * When a {@link RateLimitStandbyError} is caught (tier-level rate limit with a
 * known reset time), the function sleeps until `resetsAt + 5 min` and then
 * retries — the attempt counter is reset so normal retries remain available.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryWithBackoffOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, jitterFactor, onRetry, onStandby, filePath, isInterrupted } = options;
  let standbyCycles = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // If interrupted, stop retrying immediately
      if (isInterrupted?.()) throw error;

      // --- Tier-level rate limit with known reset time ---
      if (isRateLimitStandbyError(error)) {
        const waitMs = Math.max(0, error.resetsAtMs + STANDBY_MARGIN_MS - Date.now());
        const resumeDate = new Date(error.resetsAtMs + STANDBY_MARGIN_MS);
        const resumeStr = resumeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Reset is so far away that sleeping would silently hang the run for
        // hours. Surface a non-recoverable error so the user can decide
        // (wait, upgrade plan, lower concurrency). Note: AnatolyError with
        // recoverable=false bypasses the circuit-breaker increment via
        // isProviderHealthFailure (this is a quota signal, not a health
        // failure), so the rest of the run still fast-fails cleanly without
        // tripping the breaker further.
        if (waitMs > MAX_STANDBY_WAIT_MS) {
          contextLogger().warn(
            { file: filePath, resetsAt: error.resetsAtMs, waitMs, resumeAt: resumeStr, cap: MAX_STANDBY_WAIT_MS },
            'rate limit standby exceeds cap — aborting rather than sleeping for hours',
          );
          throw new AnatolyError(
            `Provider quota exhausted until ${resumeStr} (wait ${Math.round(waitMs / 60_000)} min > cap ${MAX_STANDBY_WAIT_MS / 60_000} min) — run aborted`,
            ERROR_CODES.SDK_ERROR,
            false,
            `retry after ${resumeStr}, lower --concurrency, or upgrade the provider plan to extend the quota window`,
          );
        }

        standbyCycles++;
        if (standbyCycles > MAX_STANDBY_CYCLES) {
          throw new Error(`Rate limit standby exhausted after ${MAX_STANDBY_CYCLES} cycles — giving up`);
        }

        contextLogger().info(
          { file: filePath, resetsAt: error.resetsAtMs, waitMs, resumeAt: resumeStr, standbyCycles },
          'rate limit standby — sleeping until reset',
        );
        onStandby?.(error.resetsAtMs, filePath);

        if (waitMs > 0) {
          await sleep(waitMs, isInterrupted);
        }
        if (isInterrupted?.()) throw error;

        // Reset attempt counter — this is a legitimate pause, not a failure
        attempt = -1;
        continue;
      }

      if (!isRateLimitError(error) || attempt === maxRetries) {
        // Not a rate limit error or exhausted retries
        if (isRateLimitError(error) && attempt === maxRetries) {
          contextLogger().warn(
            { file: filePath, attempts: maxRetries },
            'rate limit retries exhausted',
          );
          throw new AnatolyError(
            `Rate limit exceeded after ${maxRetries} retries for ${filePath}`,
            ERROR_CODES.SDK_ERROR,
            true,
            'reduce --concurrency or try again later',
          );
        }
        throw error;
      }

      const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      contextLogger().debug(
        { file: filePath, attempt: attempt + 1, maxRetries, delayMs },
        'rate limited, retrying',
      );
      onRetry?.(attempt + 1, delayMs, filePath);
      await sleep(delayMs, isInterrupted);

      // Re-check after sleep in case we were interrupted during wait
      if (isInterrupted?.()) throw error;
    }
  }

  // TypeScript needs this but we never reach here
  throw new Error('unreachable');
}

function sleep(ms: number, isInterrupted?: () => boolean): Promise<void> {
  if (!isInterrupted) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  // Poll every 250ms so Ctrl+C is detected quickly during long backoff waits
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (isInterrupted() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}
