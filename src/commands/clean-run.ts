// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { parseUncheckedActions, DISCOVERED_ACT_ID } from './clean.js';
import { REPORT_AXIS_IDS, type ReportAxisId } from '../core/reporter.js';

const COMPLETION_SIGNAL = '<promise>COMPLETE</promise>';

const SHA_RE = /^[a-f0-9]{40}$/;

/** Circuit breaker state for the TypeScript clean-run loop. */
export interface CircuitBreakerState {
  consecutiveNoProgress: number;
  consecutiveSameError: number;
  lastProgressIteration: number;
  lastGoodSha: string;
}

export const CB_NO_PROGRESS_THRESHOLD = 3;
export const CB_SAME_ERROR_THRESHOLD = 5;

export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

export function getGitSha(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

export function hasGitChanges(cwd: string, sinceSha: string): boolean {
  if (!isValidSha(sinceSha)) return false;
  try {
    const diff = execSync(`git diff --name-only ${sinceSha} HEAD`, { cwd, stdio: 'pipe' }).toString().trim();
    return diff.length > 0;
  } catch {
    return false;
  }
}

export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

export function rollbackToSha(cwd: string, sha: string): boolean {
  if (!isValidSha(sha)) return false;
  if (hasUncommittedChanges(cwd)) {
    try {
      execSync('git stash --include-untracked', { cwd, stdio: 'pipe' });
      console.log(chalk.yellow('Stashed uncommitted changes before rollback.'));
    } catch {
      console.log(chalk.red('Failed to stash uncommitted changes — aborting rollback.'));
      return false;
    }
  }
  try {
    execSync(`git reset --hard ${sha}`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function openCircuitBreaker(
  reason: string,
  detail: string,
  cb: CircuitBreakerState,
  postSha: string,
  projectRoot: string,
  reportFile: string,
): void {
  console.log('');
  console.log(chalk.red('==============================================================='));
  console.log(chalk.red(`  CIRCUIT BREAKER OPEN — ${reason}`));
  console.log(chalk.red(`  ${detail}`));
  console.log(chalk.red('==============================================================='));

  if (cb.lastGoodSha && cb.lastGoodSha !== postSha) {
    console.log(chalk.yellow(`Rolling back to last good commit: ${cb.lastGoodSha.slice(0, 8)}`));
    if (rollbackToSha(projectRoot, cb.lastGoodSha)) {
      console.log(chalk.green('Rollback successful.'));
    } else {
      console.log(chalk.red('Rollback failed — manual intervention required.'));
    }
  }

  finalSync(projectRoot, reportFile);
  process.exitCode = 1;
}

function finalSync(projectRoot: string, reportFile: string): void {
  try {
    console.log(chalk.blue('Final sync...'));
    execSync(`npx anatoly clean sync ${reportFile}`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  } catch {
    // Non-fatal
  }
}

export function registerCleanRunCommand(program: Command): void {
  program
    .command('run <target>')
    .description('Run Ralph loop to remediate findings (axis name, "all", or shard file path)')
    .option('-n, --iterations <n>', 'max Ralph iterations', '10')
    .action(async (target: string, opts: { iterations: string }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before running this command.'));
        process.exitCode = 1;
        return;
      }

      const maxIterations = parseInt(opts.iterations, 10) || 10;

      // Resolve target: "all", axis name, or file path
      const validNames = new Set<string>([...REPORT_AXIS_IDS, 'all']);
      let cleanName: string;
      let reportFile: string;

      if (validNames.has(target)) {
        // Named target — resolve clean dir directly
        cleanName = target;
        reportFile = target; // used for clean-sync calls
      } else {
        // File path target (legacy)
        const absPath = resolve(projectRoot, target);
        if (!existsSync(absPath)) {
          console.error(chalk.red(`Unknown target: ${target}`));
          console.error(`Valid targets: all, ${REPORT_AXIS_IDS.join(', ')}, or a shard file path`);
          process.exit(1);
        }
        cleanName = basename(target, '.md');
        reportFile = target;
      }

      const cleanDir = resolve(projectRoot, '.anatoly', 'clean', cleanName);
      const prdPath = join(cleanDir, 'prd.json');
      const claudeMdPath = join(cleanDir, 'CLAUDE.md');

      // Generate artifacts if not already present
      if (!existsSync(prdPath) || !existsSync(claudeMdPath)) {
        console.log(chalk.blue('Generating clean artifacts...'));
        execSync(`npx anatoly clean generate ${target}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      }

      // Verify artifacts were created
      if (!existsSync(prdPath)) {
        console.log(chalk.yellow('No unchecked actions found — nothing to clean.'));
        return;
      }

      // --- Branch isolation: ensure we never run on main ---
      const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
      const branchName: string = prd.branchName;
      if (!branchName) {
        console.error(chalk.red('No branchName found in prd.json — aborting.'));
        process.exit(1);
      }

      const currentBranch = execSync('git branch --show-current', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
      if (currentBranch !== branchName) {
        try {
          // Try to checkout existing branch, or create from current HEAD
          execSync(`git checkout ${branchName} 2>/dev/null || git checkout -b ${branchName}`, {
            cwd: projectRoot,
            stdio: 'pipe',
            shell: '/bin/bash',
          });
        } catch {
          console.error(chalk.red(`Failed to checkout branch ${branchName} — aborting.`));
          process.exit(1);
        }
        const verified = execSync('git branch --show-current', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
        if (verified !== branchName) {
          console.error(chalk.red(`Branch verification failed: expected ${branchName}, got ${verified}`));
          process.exit(1);
        }
        console.log(chalk.green(`\u2713 On branch ${branchName}`));
      } else {
        console.log(chalk.green(`\u2713 Already on branch ${branchName}`));
      }

      console.log('');
      console.log(chalk.blue(`Ralph clean loop \u2014 ${maxIterations} iterations max`));
      console.log('');

      // Circuit breaker state
      const cb: CircuitBreakerState = {
        consecutiveNoProgress: 0,
        consecutiveSameError: 0,
        lastProgressIteration: 0,
        lastGoodSha: getGitSha(projectRoot),
      };

      const PROTECTED_BRANCHES = new Set(['main', 'master']);

      for (let i = 1; i <= maxIterations; i++) {
        // Per-iteration guard: abort if somehow back on a protected branch
        const iterBranch = execSync('git branch --show-current', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
        if (PROTECTED_BRANCHES.has(iterBranch)) {
          console.error(chalk.red(`ABORT: detected protected branch "${iterBranch}" at iteration ${i} — refusing to continue.`));
          process.exitCode = 1;
          return;
        }

        console.log('===============================================================');
        console.log(`  Ralph Iteration ${i} of ${maxIterations}`);
        console.log('===============================================================');

        const preSha = getGitSha(projectRoot);

        // Read CLAUDE.md fresh each iteration (it doesn't change, but keep it clean)
        const claudeMd = readFileSync(claudeMdPath, 'utf-8');

        // Spawn a fresh Claude Code instance — stream output in real-time
        const { output, exitCode } = await new Promise<{ output: string; exitCode: number }>((res) => {
          const chunks: Buffer[] = [];
          const child = spawn('claude', ['--dangerously-skip-permissions', '--print'], {
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'inherit'],
          });

          child.stdout!.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            process.stdout.write(chunk);
          });

          child.on('close', (code) => {
            res({ output: Buffer.concat(chunks).toString(), exitCode: code ?? 1 });
          });

          child.on('error', () => {
            res({ output: Buffer.concat(chunks).toString(), exitCode: 1 });
          });

          // Feed prompt via stdin then close
          child.stdin!.end(claudeMd);

          // 15 min timeout
          setTimeout(() => {
            child.kill();
          }, 15 * 60 * 1000);
        });

        const hasError = exitCode !== 0;

        // Sync completed fixes back to the report
        try {
          execSync(`npx anatoly clean sync ${reportFile}`, {
            cwd: projectRoot,
            stdio: 'pipe',
          });
        } catch {
          // Non-fatal
        }

        // Check for completion signal
        if (output.includes(COMPLETION_SIGNAL)) {
          console.log('');
          console.log(chalk.green(`All clean tasks complete! Finished at iteration ${i}.`));
          finalSync(projectRoot, reportFile);
          return;
        }

        // Check if all original stories pass in prd.json (discovered stories don't block completion)
        try {
          const currentPrd = JSON.parse(readFileSync(prdPath, 'utf-8'));
          const originalStories = currentPrd.userStories?.filter(
            (s: { actId: string }) => s.actId !== DISCOVERED_ACT_ID,
          );
          const allDone = originalStories?.length > 0 && originalStories.every((s: { passes: boolean }) => s.passes);
          if (allDone) {
            console.log('');
            console.log(chalk.green(`All stories marked as passing. Finished at iteration ${i}.`));
            finalSync(projectRoot, reportFile);
            return;
          }
        } catch {
          // Continue if prd.json can't be parsed
        }

        // --- Circuit breaker evaluation ---
        const postSha = getGitSha(projectRoot);
        const madeProgress = postSha !== preSha || hasGitChanges(projectRoot, preSha);

        if (madeProgress) {
          cb.consecutiveNoProgress = 0;
          cb.lastProgressIteration = i;
          cb.lastGoodSha = postSha;
        } else {
          cb.consecutiveNoProgress++;
        }

        // Error counter is independent of progress — an iteration can make progress but still exit with error
        if (hasError && !madeProgress) {
          cb.consecutiveSameError++;
        } else {
          cb.consecutiveSameError = 0;
        }

        // Check circuit breaker thresholds
        if (cb.consecutiveNoProgress >= CB_NO_PROGRESS_THRESHOLD) {
          openCircuitBreaker(
            'No progress detected',
            `${cb.consecutiveNoProgress} consecutive iterations without changes`,
            cb, postSha, projectRoot, reportFile,
          );
          return;
        }

        if (cb.consecutiveSameError >= CB_SAME_ERROR_THRESHOLD) {
          openCircuitBreaker(
            'Repeated errors detected',
            `${cb.consecutiveSameError} consecutive iterations with errors`,
            cb, postSha, projectRoot, reportFile,
          );
          return;
        }

        // Warn in half-open state
        if (cb.consecutiveNoProgress >= 2) {
          console.log(chalk.yellow(`  Warning: ${cb.consecutiveNoProgress} iterations without progress (circuit breaker at ${CB_NO_PROGRESS_THRESHOLD})`));
        }

        console.log(`\nIteration ${i} complete.\n`);
      }

      console.log('');
      console.log(chalk.yellow(`Ralph reached max iterations (${maxIterations}).`));
      console.log(chalk.yellow(`Check .anatoly/clean/${cleanName}/progress.txt for status.`));
      finalSync(projectRoot, reportFile);
      process.exitCode = 1;
    });
}
