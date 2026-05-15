// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Wall-clock timeout wrapper for long-running agentic LLM calls.
 *
 * The Claude Agent SDK loop (`for await (const message of q)`) has no internal
 * timeout: a stuck call never yields a `result` message and hangs forever.
 * When such a call sits inside a `Promise.allSettled` (doc generation, per-file
 * axis evaluation) a single stuck call freezes the whole phase. This wraps the
 * call so `runtime.timeout_per_file` becomes a hard wall: on expiry we abort the
 * in-flight call and reject, turning an infinite hang into one isolated failure.
 *
 * Concurrency control and retry stay the caller's responsibility — this only
 * adds the wall.
 */

import { AnatolyError, ERROR_CODES } from './errors.js';

/** Thrown when an operation exceeds its wall-clock budget. */
export class TimeoutError extends AnatolyError {
  constructor(label: string, timeoutMs: number) {
    super(
      `${label} exceeded the ${Math.round(timeoutMs / 1000)}s budget (runtime.timeout_per_file)`,
      ERROR_CODES.SDK_TIMEOUT,
      true,
    );
    this.name = 'TimeoutError';
  }
}

export interface WithTimeoutOptions {
  /** Wall-clock budget in milliseconds. */
  timeoutMs: number;
  /** Human-readable label for the timed operation (used in the error message). */
  label: string;
  /**
   * Invoked once when the budget is exceeded, before the rejection. Abort the
   * in-flight SDK/agent call here so it stops instead of leaking in the
   * background. Wrapped in try/catch — a throwing callback never masks the
   * {@link TimeoutError}.
   */
  onTimeout?: () => void;
}

/**
 * Race `task()` against a wall-clock timer. On timeout, invoke
 * `opts.onTimeout` (to abort the underlying call) and reject with a
 * {@link TimeoutError}. The timer is always cleared once `task` settles, and
 * is `unref`'d so a pending timer never keeps the process alive on its own.
 */
export async function withTimeout<T>(
  task: () => Promise<T>,
  opts: WithTimeoutOptions,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        opts.onTimeout?.();
      } catch {
        /* best-effort abort — never mask the timeout */
      }
      reject(new TimeoutError(opts.label, opts.timeoutMs));
    }, opts.timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
