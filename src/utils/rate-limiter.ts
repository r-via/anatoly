import { AnatolyError, ERROR_CODES } from './errors.js';
import { contextLogger } from './log-context.js';

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
  /** File path for error messages. */
  filePath: string;
  /** Called to check whether to abort retries early (e.g. SIGINT). */
  isInterrupted?: () => boolean;
}

/**
 * Check if an error is a rate limit (429) error.
 * The Anthropic SDK wraps these in various ways.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof AnatolyError && (error.code === 'SDK_ERROR')) {
    const msg = error.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit');
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit');
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

/**
 * Execute an async function with automatic retry on rate limit (429) errors.
 * Uses exponential backoff with jitter.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryWithBackoffOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, jitterFactor, onRetry, filePath, isInterrupted } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // If interrupted, stop retrying immediately
      if (isInterrupted?.()) throw error;

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
