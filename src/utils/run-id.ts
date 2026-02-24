import { mkdirSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUN_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate a timestamp-based run ID: YYYY-MM-DD_HHmmss
 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
  const runDir = join(runsDir, runId);

  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reviews'), { recursive: true });

  // Update `latest` pointer (symlink preferred, file fallback for Windows)
  updateLatestPointer(runsDir, runId);

  return runDir;
}

/**
 * Resolve a run directory from an optional run ID.
 * - If runId is provided, resolves to `.anatoly/runs/<runId>/`
 * - Otherwise, resolves to `.anatoly/runs/latest/` (symlink)
 * Returns null if the resolved directory doesn't exist.
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
      return null;
    }
  }

  return null;
}

/**
 * List all run IDs sorted by name (chronological for timestamp-based IDs).
 */
export function listRuns(projectRoot: string): string[] {
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
  try {
    return readdirSync(runsDir)
      .filter((entry) => entry !== 'latest')
      .sort();
  } catch {
    return [];
  }
}

/**
 * Purge old runs, keeping only the most recent `keep` runs.
 * Returns the number of runs deleted.
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
