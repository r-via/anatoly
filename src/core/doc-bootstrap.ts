// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc Bootstrap Helpers — Story 29.21
 *
 * Detection logic for first-run bootstrap and double-pass review decisions.
 *
 * The canonical "docs are valid" signal is a `.scaffold-status.json` tag
 * written by {@link writeScaffoldStatus} after runDocBootstrap or
 * runDocUpdate completes (i.e. after the refinement / coherence passes).
 * Looking at file existence alone is not enough: a crashed scaffolder can
 * leave `.anatoly/docs/` partially populated, and manual edits can leave
 * the cache in an inconsistent state.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ScaffoldStatus {
  /** Bumped when the file format changes incompatibly. */
  readonly schemaVersion: 1;
  /** ISO-8601 timestamp of the last successful scaffold or update. */
  readonly scaffoldedAt: string;
  /** Whether the last successful pipeline was a fresh scaffold or an update. */
  readonly lastMode: 'bootstrap' | 'update';
  /** Run id that produced this status — useful for cross-referencing run-metrics.json. */
  readonly lastRunId?: string;
}

/** Path to the scaffold-status tag, relative to `projectRoot`. */
function statusPath(projectRoot: string): string {
  return join(projectRoot, '.anatoly', 'docs', '.scaffold-status.json');
}

/**
 * Detect whether this run needs the bootstrap doc phase.
 *
 * The canonical signal is the `.scaffold-status.json` tag — its presence
 * with a recognised `schemaVersion` certifies that a previous run completed
 * the scaffold + refinement passes successfully. When the tag is missing,
 * we fall through to a legacy heuristic (index.md + .cache.json both
 * present) so users with pre-tag installations don't get re-bootstrapped
 * spuriously on their next run.
 */
export function needsBootstrap(projectRoot: string): boolean {
  const docsDir = join(projectRoot, '.anatoly', 'docs');
  if (!existsSync(docsDir)) return true;

  // Canonical signal: scaffold-status tag.
  const sp = statusPath(projectRoot);
  if (existsSync(sp)) {
    try {
      const parsed = JSON.parse(readFileSync(sp, 'utf-8')) as Partial<ScaffoldStatus>;
      if (parsed.schemaVersion === 1) return false;
    } catch {
      // corrupt tag → fall through to the legacy check
    }
  }

  // Legacy compat: pre-tag installations relied on index.md + .cache.json
  // as the implicit completion marker. Treat them as scaffolded; the next
  // successful run will then write the canonical tag.
  const hasIndex = existsSync(join(docsDir, 'index.md'));
  const hasCache = existsSync(join(docsDir, '.cache.json'));
  return !hasIndex || !hasCache;
}

/**
 * Write the scaffold-status tag, marking the docs as validly scaffolded.
 * Called after `runDocBootstrap` (first run) or `runDocUpdate` (subsequent
 * runs) returns successfully — i.e. after the refinement / coherence
 * passes complete. A scaffolder that crashes mid-pipeline never writes
 * the tag, so the next run correctly re-bootstraps.
 *
 * Defensive: file-write failures are swallowed (the run itself shouldn't
 * fail because we couldn't write a status marker).
 */
export function writeScaffoldStatus(
  projectRoot: string,
  info: { mode: 'bootstrap' | 'update'; runId?: string },
): void {
  const docsDir = join(projectRoot, '.anatoly', 'docs');
  if (!existsSync(docsDir)) return;
  const status: ScaffoldStatus = {
    schemaVersion: 1,
    scaffoldedAt: new Date().toISOString(),
    lastMode: info.mode,
    ...(info.runId ? { lastRunId: info.runId } : {}),
  };
  try {
    writeFileSync(statusPath(projectRoot), JSON.stringify(status, null, 2) + '\n');
  } catch {
    /* status-tag write is best-effort */
  }
}

/** Read the scaffold-status tag, or `null` if missing/corrupt. Useful for tooling that wants to inspect when the docs were last validated. */
export function readScaffoldStatus(projectRoot: string): ScaffoldStatus | null {
  const sp = statusPath(projectRoot);
  if (!existsSync(sp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(sp, 'utf-8')) as Partial<ScaffoldStatus>;
    if (parsed.schemaVersion === 1 && typeof parsed.scaffoldedAt === 'string' && (parsed.lastMode === 'bootstrap' || parsed.lastMode === 'update')) {
      return parsed as ScaffoldStatus;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether to skip the double-pass review on first run.
 *
 * If >= 50% of bootstrap pages failed LLM generation, the double pass
 * would gain little from the incomplete internal docs.
 */
export function shouldSkipDoublePass(pagesFailed: number, totalPages: number): boolean {
  if (totalPages === 0) return false;
  return pagesFailed >= totalPages * 0.5;
}
