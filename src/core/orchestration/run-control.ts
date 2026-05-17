// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Run-fatal control (relocated verbatim from commands/run.ts in PR 5,
 * doc 11). `requestFatalStop` latches `ctx.fatalError` and trips the SIGINT
 * plumbing; `runPhase` rethrows it at the next phase boundary. It lives here
 * (not run.ts) so the extracted phases can request a fatal stop without
 * importing back into the commands layer. `RunContext` is type-only
 * (erased); every remaining phase needs this helper.
 */

import { getLogger } from '../../utils/logger.js';
import type { RunContext } from '../../commands/run.js';

/**
 * Latch a run-fatal error and stop the run as fast as possible.
 *
 * Used when an agent surfaces a non-recoverable failure (today: provider-auth
 * 401) from inside an error-isolation boundary (per-file/per-page worker)
 * that would otherwise swallow it and let the run limp to `done`. First call
 * wins. Reuses the SIGINT plumbing: `interrupted` stops worker-pool dispatch
 * and phase progression; aborting `activeAborts` cancels in-flight SDK calls.
 * `runPhase` then rethrows `ctx.fatalError` at the next phase boundary, so it
 * reaches the top-level catch (failed status, exit code 2, actionable hint).
 */
export function requestFatalStop(ctx: RunContext, err: unknown): void {
  if (ctx.fatalError) return;
  ctx.fatalError = err;
  ctx.interrupted = true;
  for (const ac of ctx.activeAborts) ac.abort();
  getLogger().error(
    { err, runId: ctx.runId },
    'run aborted — non-recoverable error; stopping all phases',
  );
}
