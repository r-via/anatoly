import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff, isRateLimitError, calculateBackoff } from './rate-limiter.js';
import { AnatolyError, ERROR_CODES } from './errors.js';

describe('isRateLimitError', () => {
  it('should detect AnatolyError with 429 in message', () => {
    const err = new AnatolyError('Agent SDK error: 429 Too Many Requests', ERROR_CODES.LLM_API_ERROR, true);
    expect(isRateLimitError(err)).toBe(true);
  });

  it('should detect AnatolyError with rate limit in message', () => {
    const err = new AnatolyError('Agent SDK error: rate limit exceeded', ERROR_CODES.LLM_API_ERROR, true);
    expect(isRateLimitError(err)).toBe(true);
  });

  it('should detect AnatolyError with rate_limit in message', () => {
    const err = new AnatolyError('Agent SDK error: rate_limit_error', ERROR_CODES.LLM_API_ERROR, true);
    expect(isRateLimitError(err)).toBe(true);
  });

  it('should not detect non-rate-limit AnatolyError', () => {
    const err = new AnatolyError('Some other error', ERROR_CODES.LLM_API_ERROR, true);
    expect(isRateLimitError(err)).toBe(false);
  });

  it('should not detect timeout errors as rate limit', () => {
    const err = new AnatolyError('Timed out', ERROR_CODES.LLM_TIMEOUT, true);
    expect(isRateLimitError(err)).toBe(false);
  });

  it('should detect generic Error with 429', () => {
    const err = new Error('HTTP 429');
    expect(isRateLimitError(err)).toBe(true);
  });

  it('should not detect non-error values', () => {
    expect(isRateLimitError('429')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe('calculateBackoff', () => {
  it('should calculate exponential delays', () => {
    // With jitter = 0, the delay should be exact
    const d0 = calculateBackoff(0, 5000, 120000, 0);
    const d1 = calculateBackoff(1, 5000, 120000, 0);
    const d2 = calculateBackoff(2, 5000, 120000, 0);

    expect(d0).toBe(5000);   // 5000 * 2^0
    expect(d1).toBe(10000);  // 5000 * 2^1
    expect(d2).toBe(20000);  // 5000 * 2^2
  });

  it('should clamp to maxDelay', () => {
    const d = calculateBackoff(10, 5000, 120000, 0);
    expect(d).toBe(120000);
  });

  it('should apply jitter within bounds', () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(calculateBackoff(0, 5000, 120000, 0.2));
    }
    // All values should be within +-20% of 5000 (4000-6000)
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(4000);
      expect(r).toBeLessThanOrEqual(6000);
    }
  });
});

describe('retryWithBackoff', () => {
  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitterFactor: 0,
      filePath: 'test.ts',
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on rate limit errors and succeed', async () => {
    const rateLimitErr = new AnatolyError('429 rate limit', ERROR_CODES.LLM_API_ERROR, true);
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue('ok');

    const onRetry = vi.fn();
    const result = await retryWithBackoff(fn, {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitterFactor: 0,
      filePath: 'test.ts',
      onRetry,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('should throw after exhausting retries on rate limit', async () => {
    const rateLimitErr = new AnatolyError('429 rate limit', ERROR_CODES.LLM_API_ERROR, true);
    const fn = vi.fn().mockRejectedValue(rateLimitErr);

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterFactor: 0,
        filePath: 'test.ts',
      }),
    ).rejects.toThrow('Rate limit exceeded after 2 retries');

    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-rate-limit errors', async () => {
    const otherErr = new AnatolyError('some error', ERROR_CODES.LLM_TIMEOUT, true);
    const fn = vi.fn().mockRejectedValue(otherErr);

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterFactor: 0,
        filePath: 'test.ts',
      }),
    ).rejects.toThrow('some error');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
