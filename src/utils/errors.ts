// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ERROR_CODES = {
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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Default recovery hints per error code.
 * Each hint is a short, actionable next step for the user.
 */
const DEFAULT_HINTS: Partial<Record<ErrorCode, string>> = {
  LOCK_EXISTS: 'wait for it to finish or run `anatoly reset` to force clear',
  CONFIG_INVALID: 'check .anatoly.yml syntax and refer to documentation',
  CONFIG_NOT_FOUND: 'create a .anatoly.yml or run without --config',
  SDK_TIMEOUT: 'try again — the file may be too large; consider splitting it',
  SDK_ERROR: 'Claude Code SDK query failed — check that claude CLI is available and responsive',
  ZOD_VALIDATION_FAILED: 'run with --verbose for detailed validation output',
  TREE_SITTER_PARSE_ERROR: 'ensure the file is valid TypeScript',
  WRITE_ERROR: 'check disk space and file permissions',
  FILE_NOT_FOUND: 'make sure you are running Anatoly from your project root',
  NLP_SUMMARIZATION_FAILED: 'NLP summarization LLM call failed — check provider config and API keys',
  PROVIDER_AUTH_FAILED: 'check provider API keys and authentication — see anatoly providers for status',
  PRICING_INCOMPLETE: 'one or more configured models have no pricing entry — run `anatoly providers` for details, or remove the offending models from .anatoly.yml',
  CIRCUIT_OPEN: 'the provider had repeated genuine failures and the circuit opened — check provider health/quota (anatoly providers) and re-run',
  AXES_ALL_FAILED: 'every axis evaluator crashed for this file — it was not cached and will be re-reviewed next run; check provider health (anatoly providers)',
};

/**
 * Structured error class for user-facing Anatoly failures.
 *
 * Carries a machine-readable {@link ErrorCode}, a `recoverable` flag indicating
 * whether the operation can be retried, and an optional `hint` with an actionable
 * recovery step. When no explicit hint is provided, a default hint is resolved
 * from {@link DEFAULT_HINTS} based on the error code.
 */
