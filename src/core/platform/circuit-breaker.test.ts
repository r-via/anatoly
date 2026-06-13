// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  // -----------------------------------------------------------------------
  // Closed state (default)
  // -----------------------------------------------------------------------

  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('closed');
  });

  it('shouldFallback returns false when closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.shouldFallback()).toBe(false);
  });

  it('shouldFallback returns false after 1 failure', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    expect(cb.shouldFallback()).toBe(false);
  });

  it('shouldFallback returns false after 2 failures', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.shouldFallback()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Tripping after 3 consecutive failures
  // -----------------------------------------------------------------------

  it('trips after 3 consecutive failures', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('open');
    expect(cb.shouldFallback()).toBe(true);
  });

  it('recordSuccess resets consecutive failure count', () => {
    const cb = new CircuitBreaker();
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
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consumeWarning()).toBe(true);
    expect(cb.consumeWarning()).toBe(false);
  });

  it('consumeWarning returns false when closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.consumeWarning()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Half-open state (after delay)
  // -----------------------------------------------------------------------

  it('stays open before halfOpenDelayMs has elapsed', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ now: () => now });
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
    const cb = new CircuitBreaker({ now: () => now });
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
    const cb = new CircuitBreaker({ now: () => now });
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
    const cb = new CircuitBreaker({ now: () => now });
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
    const cb = new CircuitBreaker({ now: () => now });
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
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe('closed');
    cb.recordFailure();
    expect(cb.state).toBe('open');
  });

  it('respects custom halfOpenDelayMs', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ halfOpenDelayMs: 10_000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    now += 9_999;
    expect(cb.shouldFallback()).toBe(true);
    now += 1;
    expect(cb.shouldFallback()).toBe(false); // half-open
  });

  // -----------------------------------------------------------------------
  // isOpen() — non-mutating preflight check
  // -----------------------------------------------------------------------

  it('isOpen returns false when closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.isOpen()).toBe(false);
  });

  it('isOpen returns true once tripped open', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('isOpen does NOT transition open → half-open (non-mutating)', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ halfOpenDelayMs: 10_000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    now += 20_000; // well past the half-open delay

    // Repeated isOpen() calls must not flip the breaker to half-open the
    // way shouldFallback() would; the preflight stays read-only.
    expect(cb.isOpen()).toBe(true);
    expect(cb.isOpen()).toBe(true);
    expect(cb.state).toBe('open');
  });

  it('isOpen returns false in half-open state', () => {
    let now = 1000;
    const cb = new CircuitBreaker({ halfOpenDelayMs: 10_000, now: () => now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    now += 10_001;
    cb.shouldFallback(); // triggers open → half-open
    expect(cb.state).toBe('half-open');
    expect(cb.isOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // openReason — quota vs generic-health trip
  // -----------------------------------------------------------------------

  it('openReason is rate_limit when the tripping failures were rate-limited', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure(true);
    cb.recordFailure(true);
    cb.recordFailure(true);
    expect(cb.isOpen()).toBe(true);
    expect(cb.openReason()).toBe('rate_limit');
  });

  it('openReason is health for generic failures (default)', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.openReason()).toBe('health');
  });

  it('openReason reflects the most recent failure classification', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure(true);
    cb.recordFailure(false); // latest = generic
    cb.recordFailure(false);
    expect(cb.openReason()).toBe('health');
  });

  it('recordSuccess resets openReason to health', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure(true);
    cb.recordSuccess();
    expect(cb.openReason()).toBe('health');
  });

});
