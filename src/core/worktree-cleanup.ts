// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Worktree Cleanup — Story 47.7
 *
 * Removes orphaned git worktrees whose associated background runs have
 * completed, failed, or crashed. Active worktrees (running PID) are preserved.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRunStatus, isProcessAlive } from './run-status.js';

export interface CleanupResult {
  cleaned: number;
  failed: number;
  skipped: number;
}

/**
 * Scan `.anatoly/worktrees/` and remove orphaned worktrees.
 *
 * A worktree is considered orphaned when:
 * - Its associated run status is `done`, `failed`, or `crashed`
 * - Its associated run has no `run-status.json` (no run info at all)
 * - Its status is `running` but the PID no longer exists
 *
 * Active worktrees (running PID alive) are skipped.
 */
export function cleanupOrphanedWorktrees(projectRoot: string): CleanupResult {
  const root = resolve(projectRoot);
  const worktreesDir = join(root, '.anatoly', 'worktrees');
  const runsDir = join(root, '.anatoly', 'runs');

  if (!existsSync(worktreesDir)) return { cleaned: 0, failed: 0, skipped: 0 };

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir).filter((e) => !e.startsWith('.'));
  } catch {
    return { cleaned: 0, failed: 0, skipped: 0 };
  }

  let cleaned = 0;
  let failed = 0;
  let skipped = 0;

  for (const runId of entries) {
    const wtPath = join(worktreesDir, runId);
    const runDir = join(runsDir, runId);
    const status = readRunStatus(runDir);

    // Skip active worktrees — PID is alive and status is running
    if (status?.status === 'running' && isProcessAlive(status.pid)) {
      skipped++;
      continue;
    }

    // Try to remove the worktree
    if (removeWorktree(root, wtPath)) {
      cleaned++;
    } else {
      failed++;
    }
  }

  return { cleaned, failed, skipped };
}

/**
 * Attempt to remove a worktree directory.
 * Tries `git worktree remove`, then `--force`, then falls back to rmSync.
 * Returns true if removal succeeded.
 */
function removeWorktree(projectRoot: string, wtPath: string): boolean {
  // Try normal git worktree remove
  try {
    execFileSync('git', ['worktree', 'remove', wtPath], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Normal remove failed
  }

  // Try force remove
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Force remove also failed
  }

  // Last resort: just remove the directory (non-git cleanup)
  try {
    rmSync(wtPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
