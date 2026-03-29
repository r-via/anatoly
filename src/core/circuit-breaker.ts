// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { extractProvider } from './transports/index.js';

/**
 * Circuit breaker states:
 * - **closed** — Gemini calls proceed normally.
 * - **open** — Gemini calls are redirected to Claude (fallback).
 * - **half-open** — One test call is allowed to probe Gemini health.
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
 * Circuit breaker for Gemini transport.
 *
 * After {@link failureThreshold} consecutive Gemini errors (429, timeout,
 * connection), the breaker trips and redirects all Gemini-routed calls to
 * Claude. After {@link halfOpenDelayMs}, a single test call is allowed.
 * If it succeeds the breaker resets; if it fails the breaker re-trips.
 */
export class GeminiCircuitBreaker {
  private consecutiveFailures = 0;
  private _state: CircuitState = 'closed';
  private trippedAt?: number;
  private _warningEmitted = false;

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
   * Returns `true` if Gemini calls should be redirected to Claude.
   * Also handles the open → half-open transition when the delay has elapsed.
   */
  shouldFallback(): boolean {
    if (this._state === 'closed') return false;

    if (this._state === 'open') {
      if (this.trippedAt != null && this.now() - this.trippedAt >= this.halfOpenDelayMs) {
        this._state = 'half-open';
        return false; // allow one test call
      }
      return true;
    }

    // half-open: allow the test call through
    return false;
  }

  /** Record a successful Gemini call. Resets the breaker if in half-open state. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this._state === 'half-open') {
      this._state = 'closed';
      this.trippedAt = undefined;
      this._warningEmitted = false;
    }
  }

  /**
   * Record a failed Gemini call. Returns `true` if this failure caused the
   * breaker to trip (or re-trip from half-open).
   */
  recordFailure(): boolean {
    this.consecutiveFailures++;

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
   * a single warning: "⚠ Gemini quota exhausted — falling back to Claude".
   */
  consumeWarning(): boolean {
    if (this._state === 'open' && !this._warningEmitted) {
      this._warningEmitted = true;
      return true;
    }
    return false;
  }

  /**
   * Resolve the effective model, falling back to Claude when the breaker is
   * open and the requested model is a Gemini model.
   */
  resolveModel(model: string, fallbackModel: string): string {
    if (extractProvider(model) !== 'google') return model;
    if (this.shouldFallback()) return fallbackModel;
    return model;
  }
}
