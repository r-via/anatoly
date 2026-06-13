// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { getLogger } from '../../utils/logger.js';
import { runWithContext } from '../../utils/log-context.js';
import type { Logger } from '../../utils/logger.js';
import { emitPhaseStart, emitPhaseEnd } from './events.js';
import { AnatolyError } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The 12 canonical pipeline phases. `doc-conflict-detection` was split into
 * two named phases (doc-conflict-bootstrap, doc-conflict-update); the
 * post-doc-update incremental RAG re-index is the named phase
 * `rag-index-update` (was previously an unwrapped, invisible call).
 */
export const CANONICAL_PHASES = Object.freeze([
  'scan',
  'estimate',
  'triage',
  'bootstrap-doc',
  'doc-conflict-bootstrap',
  'rag-index',
  'internal-docs',
  'rag-index-update',
  'doc-conflict-update',
  'review',
  'refinement',
  'report',
] as const);

export type PhaseName = (typeof CANONICAL_PHASES)[number];

/**
 * Subset of RunContext consumed by `runPhase`. Using a structural interface
 * avoids importing the full RunContext from `run.ts`, preventing circular
 * dependencies. The real RunContext satisfies this interface.
 */
export interface RunPhaseContext {
  runId: string;
  startTime: number;
  timeline: Array<{ t: number; event: string; [k: string]: unknown }>;
  phaseDurations: Record<string, number>;
  runLog?: Logger;
  pipelineState?: { setPhase(phase: string): void };
  /** True for a non-TTY / `--plain` run. Drives console error verbosity. */
  plain?: boolean;
  /**
   * Run-fatal error latched by the orchestrator (e.g. provider-auth 401).
   * When set, `runPhase` rethrows it after the current phase unwinds, so a
   * single fatal error stops the whole pipeline regardless of which phase or
   * worker detected it.
   */
  fatalError?: unknown;
}

/**
 * Log a phase failure. Full diagnostics (with stack) always go to the run's
 * ndjson. The console gets the raw pino dump too — EXCEPT in a TUI (non-plain)
 * run when the error is a hint-bearing {@link AnatolyError}: there the command's
 * error handler renders a clean title + hint, and emitting the stack dump here
 * would bury it. Plain mode and hintless / non-Anatoly errors keep the full
 * console log so nothing is hidden when it actually aids debugging.
 */
