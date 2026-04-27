// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import chalk from 'chalk';
import { cleanupOrphanedWorktrees } from '../core/worktree-cleanup.js';
import { listRunStatuses, isProcessAlive, writeRunStatus } from '../core/run-status.js';
import { resolveRunDir } from '../utils/run-id.js';

/**
 * Run auto-cleanup silently before any command.
 * Called from the CLI preAction hook. Only logs when worktrees were actually cleaned.
 */
export function runAutoCleanup(projectRoot: string): void {
  try {
    const result = cleanupOrphanedWorktrees(projectRoot);
    if (result.cleaned > 0) {
      console.log(chalk.dim(`Cleaned up ${result.cleaned} orphaned worktree(s)`));
    }
  } catch {
    // Auto-cleanup is best-effort — never block the actual command
  }
}

/** Registers the `cleanup` CLI sub-command. */
export function registerCleanupCommand(program: Command): void {
  program
    .command('cleanup')
    .description('Remove orphaned worktrees and fix stale run statuses')
    .action(() => {
      const projectRoot = process.cwd();

      console.log(chalk.bold('anatoly — cleanup'));
      console.log('');

      // 1. Fix stale running statuses (PID dead → crashed)
      let fixedCount = 0;
      const statuses = listRunStatuses(projectRoot);
      for (const status of statuses) {
        if (status.status === 'running' && !isProcessAlive(status.pid)) {
          status.status = 'crashed';
          status.completedAt = new Date().toISOString();
          const dir = resolveRunDir(projectRoot, status.runId);
          if (dir) {
            writeRunStatus(dir, status);
            fixedCount++;
          }
        }
      }

      if (fixedCount > 0) {
        console.log(`  Fixed ${fixedCount} stale run status(es) → crashed`);
      }

      // 2. Clean orphaned worktrees
      const result = cleanupOrphanedWorktrees(projectRoot);

      if (result.cleaned > 0) {
        console.log(`  Removed ${result.cleaned} orphaned worktree(s)`);
      }
      if (result.failed > 0) {
        console.log(chalk.yellow(`  Failed to remove ${result.failed} worktree(s)`));
      }
      if (result.skipped > 0) {
        console.log(chalk.dim(`  Skipped ${result.skipped} active worktree(s)`));
      }

      if (fixedCount === 0 && result.cleaned === 0 && result.failed === 0) {
        console.log('  Nothing to clean up.');
      }
    });
}