export class AnatolyError extends Error {
  public readonly hint: string;
  /** Verbose payload (partial transcript, full stack, etc.) kept out of console output. */
  public readonly detail: string | undefined;
  /**
   * Short context lines (path, cwd, ID, etc.) rendered dim under the
   * error headline by the standardised notice formatter. Use this for
   * structured metadata instead of cramming it into {@link message}.
   */
  public readonly details: readonly string[] | undefined;
  /**
   * When true, the throw site has already produced a fully styled, multi-line
   * message (e.g. a help box with concrete commands). The CLI catch handler
   * should print {@link message} verbatim and skip the `error:` prefix and
   * the chalk.red wrapping that would clash with the embedded styling.
   */
  public readonly preformatted: boolean;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean,
    hint?: string,
    detail?: string,
    preformatted?: boolean,
    details?: readonly string[],
  ) {
    super(message);
    this.name = 'AnatolyError';
    this.hint = hint ?? DEFAULT_HINTS[code] ?? '';
    this.detail = detail;
    this.preformatted = preformatted ?? false;
    this.details = details;
  }

  /**
   * Format the error for terminal display:
   *   error: <message>
   *     → <recovery step>
   *
   * When `preformatted` is true, returns {@link message} as-is.
   */
  formatForDisplay(): string {
    if (this.preformatted) return this.message;
    const lines = [`error: ${this.message}`];
    if (this.details) {
      for (const d of this.details) lines.push(`  ${d}`);
    }
    if (this.hint) {
      lines.push(`  → ${this.hint}`);
    }
    return lines.join('\n');
  }

  /**
   * Serialize to a structured object suitable for pino log fields.
   * Excludes stack and detail to keep console output concise —
   * use {@link writeDump} to persist verbose diagnostics to disk.
   */
  toLogObject(): Record<string, unknown> {
    return {
      errorMessage: this.message,
      code: this.code,
      recoverable: this.recoverable,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }

  /**
   * Write a dump file with the full error details (message, stack, detail).
   * Returns the absolute path to the written file, or `undefined` on failure.
   */
  writeDump(errorsDir: string, label: string): string | undefined {
    try {
      mkdirSync(errorsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeLabel = label.replace(/[/\\]/g, '__').slice(0, 180);
      const fileName = `${safeLabel}__${ts}.txt`;
      const filePath = join(errorsDir, fileName);
      const MAX_DUMP_BYTES = 64 * 1024; // 64 KB cap per dump file
      const detail = this.detail && this.detail.length > MAX_DUMP_BYTES
        ? this.detail.slice(0, MAX_DUMP_BYTES) + '\n…(truncated)'
        : this.detail;
      const sections = [
        `Code:    ${this.code}`,
        `Message: ${this.message}`,
        ...(this.hint ? [`Hint:    ${this.hint}`] : []),
        '',
        '--- stack trace ---',
        this.stack ?? '(no stack)',
        ...(detail ? ['', '--- detail ---', detail] : []),
      ];
      writeFileSync(filePath, sections.join('\n'));
      return filePath;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider authentication failure
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this text look like a provider authentication failure
 * (HTTP 401 / invalid or expired credentials)?
 *
 * The Claude Agent SDK does not surface a typed auth error: on a 401 the
 * subprocess prints the API error and exits with code 1, so the only signal
 * is the message/transcript text. Matched substrings cover the SDK wording
 * ("Failed to authenticate. API Error: 401"), the Anthropic API error type
 * (`authentication_error` / "invalid x-api-key" / "invalid authentication
 * credentials"), and a bare 401-unauthorized.
 */
export function isAuthFailureMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('authentication_error') ||
    t.includes('invalid authentication credentials') ||
    t.includes('failed to authenticate') ||
    t.includes('invalid x-api-key') ||
    t.includes('invalid bearer token') ||
    t.includes('oauth token has expired') ||
    /\bapi error:\s*401\b/.test(t) ||
    /\b401\b[^]*?\bunauthor/.test(t)
  );
}

/**
 * Heuristic: does this text (typically the SDK transcript) look like a
 * provider rate-limit rejection?
 *
 * The Claude Agent SDK does not always surface a typed `rate_limit_event`
 * for these — on subscription plans, when the per-minute or per-day cap is
 * exceeded mid-stream, the subprocess prints `API Error: Rate limit reached`
 * to the Assistant channel and exits with code 1. Without parsing the
 * transcript the transport mis-classifies the failure as a generic
 * SDK_ERROR, which counts against the circuit breaker and trips it after
 * 3 calls (the entire rest of the run then fast-fails on CIRCUIT_OPEN).
 * Match the SDK wording plus the canonical Anthropic API rate-limit
 * phrasings so this signal becomes structurally recoverable.
 */
export function isRateLimitTranscriptMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('rate limit reached') ||
    t.includes('rate_limit_error') ||
    /\bapi error:\s*429\b/.test(t) ||
    /\b429\b[^]*?\b(too many requests|rate)/.test(t)
  );
}

/**
 * True when `err` is the canonical, non-recoverable provider-auth failure
 * (an {@link AnatolyError} carrying {@link ERROR_CODES.PROVIDER_AUTH_FAILED}).
 *
 * The orchestrator uses this to fail the whole run fast: a bad credential is
 * not a transient provider-health issue, so it must not be retried, must not
 * count toward the circuit breaker, and must not be degraded per-file.
 */
export function isFatalAuthError(err: unknown): err is AnatolyError {
  return err instanceof AnatolyError && err.code === ERROR_CODES.PROVIDER_AUTH_FAILED;
}

/**
 * Build the canonical non-recoverable provider-auth error. `detail` carries
 * the partial transcript for the on-disk dump; the user-facing hint comes
 * from {@link DEFAULT_HINTS}.
 */
export function authError(provider: string, detail?: string): AnatolyError {
  return new AnatolyError(
    `${provider} authentication failed (HTTP 401): the provider rejected the credentials. The run cannot continue.`,
    ERROR_CODES.PROVIDER_AUTH_FAILED,
    false,
    undefined,
    detail,
  );
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/** The canonical "provider circuit breaker is open" error. */
export function circuitOpenError(providerId: string): AnatolyError {
  return new AnatolyError(
    `Provider '${providerId}' circuit breaker is open`,
    ERROR_CODES.CIRCUIT_OPEN,
    false,
  );
}

/**
 * True when `err` is a circuit-breaker-open rejection. Matches the typed
 * error and, defensively, the legacy string form so the guard never misses.
 */
export function isCircuitOpenError(err: unknown): boolean {
  if (err instanceof AnatolyError && err.code === ERROR_CODES.CIRCUIT_OPEN) return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /circuit breaker is open/i.test(msg);
}

/**
 * Whether `err` represents a genuine *provider-health* failure that should
 * count toward the circuit breaker (rate limit, 5xx, network, unknown SDK
 * error). It must return **false** for failures that are not health signals
 * and would wrongly trip the breaker:
 *
 * - deliberate aborts / wall-clock timeouts (our {@link withTimeout}, the
 *   doc-conflict detection timeout, SIGINT): "aborted by user", AbortError,
 *   `SDK_TIMEOUT`;
 * - auth failures ({@link ERROR_CODES.PROVIDER_AUTH_FAILED}) — already fatal
 *   and handled by the orchestrator, not a transient health issue;
 * - the circuit-open rejection itself (never re-penalise an open breaker).
 *
 * Unknown / unclassified errors default to `true` so the breaker keeps
 * protecting against real provider degradation.
 */
export function isProviderHealthFailure(err: unknown): boolean {
  if (err instanceof AnatolyError) {
    if (
      err.code === ERROR_CODES.PROVIDER_AUTH_FAILED ||
      err.code === ERROR_CODES.SDK_TIMEOUT ||
      err.code === ERROR_CODES.CIRCUIT_OPEN
    ) {
      return false;
    }
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const t = msg.toLowerCase();
  if (
    t.includes('aborted by user') ||
    t.includes('aborterror') ||
    t.includes('the operation was aborted') ||
    t.includes('operation was aborted') ||
    (t.includes('exceeded the') && t.includes('budget')) || // our TimeoutError
    t === 'interrupted' ||
    t.includes('circuit breaker is open')
  ) {
    return false;
  }
  return true;
}
