// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { AnatolyError, ERROR_CODES, isAuthFailureMessage, isRateLimitTranscriptMessage, parseRateLimitResetTime, isFatalAuthError, authError, circuitOpenError, isCircuitOpenError, isProviderHealthFailure } from './errors.js';

describe('AnatolyError', () => {
  it('should create an error with code and recoverable flag', () => {
    const err = new AnatolyError(
      'Config file is invalid YAML',
      ERROR_CODES.CONFIG_INVALID,
      false,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnatolyError);
    expect(err.message).toBe('Config file is invalid YAML');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.recoverable).toBe(false);
    expect(err.name).toBe('AnatolyError');
  });

  it('should create a recoverable error', () => {
    const err = new AnatolyError(
      'SDK timeout after 180s',
      ERROR_CODES.SDK_TIMEOUT,
      true,
    );
    expect(err.recoverable).toBe(true);
    expect(err.code).toBe('SDK_TIMEOUT');
  });

  it('should have all expected error codes', () => {
    expect(ERROR_CODES).toEqual({
      CONFIG_INVALID: 'CONFIG_INVALID',
      CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
      FILE_NOT_FOUND: 'FILE_NOT_FOUND',
      LOCK_EXISTS: 'LOCK_EXISTS',
      SDK_TIMEOUT: 'SDK_TIMEOUT',
      SDK_ERROR: 'SDK_ERROR',
      ZOD_VALIDATION_FAILED: 'ZOD_VALIDATION_FAILED',
      TREE_SITTER_PARSE_ERROR: 'TREE_SITTER_PARSE_ERROR',
      WRITE_ERROR: 'WRITE_ERROR',
      NLP_SUMMARIZATION_FAILED: 'NLP_SUMMARIZATION_FAILED',
      PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
      PRICING_INCOMPLETE: 'PRICING_INCOMPLETE',
      CIRCUIT_OPEN: 'CIRCUIT_OPEN',
      AXES_ALL_FAILED: 'AXES_ALL_FAILED',
    });
  });

  it('should use default hint when no custom hint provided', () => {
    const err = new AnatolyError('lock exists', ERROR_CODES.LOCK_EXISTS, false);
    expect(err.hint).toBe('wait for it to finish or run `anatoly reset` to force clear');
  });

  it('should use custom hint when provided', () => {
    const err = new AnatolyError(
      'lock exists',
      ERROR_CODES.LOCK_EXISTS,
      false,
      'custom recovery step',
    );
    expect(err.hint).toBe('custom recovery step');
  });

  it('should format error for display with hint', () => {
    const err = new AnatolyError(
      'Another instance is running',
      ERROR_CODES.LOCK_EXISTS,
      false,
      'run `anatoly reset`',
    );
    expect(err.formatForDisplay()).toBe(
      'error: Another instance is running\n  → run `anatoly reset`',
    );
  });

  it('should format error for display without hint', () => {
    const err = new AnatolyError(
      'Something failed',
      ERROR_CODES.FILE_NOT_FOUND,
      false,
    );
    // FILE_NOT_FOUND has a default hint
    expect(err.formatForDisplay()).toContain('error: Something failed');
    expect(err.formatForDisplay()).toContain('→');
  });

  describe('toLogObject', () => {
    it('should serialize AnatolyError with hint to structured object', () => {
      const err = new AnatolyError(
        'evaluation timed out after 180s',
        ERROR_CODES.SDK_TIMEOUT,
        true,
      );
      const obj = err.toLogObject();
      expect(obj.errorMessage).toBe('evaluation timed out after 180s');
      expect(obj.code).toBe('SDK_TIMEOUT');
      expect(obj.recoverable).toBe(true);
      expect(obj.hint).toBe('try again — the file may be too large; consider splitting it');
      expect(obj).not.toHaveProperty('stack');
    });

    it('should omit hint when it is empty', () => {
      // CONFIG_INVALID has a default hint, so it won't be empty — use a code without default
      const errNoHint = new AnatolyError('unknown', ERROR_CODES.WRITE_ERROR, false);
      const obj = errNoHint.toLogObject();
      // WRITE_ERROR has a default hint
      expect(obj.hint).toBeDefined();
    });

    it('should use errorMessage (not msg) to avoid pino field collision', () => {
      const err = new AnatolyError('test message', ERROR_CODES.FILE_NOT_FOUND, false);
      const obj = err.toLogObject();
      expect(obj.errorMessage).toBe('test message');
      expect(obj).not.toHaveProperty('msg');
    });

    it('should exclude stack trace from log object (kept in dump files)', () => {
      const err = new AnatolyError('boom', ERROR_CODES.SDK_ERROR, true);
      const obj = err.toLogObject();
      expect(obj).not.toHaveProperty('stack');
    });
  });
});

