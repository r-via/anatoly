// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { DISCOVERED_ACT_ID } from './clean.js';
import { REPORT_AXIS_IDS } from '../core/reporter.js';

const SHA_RE = /^[a-f0-9]{40}$/;

const AXIS_RE = /Source axis: (.+)/;
const FILE_RE = /in `([^`]+)`/;

/** A story from prd.json with at minimum these fields. */
export interface PrdStory {
  id: string;
  actId: string;
  passes: boolean;
  notes?: string;
  description?: string;
  [k: string]: unknown;
}

/** A batch of stories grouped by (axis, file). */
export interface StoryBatch {
  axis: string;
  file: string;
  stories: PrdStory[];
}

/**
 * Groups stories by (source axis, target file) for batched processing.
 * Returns batches sorted by the lowest priority within each batch.
 */
export function groupStoriesByAxisFile(stories: PrdStory[]): StoryBatch[] {
  const map = new Map<string, { axis: string; file: string; stories: PrdStory[] }>();

  for (const story of stories) {
    const axisMatch = story.notes?.match(AXIS_RE);
    const axis = axisMatch ? axisMatch[1] : '';
    const fileMatch = story.description?.match(FILE_RE);
    const file = fileMatch ? fileMatch[1] : '';
    const key = `${axis}\0${file}`;

    let batch = map.get(key);
    if (!batch) {
      batch = { axis, file, stories: [] };
      map.set(key, batch);
    }
    batch.stories.push(story);
  }

  // Sort batches by lowest priority in each batch
  return Array.from(map.values()).sort((a, b) => {
    const minA = Math.min(...a.stories.map((s) => (s as { priority?: number }).priority ?? Infinity));
    const minB = Math.min(...b.stories.map((s) => (s as { priority?: number }).priority ?? Infinity));
    return minA - minB;
  });
}

/** Circuit breaker state for the TypeScript clean-run loop. */
export interface CircuitBreakerState {
  consecutiveNoProgress: number;
  consecutiveSameError: number;
  lastProgressIteration: number;
  lastGoodSha: string;
}

/**
 * Number of consecutive no-progress iterations before the circuit breaker opens.
 * A "no progress" iteration is one where no git commits were made and HEAD is unchanged.
 */
export const CB_NO_PROGRESS_THRESHOLD = 3;
/**
 * Number of consecutive iterations with the same error before the circuit breaker opens.
 * Prevents the loop from burning tokens on a recurring issue that the agent cannot resolve.
 */
export const CB_SAME_ERROR_THRESHOLD = 5;

/** Checks whether a string is a full 40-character lowercase hex SHA. */
export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

/** Returns the current HEAD commit SHA for the repository at {@link cwd}, or an empty string on failure. */
export function getGitSha(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

/** Returns `true` when committed files have changed between {@link sinceSha} and HEAD. */
export function hasGitChanges(cwd: string, sinceSha: string): boolean {
  if (!isValidSha(sinceSha)) return false;
  try {
    const diff = execSync(`git diff --name-only ${sinceSha} HEAD`, { cwd, stdio: 'pipe' }).toString().trim();
    return diff.length > 0;
  } catch {
    return false;
  }
}

/** Returns `true` when the working tree at {@link cwd} has staged or unstaged changes. */
export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Hard-resets the repo at {@link cwd} to {@link sha}, stashing uncommitted changes first.
 * Returns `true` on success.
 */
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

/** Registers the `clean-run` CLI sub-command on the given Commander {@link program}. */
export function registerCleanRunCommand(program: Command): void {
  program
    .command('run <target>')
    .description('Run Ralph loop to remediate findings (axis name, "all", or shard file path)')
    .option('-n, --iterations <n>', 'max Ralph iterations', '50')
    .option('-m, --model <model>', 'Claude model to use (e.g. claude-opus-4-6, claude-sonnet-4-6)')
    .action(async (target: string, opts: { iterations: string; model?: string }) => {
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

        // --- Extract next batch from master PRD ---
        let masterPrd: { userStories: PrdStory[] };
        try {
          masterPrd = JSON.parse(readFileSync(prdPath, 'utf-8'));
        } catch {
          console.error(chalk.red('Failed to parse prd.json — aborting.'));
          process.exitCode = 1;
          return;
        }

        const originalStories = masterPrd.userStories.filter(
          (s) => s.actId !== DISCOVERED_ACT_ID,
        );
        const totalRemaining = originalStories.filter((s) => !s.passes).length;
        if (totalRemaining === 0) {
          console.log('');
          console.log(chalk.green(`All stories marked as passing. Finished at iteration ${i}.`));
          finalSync(projectRoot, reportFile);
          return;
        }

        const batches = groupStoriesByAxisFile(originalStories);
        const nextBatch = batches.find((b) => b.stories.some((s) => !s.passes));
        if (!nextBatch) {
          console.log('');
          console.log(chalk.green(`All stories marked as passing. Finished at iteration ${i}.`));
          finalSync(projectRoot, reportFile);
          return;
        }
        const pendingStories = nextBatch.stories.filter((s) => !s.passes);
        const firstId = pendingStories[0].id;
        const lastId = pendingStories[pendingStories.length - 1].id;
        const batchLabel = pendingStories.length === 1 ? firstId : `${firstId}..${lastId}`;

        console.log('===============================================================');
        console.log(`  Ralph Iteration ${i} of ${maxIterations} — [${nextBatch.axis}, ${nextBatch.file}]`);
        console.log(`  ${pendingStories.length} stories in batch (${batchLabel}) · ${totalRemaining} remaining total`);
        console.log('===============================================================');

        // Write batch file for the agent
        const batchPath = join(cleanDir, 'current-batch.json');
        writeFileSync(batchPath, JSON.stringify(pendingStories, null, 2));

        const preSha = getGitSha(projectRoot);

        // Read CLAUDE.md fresh each iteration (it doesn't change, but keep it clean)
        const claudeMd = readFileSync(claudeMdPath, 'utf-8');

        // Spawn a fresh Claude Code instance — stream output in real-time
        const { exitCode } = await new Promise<{ exitCode: number }>((res) => {
          const args = ['--dangerously-skip-permissions', '--print'];
          if (opts.model) args.push('--model', opts.model);
          const child = spawn('claude', args, {
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'inherit'],
          });

          child.stdout!.on('data', (chunk: Buffer) => {
            process.stdout.write(chunk);
          });

          child.on('close', (code) => {
            clearTimeout(timer);
            res({ exitCode: code ?? 1 });
          });

          child.on('error', () => {
            clearTimeout(timer);
            res({ exitCode: 1 });
          });

          // Feed prompt via stdin then close
          child.stdin!.end(claudeMd);

          // Timeout scales with batch size: 15 min base + 5 min per story
          const timeoutMs = (15 + pendingStories.length * 5) * 60 * 1000;
          const timer = setTimeout(() => {
            child.kill();
          }, timeoutMs);
        });

        const hasError = exitCode !== 0;

        // Sync current-batch.json results back to master PRD
        try {
          const updatedBatch: PrdStory[] = JSON.parse(readFileSync(batchPath, 'utf-8'));
          for (const updatedStory of updatedBatch) {
            const idx = masterPrd.userStories.findIndex((s) => s.id === updatedStory.id);
            if (idx !== -1) {
              masterPrd.userStories[idx] = updatedStory;
            }
          }
          writeFileSync(prdPath, JSON.stringify(masterPrd, null, 2));
        } catch {
          // Non-fatal — PRD sync failed, stories stay as-is
        }

        // Sync completed fixes back to the report
        try {
          execSync(`npx anatoly clean sync ${reportFile}`, {
            cwd: projectRoot,
            stdio: 'pipe',
          });
        } catch {
          // Non-fatal
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
