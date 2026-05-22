// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Run Status Persistence — Story 47.3
 *
 * Persists and reads run lifecycle state in `.anatoly/runs/<runId>/run-status.json`.
 * Used by background runs to communicate status and by `anatoly status` to display it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { runStatusPath } from '../../utils/run-layout.js';
import { execFileSync } from 'node:child_process';

export type RunStatusState = 'running' | 'done' | 'failed' | 'crashed';

export interface RunStatus {
  runId: string;
  pid: number;
  status: RunStatusState;
  startedAt: string;
  completedAt?: string;
  error?: string;
  branch?: string;
  commit?: string;
  background: boolean;
}

/**
 * Write run-status.json to the given run directory.
 * Creates parent directories if needed.
 */
export function writeRunStatus(runDir: string, status: RunStatus): void {
  mkdirSync(runDir, { recursive: true });
  const statusPath = runStatusPath(runDir);
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n');
}

/**
 * Read run-status.json from the given run directory.
 * Returns undefined if the file does not exist or is invalid.
 */
export function readRunStatus(runDir: string): RunStatus | undefined {
  const statusPath = runStatusPath(runDir);
  if (!existsSync(statusPath)) return undefined;
  try {
    return JSON.parse(readFileSync(statusPath, 'utf-8')) as RunStatus;
  } catch {
    return undefined;
  }
}

/**
 * List all run statuses from `.anatoly/runs/` that have a `run-status.json`.
 * Returns statuses sorted by runId (chronological for timestamp-based IDs).
 */
export function listRunStatuses(projectRoot: string): RunStatus[] {
  const runsDir = anatolyPath(projectRoot, 'runs');
  let entries: string[];
  try {
    entries = readdirSync(runsDir).filter((e) => e !== 'latest').sort();
  } catch {
    return [];
  }

  const statuses: RunStatus[] = [];
  for (const entry of entries) {
    const status = readRunStatus(join(runsDir, entry));
    if (status) statuses.push(status);
  }
  return statuses;
}

/**
 * Check whether a process with the given PID is still alive.
 * Uses `process.kill(pid, 0)` which checks existence without sending a signal.
 *
 * EPERM means the process exists but the caller does not own it (typically
 * cross-user); treat that as alive. Only ESRCH (or other unknown errors)
 * mean the process is gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Outcome of {@link detectResumableRun}.
 *
 * - `runId` — id of the previous run we can resume into
 * - `state` — its persisted status (failed / crashed / running-with-dead-pid)
 * - `pending` — number of files in PENDING/ERROR/IN_PROGRESS/TIMEOUT
 * - `done` — number of files in DONE/CACHED (already evaluated, will be skipped)
 */
export interface ResumableRun {
  runId: string;
  state: 'failed' | 'crashed' | 'stale-running';
  pending: number;
  done: number;
}

/**
 * Detect whether the most recent run on this project is INCOMPLETE and worth
 * resuming. Used by `anatoly run` to surface a "found an unfinished run —
 * resume it?" prompt instead of silently starting a fresh run on top of the
 * stale one. Returns `undefined` when nothing is resumable (no prior run, the
 * prior run is `done`, or the project has no pending work left in progress.json).
 *
 * A run is considered resumable when its status is `failed` / `crashed` / a
 * `running` entry whose PID is dead, AND the project's progress.json still
 * has at least one file in PENDING / ERROR / IN_PROGRESS / TIMEOUT — i.e. the
 * orchestrator's review-phase entry path actually has files to process.
 */
export function detectResumableRun(projectRoot: string): ResumableRun | undefined {
  const statuses = listRunStatuses(projectRoot);
  if (statuses.length === 0) return undefined;
  // listRunStatuses returns chronological asc; the last is the most recent.
  const latest = statuses[statuses.length - 1];

  let state: ResumableRun['state'];
  if (latest.status === 'failed' || latest.status === 'crashed') {
    state = latest.status;
  } else if (latest.status === 'running' && !isProcessAlive(latest.pid)) {
    state = 'stale-running';
  } else {
    return undefined; // done, or actively running
  }

  // Count files left to evaluate per progress.json
  const progressPath = join(anatolyPath(projectRoot, 'cache'), 'progress.json');
  if (!existsSync(progressPath)) return undefined;
  let progress: { files?: Record<string, { status?: string }> };
  try {
    progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
  } catch {
    return undefined;
  }

  let pending = 0;
  let done = 0;
  for (const fp of Object.values(progress.files ?? {})) {
    const s = fp.status;
    if (s === 'PENDING' || s === 'ERROR' || s === 'IN_PROGRESS' || s === 'TIMEOUT') pending++;
    else if (s === 'DONE' || s === 'CACHED') done++;
  }
  if (pending === 0) return undefined; // nothing left to do

  return { runId: latest.runId, state, pending, done };
}

/**
 * Sort run statuses for display: running runs first, then by startedAt descending.
 * Does not mutate the input array.
 */
export function sortRunStatusesForDisplay(statuses: RunStatus[]): RunStatus[] {
  return [...statuses].sort((a, b) => {
    // Running runs first
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    // Then by startedAt descending (most recent first)
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });
}

/**
 * Get current git branch and short commit hash.
 * Returns undefined values if not in a git repo.
 */
export function getGitInfo(projectRoot: string): { branch?: string; commit?: string } {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return { branch, commit };
  } catch {
    return {};
  }
}
