// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { GeminiCircuitBreaker } from './circuit-breaker.js';

describe('GeminiCircuitBreaker', () => {
  // -----------------------------------------------------------------------
  // Closed state (default)
  // -----------------------------------------------------------------------

  it('starts in closed state', () => {
    const cb = new GeminiCircuitBreaker();
    expect(cb.state).toBe('closed');
  });

  it('shouldFallback returns false when closed', () => {
    const cb = new GeminiCircuitBreaker();
    expect(cb.shouldFallback()).toBe(false);
  });

  it('shouldFallback returns false after 1 failure', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    expect(cb.shouldFallback()).toBe(false);
  });

  it('shouldFallback returns false after 2 failures', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.shouldFallback()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Tripping after 3 consecutive failures
  // -----------------------------------------------------------------------

  it('trips after 3 consecutive failures', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.shouldFallback()).toBe(true);
  });

  it('recordSuccess resets consecutive failure count', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // resets
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed');
    expect(cb.shouldFallback()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Warning (once per trip)
  // -----------------------------------------------------------------------

  it('consumeWarning returns true once when tripped', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consumeWarning()).toBe(true);
    expect(cb.consumeWarning()).toBe(false);
  });

  it('consumeWarning returns false when closed', () => {
    const cb = new GeminiCircuitBreaker();
    expect(cb.consumeWarning()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Half-open state (after delay)
  // -----------------------------------------------------------------------

  it('stays open before halfOpenDelayMs has elapsed', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    // 4 minutes later — still open
    now += 4 * 60 * 1000;
    expect(cb.shouldFallback()).toBe(true);
    expect(cb.state).toBe('open');
  });

  it('enters half-open state after halfOpenDelayMs', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    // 5 minutes later — transitions to half-open
    now += 5 * 60 * 1000;
    expect(cb.shouldFallback()).toBe(false);
    expect(cb.state).toBe('half-open');
  });

  it('recordSuccess in half-open resets to closed', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    now += 5 * 60 * 1000;
    cb.shouldFallback(); // triggers half-open transition

    cb.recordSuccess();
    expect(cb.state).toBe('closed');
    expect(cb.shouldFallback()).toBe(false);
  });

  it('recordFailure in half-open re-trips to open', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    now += 5 * 60 * 1000;
    cb.shouldFallback(); // triggers half-open transition

    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.shouldFallback()).toBe(true);
  });

  it('consumeWarning can fire again after reset from half-open', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consumeWarning()).toBe(true);

    // Reset via half-open → success
    now += 5 * 60 * 1000;
    cb.shouldFallback();
    cb.recordSuccess();

    // Trip again
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consumeWarning()).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Custom configuration
  // -----------------------------------------------------------------------

  it('respects custom failureThreshold', () => {
    const cb = new GeminiCircuitBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
  });

  it('respects custom halfOpenDelayMs', () => {
    let now = 1000;
    const cb = new GeminiCircuitBreaker({ halfOpenDelayMs: 10_000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    now += 9_999;
    expect(cb.shouldFallback()).toBe(true);
    now += 1;
    expect(cb.shouldFallback()).toBe(false); // half-open
  });

  // -----------------------------------------------------------------------
  // resolveModel helper
  // -----------------------------------------------------------------------

  it('resolveModel returns model as-is when closed', () => {
    const cb = new GeminiCircuitBreaker();
    expect(cb.resolveModel('gemini-3-flash-preview', 'claude-sonnet-4-20250514')).toBe('gemini-3-flash-preview');
  });

  it('resolveModel returns fallback when open and model is gemini', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.resolveModel('gemini-3-flash-preview', 'claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
  });

  it('resolveModel returns model as-is for non-gemini models even when open', () => {
    const cb = new GeminiCircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.resolveModel('claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022')).toBe('claude-sonnet-4-20250514');
  });
});