function logPhaseFailure(
  ctx: RunPhaseContext,
  log: Logger,
  name: PhaseName,
  err: unknown,
  headline: string,
): void {
  const fields = { err, phase: name, runId: ctx.runId };
  ctx.runLog?.error(fields, headline);
  const suppressConsole = !ctx.plain && err instanceof AnatolyError && !!err.hint;
  if (!suppressConsole) {
    log.error(fields, headline);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DuplicatePhaseError extends Error {
  constructor(phase: string, runId: string) {
    super(`phase "${phase}" already executed in run ${runId}`);
    this.name = 'DuplicatePhaseError';
  }
}

// ---------------------------------------------------------------------------
// Internal state — duplicate tracking (WeakMap for GC-friendly per-ctx sets)
// ---------------------------------------------------------------------------

const executedPhases = new WeakMap<object, Set<string>>();

// ---------------------------------------------------------------------------
// runPhase
// ---------------------------------------------------------------------------

/**
 * Mandatory phase wrapper that emits 8 observability effects identically for
 * every pipeline phase, eliminating drift at the boundary.
 *
 * Entry effects (a–e):
 *   (a) `ctx.timeline.push({event:'phase_start', phase, t})`
 *   (b) `getLogger().info({event:'phase_start', phase, runId}, 'phase started')`
 *   (c) `ctx.runLog?.info({event:'phase_start', phase, runId}, 'phase started')`
 *   (d) `ctx.pipelineState?.setPhase(name)`
 *   (e) wraps `fn` in `runWithContext({phase: name}, fn)`
 *
 * Exit effects (f–h) — fire on both success and error:
 *   (f) `ctx.phaseDurations[name] = durationMs` (assignment, NEVER +=)
 *   (g) `ctx.timeline.push({event:'phase_end', phase, durationMs, t})`
 *   (h) symmetric `getLogger().info` + `ctx.runLog?.info` with phase_end
 *
 * doc 14 PR 1: the (a–c) and (g–h) triples are now fired through
 * `emitPhaseStart` / `emitPhaseEnd` in `events.ts` (the single event
 * vocabulary). Byte-equivalent: same field sets, same messages, same `t`
 * values (passed in, never recomputed). (d), (e), (f) and the error
 * `getLogger().error` stay here unchanged.
 *
 * On error: additionally logs via `getLogger().error`, attaches `phase` to
 * the error object, then rethrows.
 *
 * Duplicate guard: calling `runPhase(ctx, 'X', fn)` twice for the same phase
 * name on the same ctx throws `DuplicatePhaseError`.
 */
export async function runPhase<T>(
  ctx: RunPhaseContext,
  name: PhaseName,
  fn: () => Promise<T>,
): Promise<T> {
  // --- Duplicate guard ---
  let executed = executedPhases.get(ctx);
  if (!executed) {
    executed = new Set();
    executedPhases.set(ctx, executed);
  }
  if (executed.has(name)) {
    throw new DuplicatePhaseError(name, ctx.runId);
  }
  executed.add(name);

  const log = getLogger();
  const phaseStartedAt = Date.now();

  // --- Entry effects (a–e) ---

  // (a–c) phase_start triple, centralised in events.ts (byte-equivalent:
  // timeline push with the same `t`, getLogger().info, ctx.runLog?.info,
  // message 'phase started'). `tOffset` is the legacy
  // `phaseStartedAt - ctx.startTime`, passed in so it is never recomputed.
  emitPhaseStart(ctx, log, name, phaseStartedAt - ctx.startTime);

  // (d) ctx.pipelineState?.setPhase
  ctx.pipelineState?.setPhase(name);

  // (e) wrap fn in runWithContext
  let result: T;
  try {
    result = await runWithContext({ phase: name }, fn);
  } catch (err) {
    // --- Exit effects (f–h) on error ---
    fireExitEffects(ctx, log, name, phaseStartedAt);

    // Prefer the latched run-fatal error (more actionable, e.g. the auth
    // hint) over an incidental abort/timeout it may have triggered.
    const toThrow = ctx.fatalError ?? err;

    // Error logging
    logPhaseFailure(ctx, log, name, toThrow, `phase "${name}" failed`);

    // Attach phase to error object
    if (toThrow instanceof Error) {
      Object.assign(toThrow, { phase: name });
    }

    throw toThrow;
  }

  // --- Exit effects (f–h) on success: fire exactly once ---
  fireExitEffects(ctx, log, name, phaseStartedAt);

  // Orchestrator fail-fast: a phase may have latched a run-fatal error
  // (e.g. provider-auth 401) while still returning normally because the
  // failure was isolated per file/page. Surface it here so the whole run
  // stops instead of proceeding to the next phase. Thrown AFTER the try/catch
  // so it does not re-enter the catch — that re-entry was firing the exit
  // effects (phase_end timeline push, duration, log) and the error log twice.
  if (ctx.fatalError) {
    const fatal = ctx.fatalError;
    if (fatal instanceof Error) Object.assign(fatal, { phase: name });
    logPhaseFailure(ctx, log, name, fatal, `phase "${name}" aborted (fatal)`);
    throw fatal;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fireExitEffects(
  ctx: RunPhaseContext,
  log: Logger,
  name: PhaseName,
  phaseStartedAt: number,
): void {
  const durationMs = Date.now() - phaseStartedAt;

  // (f) phaseDurations assignment (=, NEVER +=). Stays here: this is run
  // accounting, not an event, and is asserted independently.
  ctx.phaseDurations[name] = durationMs;

  // (g–h) phase_end triple, centralised in events.ts (byte-equivalent:
  // timeline push with `durationMs` + the same `t`, symmetric
  // getLogger().info + ctx.runLog?.info, message 'phase ended'). The second
  // `Date.now()` is preserved (legacy computed `t` separately from
  // `durationMs`); fires on success and error exactly as before.
  emitPhaseEnd(ctx, log, name, durationMs, Date.now() - ctx.startTime);
}
