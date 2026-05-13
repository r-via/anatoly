// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { getLogger } from '../../utils/logger.js';
import { runWithContext } from '../../utils/log-context.js';
import type { Logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The 11 canonical pipeline phases post-split (doc-conflict-detection → two
 * named phases: doc-conflict-bootstrap and doc-conflict-update).
 */
export const CANONICAL_PHASES = Object.freeze([
  'scan',
  'estimate',
  'triage',
  'bootstrap-doc',
  'doc-conflict-bootstrap',
  'rag-index',
  'internal-docs',
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

  // (a) timeline phase_start
  ctx.timeline.push({ event: 'phase_start', phase: name, t: phaseStartedAt - ctx.startTime });

  // (b) getLogger().info phase_start
  log.info({ event: 'phase_start', phase: name, runId: ctx.runId }, 'phase started');

  // (c) ctx.runLog?.info phase_start
  ctx.runLog?.info({ event: 'phase_start', phase: name, runId: ctx.runId }, 'phase started');

  // (d) ctx.pipelineState?.setPhase
  ctx.pipelineState?.setPhase(name);

  // (e) wrap fn in runWithContext
  try {
    const result = await runWithContext({ phase: name }, fn);

    // --- Exit effects (f–h) on success ---
    fireExitEffects(ctx, log, name, phaseStartedAt);

    return result;
  } catch (err) {
    // --- Exit effects (f–h) on error ---
    fireExitEffects(ctx, log, name, phaseStartedAt);

    // Error logging
    log.error({ err, phase: name, runId: ctx.runId }, `phase "${name}" failed`);

    // Attach phase to error object
    if (err instanceof Error) {
      Object.assign(err, { phase: name });
    }

    throw err;
  }
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

  // (f) phaseDurations assignment (=, NEVER +=)
  ctx.phaseDurations[name] = durationMs;

  // (g) timeline phase_end
  ctx.timeline.push({ event: 'phase_end', phase: name, durationMs, t: Date.now() - ctx.startTime });

  // (h) symmetric logger + runLog phase_end
  log.info({ event: 'phase_end', phase: name, durationMs, runId: ctx.runId }, 'phase ended');
  ctx.runLog?.info({ event: 'phase_end', phase: name, durationMs, runId: ctx.runId }, 'phase ended');
}