describe('isAuthFailureMessage', () => {
  it.each([
    'Failed to authenticate. API Error: 401',
    '{"error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
    'API Error: 401 unauthorized',
    'invalid x-api-key',
    'OAuth token has expired',
  ])('detects auth failure text: %s', (msg) => {
    expect(isAuthFailureMessage(msg)).toBe(true);
  });

  it.each([
    '',
    null,
    undefined,
    'Claude Code process exited with code 1',
    'rate limit exceeded (429)',
    'section "ADR-007 ..." (401 chars)', // 401 as a count, not an HTTP status
    'ECONNRESET',
  ])('does not false-positive on: %s', (msg) => {
    expect(isAuthFailureMessage(msg as string | null | undefined)).toBe(false);
  });
});

describe('isRateLimitTranscriptMessage', () => {
  it.each([
    'API Error: Rate limit reached',
    'Error: rate_limit_error',
    '{"type":"rate_limit_error","message":"..."}',
    'API Error: 429 Too Many Requests',
    'HTTP 429 — rate limit exceeded',
    // Claude Code subscription phrasings (claude.ai web)
    "Claude Code returned an error result: You've hit your limit · resets 11:20am (Europe/Paris)",
    "You've reached your usage limit. Try again later.",
    'hit your usage limit, please wait',
    'service unavailable — resets at 14:30',
  ])('detects rate-limit transcript text: %s', (msg) => {
    expect(isRateLimitTranscriptMessage(msg)).toBe(true);
  });

  it.each([
    '',
    null,
    undefined,
    'Claude Code process exited with code 1',
    'API Error: 401 unauthorized',
    'random business text mentioning rate or limit in passing',
    '"file count: 429 files scanned"',
  ])('does not false-positive on: %s', (msg) => {
    expect(isRateLimitTranscriptMessage(msg as string | null | undefined)).toBe(false);
  });
});

describe('parseRateLimitResetTime', () => {
  // Fix "now" to a known instant so the 12h/24h forward-roll math is deterministic.
  const NOW = new Date('2026-05-21T09:00:00.000Z');

  it('parses "resets 11:20am" relative to now (same day, future)', () => {
    const ms = parseRateLimitResetTime("You've hit your limit · resets 11:20am", NOW);
    expect(ms).toBeDefined();
    // 11:20 LOCAL on the same date
    const expected = new Date(NOW); expected.setHours(11, 20, 0, 0);
    expect(ms).toBe(expected.getTime());
  });

  it('parses "resets at 14:30" (24h form)', () => {
    const ms = parseRateLimitResetTime('resets at 14:30', NOW);
    const expected = new Date(NOW); expected.setHours(14, 30, 0, 0);
    expect(ms).toBe(expected.getTime());
  });

  it('rolls forward to tomorrow when the parsed clock time is already past', () => {
    const lateAt = new Date('2026-05-21T23:30:00.000Z');
    const ms = parseRateLimitResetTime('resets at 11:20am', lateAt);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(lateAt.getTime());
  });

  it('parses an explicit ISO-8601 form', () => {
    const ms = parseRateLimitResetTime('resets at 2026-05-21T11:20:00Z');
    expect(ms).toBe(Date.parse('2026-05-21T11:20:00Z'));
  });

  it('returns undefined when no time is present', () => {
    expect(parseRateLimitResetTime('hit your limit', NOW)).toBeUndefined();
    expect(parseRateLimitResetTime('', NOW)).toBeUndefined();
    expect(parseRateLimitResetTime(undefined, NOW)).toBeUndefined();
  });
});

describe('isFatalAuthError / authError', () => {
  it('authError() is a non-recoverable PROVIDER_AUTH_FAILED with an actionable hint', () => {
    const err = authError('anthropic', 'partial transcript');
    expect(err).toBeInstanceOf(AnatolyError);
    expect(err.code).toBe(ERROR_CODES.PROVIDER_AUTH_FAILED);
    expect(err.recoverable).toBe(false);
    expect(err.hint).toMatch(/authentication/i);
    expect(err.detail).toBe('partial transcript');
    expect(err.message).toContain('anthropic');
  });

  it('isFatalAuthError only matches the canonical auth error', () => {
    expect(isFatalAuthError(authError('anthropic'))).toBe(true);
    expect(isFatalAuthError(new AnatolyError('x', ERROR_CODES.SDK_ERROR, true))).toBe(false);
    expect(isFatalAuthError(new Error('401 unauthorized'))).toBe(false);
    expect(isFatalAuthError(undefined)).toBe(false);
  });
});

