// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { mkdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { anatolyPath } from './anatoly-paths.js';
import {
  logsDir,
  reviewsDir,
  conversationsDir,
  runEventLogPath,
} from './run-layout.js';

const RUN_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate a timestamp-based run ID.
 * Without prefix: `YYYY-MM-DD_HHmmss`
 * With prefix: `<prefix>-YYYY-MM-DD_HHmmss`
 */
export function generateRunId(prefix?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return prefix ? `${prefix}-${ts}` : ts;
}

/**
 * Validate a user-provided run ID.
 */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_REGEX.test(runId) && runId.length > 0 && runId.length <= 64;
}

/**
 * Create the run directory structure and update the `latest` symlink.
 * Returns the absolute path to the run directory.
 */
export function createRunDir(projectRoot: string, runId: string): string {
  const runsDir = anatolyPath(projectRoot, 'runs');
  const runDir = join(runsDir, runId);

  mkdirSync(logsDir(runDir), { recursive: true });
  mkdirSync(reviewsDir(runDir), { recursive: true });
  mkdirSync(conversationsDir(runDir), { recursive: true });

  // Update `latest` pointer (symlink preferred, file fallback for Windows)
  updateLatestPointer(runsDir, runId);

  return runDir;
}

/**
 * Paths returned by {@link createMiniRun} for standalone command runs.
 */
export interface MiniRunPaths {
  runId: string;
  runDir: string;
  logPath: string;
  conversationDir: string;
}

/**
 * Create a mini-run directory for standalone commands (scan, estimate, review, watch).
 *
 * Generates a timestamped run ID with the given prefix, creates the full run
 * directory structure (including logs, reviews, and conversations subdirs), and
 * updates the `latest` symlink. Returns the paths the caller needs to set up
 * logging and store conversation artifacts.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param prefix - Short label prepended to the generated run ID (e.g. "scan", "review").
 * @returns Paths for the newly created mini-run directory.
 */
export function createMiniRun(projectRoot: string, prefix: string): MiniRunPaths {
  const runId = generateRunId(prefix);
  const runDir = createRunDir(projectRoot, runId);
  return {
    runId,
    runDir,
    logPath: runEventLogPath(runDir),
    conversationDir: conversationsDir(runDir),
  };
}

/**
 * Resolve a run directory from an optional run ID.
 * - If runId is provided, resolves to `.anatoly/runs/<runId>/`
 * - Otherwise, resolves to `.anatoly/runs/latest/` (symlink)
 * Returns null if the resolved directory doesn't exist.
 */
export function resolveRunDir(projectRoot: string, runId?: string): string | null {
  const runsDir = anatolyPath(projectRoot, 'runs');

  if (runId) {
    const runDir = join(runsDir, runId);
    try {
      lstatSync(runDir);
      return runDir;
    } catch {
      return null;
    }
  }

  // Try `latest` pointer (symlink or file)
  const latestRunId = readLatestPointer(runsDir);
  if (latestRunId) {
    const latestDir = join(runsDir, latestRunId);
    try {
      statSync(latestDir);
      return latestDir;
    } catch {
      // latest pointer is stale — fall through to recovery
    }
  }

  // Recovery: latest pointer missing or broken — find most recent run and repair
  const runs = listRuns(projectRoot);
  if (runs.length > 0) {
    const mostRecent = runs[runs.length - 1];
    updateLatestPointer(runsDir, mostRecent);
    return join(runsDir, mostRecent);
  }

  return null;
}

/**
 * List all run IDs sorted by name (chronological for timestamp-based IDs).
 */
export function listRuns(projectRoot: string): string[] {
  const runsDir = anatolyPath(projectRoot, 'runs');
  try {
    return readdirSync(runsDir)
      .filter((entry) => entry !== 'latest')
      .sort();
  } catch {
    return [];
  }
}

/**
 * Canonical CLI invocation that removes empty (phantom) runs.
 *
 * Single source of truth for the `anatoly runs remove --empty` command path,
 * so user-facing hints can never drift from the actually-registered command
 * (the subcommand group is `runs`, not `audit`).
 */
export const RUNS_REMOVE_EMPTY_CMD = 'anatoly runs remove --empty';

/**
 * Count runs that have no reviews ("empty" / phantom runs).
 *
 * A run is considered empty when its `reviews/` directory has zero entries
 * (or is missing). This mirrors the `--empty` filter of `anatoly runs remove`
 * so the warning count and the cleanup command always agree.
 */
export function countEmptyRuns(projectRoot: string): number {
  const runsDir = anatolyPath(projectRoot, 'runs');
  return listRuns(projectRoot).filter((id) => {
    try {
      return readdirSync(reviewsDir(join(runsDir, id))).length === 0;
    } catch {
      return true;
    }
  }).length;
}

/**
 * Purge old runs, keeping only the most recent `keep` runs.
 * Returns the number of runs deleted.
 */
export function purgeRuns(projectRoot: string, keep: number): number {
  const runs = listRuns(projectRoot);
  if (runs.length <= keep) return 0;

  const runsDir = anatolyPath(projectRoot, 'runs');
  const toDelete = runs.slice(0, runs.length - keep);
  for (const runId of toDelete) {
    rmSync(join(runsDir, runId), { recursive: true, force: true });
  }
  return toDelete.length;
}

/**
 * Update the `latest` pointer to a given run ID.
 * Tries a relative symlink first; falls back to a plain text file on Windows.
 */
export function updateLatestPointer(runsDir: string, runId: string): void {
  const latestPath = join(runsDir, 'latest');
  try {
    lstatSync(latestPath);
    unlinkSync(latestPath);
  } catch {
    // doesn't exist yet
  }

  try {
    symlinkSync(runId, latestPath);
  } catch {
    // Symlink failed (Windows without privileges) — write a plain text file
    writeFileSync(latestPath, runId);
  }
}

/**
 * Read the `latest` pointer — resolves both symlinks and plain text files.
 */
export function readLatestPointer(runsDir: string): string | null {
  const latestPath = join(runsDir, 'latest');
  try {
    const stat = lstatSync(latestPath);
    if (stat.isSymbolicLink()) {
      return readlinkSync(latestPath);
    }
    if (stat.isFile()) {
      return readFileSync(latestPath, 'utf-8').trim();
    }
  } catch {
    // doesn't exist
  }
  return null;
}
