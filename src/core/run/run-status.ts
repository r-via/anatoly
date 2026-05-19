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
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
