// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import chalk from 'chalk';
import { cleanupOrphanedWorktrees } from '../core/worktree-cleanup.js';

/**
 * Run auto-cleanup silently before any command.
 * Called from the CLI preAction hook. Only logs when worktrees were actually cleaned.
 */
export function runAutoGitCleanup(projectRoot: string): void {
  try {
    const result = cleanupOrphanedWorktrees(projectRoot);
    if (result.cleaned > 0) {
      console.log(chalk.dim(`Cleaned up ${result.cleaned} orphaned worktree(s)`));
    }
  } catch {
    // Auto-cleanup is best-effort — never block the actual command
  }
}

/** Registers the `git` CLI command group with subcommand `cleanup`. */
export function registerGitCommand(program: Command): void {
  const gitCmd = program
    .command('git')
    .description('Git-related housekeeping (worktrees)');

  gitCmd
    .command('cleanup')
    .description('Remove orphaned anatoly worktrees')
    .action(() => {
      const projectRoot = process.cwd();

      console.log(chalk.bold('anatoly — git cleanup'));
      console.log('');

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

      if (result.cleaned === 0 && result.failed === 0) {
        console.log('  Nothing to clean up.');
      }
    });
}
