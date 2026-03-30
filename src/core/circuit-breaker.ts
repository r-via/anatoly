// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Circuit breaker states:
 * - **closed** — Calls proceed normally.
 * - **open** — Calls fail fast with an error.
 * - **half-open** — One test call is allowed to probe provider health.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping (default: 3). */
  failureThreshold?: number;
  /** Delay in ms before transitioning from open → half-open (default: 5 minutes). */
  halfOpenDelayMs?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
}

/**
 * Provider-agnostic circuit breaker for LLM transports.
 *
 * After {@link failureThreshold} consecutive errors (429, timeout,
 * connection), the breaker trips and all calls fail fast.
 * After {@link halfOpenDelayMs}, a single test call is allowed.
 * If it succeeds the breaker resets; if it fails the breaker re-trips.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private _state: CircuitState = 'closed';
  private trippedAt?: number;
  private _warningEmitted = false;
  private _halfOpenProbeInFlight = false;

  private readonly failureThreshold: number;
  private readonly halfOpenDelayMs: number;
  private readonly now: () => number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? 3;
    this.halfOpenDelayMs = opts?.halfOpenDelayMs ?? 5 * 60 * 1000;
    this.now = opts?.now ?? (() => Date.now());
  }

  get state(): CircuitState {
    return this._state;
  }

  /**
   * Returns `true` if calls should fail fast (breaker is open).
   * Also handles the open → half-open transition when the delay has elapsed.
   */
  shouldFallback(): boolean {
    if (this._state === 'closed') return false;

    if (this._state === 'open') {
      if (this.trippedAt != null && this.now() - this.trippedAt >= this.halfOpenDelayMs) {
        if (this._halfOpenProbeInFlight) return true; // another probe is already running
        this._state = 'half-open';
        this._halfOpenProbeInFlight = true;
        return false; // allow exactly one test call
      }
      return true;
    }

    // half-open with probe in flight: reject additional callers
    return true;
  }

  /** Record a successful call. Resets the breaker if in half-open state. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this._halfOpenProbeInFlight = false;
    if (this._state === 'half-open') {
      this._state = 'closed';
      this.trippedAt = undefined;
      this._warningEmitted = false;
    }
  }

  /**
   * Record a failed call. Returns `true` if this failure caused the
   * breaker to trip (or re-trip from half-open).
   */
  recordFailure(): boolean {
    this.consecutiveFailures++;
    this._halfOpenProbeInFlight = false;

    if (this._state === 'half-open') {
      this._state = 'open';
      this.trippedAt = this.now();
      return true;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this._state = 'open';
      this.trippedAt = this.now();
      return true;
    }

    return false;
  }

  /**
   * Returns `true` exactly once per trip, so that the CLI can display
   * a single warning when the breaker trips.
   */
  consumeWarning(): boolean {
    if (this._state === 'open' && !this._warningEmitted) {
      this._warningEmitted = true;
      return true;
    }
    return false;
  }

}