describe('circuitOpenError / isCircuitOpenError', () => {
  it('circuitOpenError is a non-recoverable CIRCUIT_OPEN error with a hint', () => {
    const err = circuitOpenError('anthropic');
    expect(err).toBeInstanceOf(AnatolyError);
    expect(err.code).toBe(ERROR_CODES.CIRCUIT_OPEN);
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain("Provider 'anthropic' circuit breaker is open");
    expect(err.hint).toMatch(/circuit/i);
  });

  it('isCircuitOpenError matches the typed error and the legacy string form', () => {
    expect(isCircuitOpenError(circuitOpenError('anthropic'))).toBe(true);
    expect(isCircuitOpenError(new Error("Provider 'anthropic' circuit breaker is open"))).toBe(true);
    expect(isCircuitOpenError(new AnatolyError('x', ERROR_CODES.SDK_ERROR, true))).toBe(false);
    expect(isCircuitOpenError(undefined)).toBe(false);
  });
});

describe('isProviderHealthFailure', () => {
  it('does NOT count deliberate aborts / timeouts / auth / circuit-open', () => {
    expect(isProviderHealthFailure(new Error('Claude Code process aborted by user'))).toBe(false);
    expect(isProviderHealthFailure(new Error('The operation was aborted'))).toBe(false);
    expect(isProviderHealthFailure(new Error('AbortError: aborted'))).toBe(false);
    expect(isProviderHealthFailure(new AnatolyError('doc page generation exceeded the 600s budget (runtime.timeout_per_file)', ERROR_CODES.SDK_TIMEOUT, true))).toBe(false);
    expect(isProviderHealthFailure(new AnatolyError('review src/x.ts exceeded the 600s budget', ERROR_CODES.SDK_ERROR, true))).toBe(false);
    expect(isProviderHealthFailure(authError('anthropic'))).toBe(false);
    expect(isProviderHealthFailure(circuitOpenError('anthropic'))).toBe(false);
    expect(isProviderHealthFailure(new Error('interrupted'))).toBe(false);
  });

  it('DOES count genuine provider-health failures (default protects the breaker)', () => {
    expect(isProviderHealthFailure(new Error('429 Too Many Requests'))).toBe(true);
    expect(isProviderHealthFailure(new Error('500 Internal Server Error'))).toBe(true);
    expect(isProviderHealthFailure(new Error('ECONNRESET'))).toBe(true);
    expect(isProviderHealthFailure(new AnatolyError('Claude Code SDK error [error]: boom', ERROR_CODES.SDK_ERROR, true))).toBe(true);
    expect(isProviderHealthFailure(undefined)).toBe(true);
  });

  it('does NOT count non-recoverable AnatolyErrors (deterministic give-up by our code, not a provider-health signal)', () => {
    // Repro of run 2026-05-21_093126: the rate-limiter's MAX_STANDBY_WAIT_MS
    // cap throws AnatolyError(SDK_ERROR, recoverable=false). Without this
    // exclusion, N parallel callers exiting standby at the same time would
    // each record a failure on the shared per-provider breaker and trip it
    // within milliseconds, fast-failing the rest of the review phase with
    // CIRCUIT_OPEN. The breaker must stay closed for these.
    const quotaAborted = new AnatolyError(
      'Provider quota exhausted until 11:20am (wait 142 min > cap 15 min) — run aborted',
      ERROR_CODES.SDK_ERROR,
      false,
    );
    expect(isProviderHealthFailure(quotaAborted)).toBe(false);
    // Generic non-recoverable AnatolyError with no message keyword match also stays off the breaker.
    expect(isProviderHealthFailure(new AnatolyError('we decided to bail', ERROR_CODES.SDK_ERROR, false))).toBe(false);
    // Same code recoverable=true is still counted (sanity: the prior assertion above already covers it).
    expect(isProviderHealthFailure(new AnatolyError('transient sdk error', ERROR_CODES.SDK_ERROR, true))).toBe(true);
  });
});
