// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Git Worktree Manager — Story 47.1
 *
 * Creates and removes git worktrees for background review runs.
 * Each worktree is a detached-HEAD snapshot of the current commit,
 * stored under `.anatoly/worktrees/<runId>/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

// --- Types ---

export interface WorktreeManager {
  /** Create a detached-HEAD worktree for the given runId. Returns absolute path. */
  create(runId: string): Promise<string>;
  /** Remove the worktree for the given runId. Never throws. */
  remove(runId: string): Promise<void>;
}

// --- Helpers ---

const WORKTREES_DIR = '.anatoly/worktrees';
const CLEANUP_FLAG_FILE = '.needs-cleanup.json';

function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function readCleanupFlags(flagPath: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(flagPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCleanupFlags(flagPath: string, flags: Record<string, string>): void {
  mkdirSync(join(flagPath, '..'), { recursive: true });
  writeFileSync(flagPath, JSON.stringify(flags, null, 2));
}

// --- Factory ---

/**
 * Create a WorktreeManager bound to a project root directory.
 * Throws immediately if the directory is not a git repository.
 */
export function createWorktreeManager(projectRoot: string): WorktreeManager {
  const root = resolve(projectRoot);

  if (!isGitRepo(root)) {
    throw new Error('Not a git repository');
  }

  const worktreesBase = join(root, WORKTREES_DIR);
  const flagPath = join(worktreesBase, CLEANUP_FLAG_FILE);

  return {
    async create(runId: string): Promise<string> {
      const wtPath = join(worktreesBase, runId);

      if (existsSync(wtPath)) {
        throw new Error(`Worktree already exists for run: ${runId}`);
      }

      mkdirSync(worktreesBase, { recursive: true });

      execFileSync('git', ['worktree', 'add', '--detach', wtPath, 'HEAD'], {
        cwd: root,
        stdio: 'ignore',
      });

      return wtPath;
    },

    async remove(runId: string): Promise<void> {
      const wtPath = join(worktreesBase, runId);

      try {
        execFileSync('git', ['worktree', 'remove', wtPath], {
          cwd: root,
          stdio: 'ignore',
        });
      } catch {
        // If the worktree directory still exists, try force removal
        if (existsSync(wtPath)) {
          try {
            execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
              cwd: root,
              stdio: 'ignore',
            });
          } catch {
            // Force removal also failed — persist needsCleanup flag
            const flags = readCleanupFlags(flagPath);
            flags[runId] = new Date().toISOString();
            writeCleanupFlags(flagPath, flags);
          }
        } else {
          // Directory gone but git worktree metadata may be stale — prune and persist flag
          try {
            execSync('git worktree prune', { cwd: root, stdio: 'ignore' });
          } catch {
            // ignore prune failure
          }
          const flags = readCleanupFlags(flagPath);
          flags[runId] = new Date().toISOString();
          writeCleanupFlags(flagPath, flags);
        }
      }
    },
  };
}
