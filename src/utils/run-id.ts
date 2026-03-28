// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { mkdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUN_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const TIMESTAMP_SUFFIX_RE = /\d{4}-\d{2}-\d{2}_\d{6}$/;

/** Extract the `YYYY-MM-DD_HHmmss` timestamp suffix from a run ID for chronological sorting. */
function extractTimestamp(runId: string): string {
  const m = runId.match(TIMESTAMP_SUFFIX_RE);
  return m ? m[0] : runId;
}

/**
 * Generate a timestamp-based run ID using the current local time.
 *
 * Without prefix the ID is `YYYY-MM-DD_HHmmss`.
 * With a prefix the ID is `<prefix>-YYYY-MM-DD_HHmmss`.
 *
 * @param prefix - Optional label prepended to the timestamp (e.g. `"scan"`, `"review"`).
 * @returns A run ID string that satisfies {@link isValidRunId}.
 */
export function generateRunId(prefix?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return prefix ? `${prefix}-${ts}` : ts;
}

/**
 * Validate a user-provided run ID.
 *
 * A valid run ID contains only alphanumeric characters, hyphens, and
 * underscores (`[a-zA-Z0-9_-]`) and is between 1 and 64 characters long.
 *
 * @param runId - The candidate run ID string to validate.
 * @returns `true` if the run ID satisfies the character-set and length constraints.
 */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_REGEX.test(runId) && runId.length > 0 && runId.length <= 64;
}

/**
 * Create the run directory structure and update the `latest` symlink.
 *
 * Creates `.anatoly/runs/<runId>/` with three subdirectories:
 * `logs/`, `reviews/`, and `conversations/`. Then updates the `latest`
 * pointer in the runs directory to point to this new run.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param runId - Unique identifier for the run (should satisfy {@link isValidRunId}).
 * @returns The absolute path to the newly created run directory.
 */
export function createRunDir(projectRoot: string, runId: string): string {
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
  const runDir = join(runsDir, runId);

  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reviews'), { recursive: true });
  mkdirSync(join(runDir, 'conversations'), { recursive: true });

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
    logPath: join(runDir, 'anatoly.ndjson'),
    conversationDir: join(runDir, 'conversations'),
  };
}

/**
 * Resolve a run directory from an optional run ID.
 *
 * - If `runId` is provided, resolves to `.anatoly/runs/<runId>/`.
 * - Otherwise, follows the `latest` pointer (symlink or text file).
 * - If the `latest` pointer is stale or missing, falls back to the most
 *   recent run from {@link listRuns} and repairs the pointer automatically.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param runId - Specific run ID to resolve. When omitted, resolves the latest run.
 * @returns The absolute path to the run directory, or `null` if no matching run exists.
 */
export function resolveRunDir(projectRoot: string, runId?: string): string | null {
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');

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
 * List all run IDs sorted chronologically by their timestamp suffix.
 *
 * Reads `.anatoly/runs/`, excludes the `latest` pointer, and sorts entries
 * by the trailing `YYYY-MM-DD_HHmmss` timestamp. IDs without a recognised
 * timestamp suffix fall back to lexicographic order.
 *
 * Returns an empty array if the runs directory does not exist or cannot be read.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Run ID strings in chronological order (oldest first).
 */
export function listRuns(projectRoot: string): string[] {
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
  try {
    return readdirSync(runsDir)
      .filter((entry) => entry !== 'latest')
      .sort((a, b) => {
        const tsA = extractTimestamp(a);
        const tsB = extractTimestamp(b);
        if (tsA !== tsB) return tsA < tsB ? -1 : 1;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

/**
 * Purge old runs, keeping only the most recent `keep` runs.
 *
 * Lists all runs via {@link listRuns} (chronological order), then
 * recursively deletes the oldest entries that exceed the `keep` threshold.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param keep - Number of most-recent runs to retain.
 * @returns The number of run directories deleted.
 */
export function purgeRuns(projectRoot: string, keep: number): number {
  const runs = listRuns(projectRoot);
  if (runs.length <= keep) return 0;

  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
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
function updateLatestPointer(runsDir: string, runId: string): void {
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
function readLatestPointer(runsDir: string): string | null {
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
