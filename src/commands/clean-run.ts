// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';

/** Currently running Claude child process — killed on SIGINT/SIGTERM. */
let activeChild: ChildProcess | null = null;
/** Branch the user was on before the clean run switched to the clean branch. */
let originalBranch: string | null = null;

function killActiveChild(): void {
  if (activeChild && !activeChild.killed) {
    activeChild.kill('SIGTERM');
    // If SIGTERM doesn't work, force-kill after 3s
    setTimeout(() => {
      if (activeChild && !activeChild.killed) activeChild.kill('SIGKILL');
    }, 3000).unref();
  }
}

function restoreOriginalBranch(): void {
  if (!originalBranch) return;
  try {
    const cwd = process.cwd();
    // Stash any uncommitted changes so checkout doesn't fail
    const status = execSync('git status --porcelain', { cwd, stdio: 'pipe' }).toString().trim();
    if (status) {
      execSync('git stash --include-untracked -m "anatoly clean-run: interrupted"', { cwd, stdio: 'pipe' });
    }
    execSync(`git checkout ${originalBranch}`, { cwd, stdio: 'pipe' });
    // Pop stash on the original branch so changes are preserved
    if (status) {
      execSync('git stash pop', { cwd, stdio: 'pipe' });
    }
  } catch {
    // Best effort — don't crash the exit handler
  }
}

process.on('SIGINT', () => { killActiveChild(); restoreOriginalBranch(); process.exit(130); });
process.on('SIGTERM', () => { killActiveChild(); restoreOriginalBranch(); process.exit(143); });
import { DISCOVERED_ACT_ID } from './clean.js';
import { REPORT_AXIS_IDS } from '../core/reporter.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';

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

  syncToReport(projectRoot, reportFile);
  process.exitCode = 1;
}

function syncToReport(projectRoot: string, reportFile: string): void {
  try {
    execSync(`npx anatoly clean sync ${reportFile}`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Registers the `clean-run` CLI sub-command on the given Commander {@link program}.
 *
 * The command accepts a `<target>` argument (`"all"`, an axis name from {@link REPORT_AXIS_IDS},
 * or a shard file path) and two options:
 * - `-n, --iterations <n>` — maximum clean-loop iterations (default 50, parsed as 10 on NaN)
 * - `-m, --model <model>` — Claude model override (e.g. `claude-opus-4-6`)
 *
 * **Workflow:**
 * 1. Generates clean artifacts (`prd.json`, `CLAUDE.md`) via `anatoly clean generate` if absent.
 * 2. Reads `branchName` from `prd.json` and switches to (or creates) that branch for isolation.
 * 3. Iterates up to `maxIterations` times, each iteration:
 *    - Extracts the next pending batch (grouped by axis + file) from the master PRD.
 *    - Writes the batch to `current-batch.json` and spawns a Claude Code subprocess to fix it.
 *    - Retries the spawn up to {@link MAX_SPAWN_RETRIES} times with exponential backoff on
 *      transient failures (exit code !== 0 with no partial progress).
 *    - Merges results from `current-batch.json` back into the master PRD.
 *    - Evaluates circuit breaker conditions (see {@link CB_NO_PROGRESS_THRESHOLD} and
 *      {@link CB_SAME_ERROR_THRESHOLD}); opens the breaker and rolls back on repeated stalls.
 * 4. Syncs completed fixes back to the report file after each iteration and on exit.
 *
 * Uses {@link PipelineState} and {@link ScreenRenderer} for terminal progress display.
 * Registers SIGINT/SIGTERM handlers to kill the active child process, restore the original
 * branch, and exit cleanly.
 */
export function registerCleanRunCommand(program: Command): void {
  program
    .command('run <target>')
    .description('Run clean loop to remediate findings (axis name, "all", or shard file path)')
    .option('-n, --iterations <n>', 'max clean loop iterations', '50')
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
      let prd: { branchName?: string };
      try {
        prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
      } catch {
        console.error(chalk.red(`Failed to read or parse ${prdPath} — aborting.`));
        process.exit(1);
      }
      const branchName: string = prd.branchName!;
      if (!branchName) {
        console.error(chalk.red('No branchName found in prd.json — aborting.'));
        process.exit(1);
      }

      const currentBranch = execSync('git branch --show-current', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
      originalBranch = currentBranch !== branchName ? currentBranch : null;
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

      // --- Read initial PRD to get total count ---
      const initialPrd: { userStories: PrdStory[] } = JSON.parse(readFileSync(prdPath, 'utf-8'));
      const allOriginal = initialPrd.userStories.filter((s) => s.actId !== DISCOVERED_ACT_ID);
      const totalStories = allOriginal.length;
      const initialFixed = allOriginal.filter((s) => s.passes).length;

      // --- Pipeline display ---
      const state = new PipelineState();
      state.addTask('clean', 'Auto cleaning');
      state.startTask('clean', `${initialFixed}/${totalStories} findings fixed`);

      const renderer = new ScreenRenderer(state);
      renderer.start();

      // Circuit breaker state
      const cb: CircuitBreakerState = {
        consecutiveNoProgress: 0,
        consecutiveSameError: 0,
        lastProgressIteration: 0,
        lastGoodSha: getGitSha(projectRoot),
      };

      const PROTECTED_BRANCHES = new Set(['main', 'master']);
      let fixedCount = initialFixed;

      for (let i = 1; i <= maxIterations; i++) {
        // Per-iteration guard: abort if somehow back on a protected branch
        const iterBranch = execSync('git branch --show-current', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
        if (PROTECTED_BRANCHES.has(iterBranch)) {
          renderer.stop();
          console.error(chalk.red(`ABORT: detected protected branch "${iterBranch}" at iteration ${i} — refusing to continue.`));
          process.exitCode = 1;
          return;
        }

        // --- Extract next batch from master PRD ---
        let masterPrd: { userStories: PrdStory[] };
        try {
          masterPrd = JSON.parse(readFileSync(prdPath, 'utf-8'));
        } catch {
          renderer.stop();
          console.error(chalk.red('Failed to parse prd.json — aborting.'));
          process.exitCode = 1;
          return;
        }

        const originalStories = masterPrd.userStories.filter(
          (s) => s.actId !== DISCOVERED_ACT_ID,
        );
        const totalRemaining = originalStories.filter((s) => !s.passes).length;
        if (totalRemaining === 0) {
          state.completeTask('clean', `${totalStories}/${totalStories} findings fixed`);
          state.setSummary({
            headline: chalk.bold.green('Done') + ` \u2014 all ${totalStories} findings remediated in ${i - 1} iterations`,
            paths: [
              { key: 'branch', value: chalk.cyan(branchName) },
              { key: 'progress', value: chalk.cyan(`${cleanDir}/progress.txt`) },
            ],
            cost: '',
          });
          renderer.stop();
          syncToReport(projectRoot, reportFile);
          return;
        }

        const batches = groupStoriesByAxisFile(originalStories);
        const pendingBatches = batches.filter((b) => b.stories.some((s) => !s.passes));
        const nextBatch = pendingBatches[0];
        if (!nextBatch) {
          state.completeTask('clean', `${totalStories}/${totalStories} findings fixed`);
          renderer.stop();
          syncToReport(projectRoot, reportFile);
          return;
        }
        const pendingStories = nextBatch.stories.filter((s) => !s.passes);
        const firstId = pendingStories[0].id;
        const lastId = pendingStories[pendingStories.length - 1].id;
        const batchLabel = pendingStories.length === 1 ? firstId : `${firstId}..${lastId}`;

        // Update pipeline display
        state.updateTask('clean', `${fixedCount}/${totalStories} findings fixed`);
        state.inProgressLabel = `In progress \u2014 loop ${i}/${maxIterations}`;
        state.setPhase('review');

        // Show current batch as in-progress file + next 3 as pending
        state.activeFiles.clear();
        state.trackFile(`${batchLabel}  ${nextBatch.axis}/${nextBatch.file} (${pendingStories.length} stories)`, { axesTotal: 0 });
        for (const upcoming of pendingBatches.slice(1, 4)) {
          const upStories = upcoming.stories.filter((s) => !s.passes);
          const upLabel = upStories.length === 1 ? upStories[0].id : `${upStories[0].id}..${upStories[upStories.length - 1].id}`;
          state.trackFile(`${upLabel}  ${upcoming.axis}/${upcoming.file} (${upStories.length} stories)`, { axesTotal: 0 });
        }

        // Write batch file for the agent
        const batchPath = join(cleanDir, 'current-batch.json');
        writeFileSync(batchPath, JSON.stringify(pendingStories, null, 2));

        const preSha = getGitSha(projectRoot);

        // Read CLAUDE.md fresh each iteration
        let claudeMd: string;
        try {
          claudeMd = readFileSync(claudeMdPath, 'utf-8');
        } catch {
          renderer.stop();
          console.error(chalk.red(`Failed to read ${claudeMdPath} at iteration ${i} — aborting.`));
          process.exitCode = 1;
          return;
        }

        // Spawn a fresh Claude Code instance with retry on transient failures
        const MAX_SPAWN_RETRIES = 2;
        let exitCode = 1;
        for (let attempt = 0; attempt <= MAX_SPAWN_RETRIES; attempt++) {
          if (attempt > 0) {
            const delayMs = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }

          exitCode = await new Promise<number>((res) => {
            const args = ['--dangerously-skip-permissions', '--print'];
            if (opts.model) args.push('--model', opts.model);
            const child = spawn('claude', args, {
              cwd: projectRoot,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            activeChild = child;

            // Suppress agent output — pipeline display owns the terminal
            child.stdout!.resume();
            child.stderr!.resume();

            child.on('close', (code) => {
              activeChild = null;
              clearTimeout(timer);
              res(code ?? 1);
            });

            child.on('error', () => {
              activeChild = null;
              clearTimeout(timer);
              res(1);
            });

            child.stdin!.end(claudeMd);

            const timeoutMs = (15 + pendingStories.length * 5) * 60 * 1000;
            const timer = setTimeout(() => {
              child.kill();
            }, timeoutMs);
          });

          if (exitCode === 0) break;
          // Check if the batch made partial progress (wrote results) — don't retry
          try {
            const updatedBatch: PrdStory[] = JSON.parse(readFileSync(batchPath, 'utf-8'));
            if (updatedBatch.some((s) => s.passes)) break;
          } catch { /* batch not written yet — retry */ }
        }

        const hasError = exitCode !== 0;

        // Sync current-batch.json results back to master PRD
        try {
          const updatedBatch: PrdStory[] = JSON.parse(readFileSync(batchPath, 'utf-8'));
          let batchFixed = 0;
          for (const updatedStory of updatedBatch) {
            const idx = masterPrd.userStories.findIndex((s) => s.id === updatedStory.id);
            if (idx !== -1) {
              if (updatedStory.passes && !masterPrd.userStories[idx].passes) batchFixed++;
              masterPrd.userStories[idx] = updatedStory;
            }
          }
          writeFileSync(prdPath, JSON.stringify(masterPrd, null, 2));
          fixedCount += batchFixed;
        } catch {
          // Non-fatal
        }

        // Mark current batch as done in the display
        state.activeFiles.clear();

        // Sync completed fixes back to the report
        syncToReport(projectRoot, reportFile);

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

        if (hasError && !madeProgress) {
          cb.consecutiveSameError++;
        } else {
          cb.consecutiveSameError = 0;
        }

        if (cb.consecutiveNoProgress >= CB_NO_PROGRESS_THRESHOLD) {
          state.completeTask('clean', `${fixedCount}/${totalStories} findings fixed (stalled)`);
          renderer.stop();
          openCircuitBreaker(
            'No progress detected',
            `${cb.consecutiveNoProgress} consecutive iterations without changes`,
            cb, postSha, projectRoot, reportFile,
          );
          return;
        }

        if (cb.consecutiveSameError >= CB_SAME_ERROR_THRESHOLD) {
          state.completeTask('clean', `${fixedCount}/${totalStories} findings fixed (errors)`);
          renderer.stop();
          openCircuitBreaker(
            'Repeated errors detected',
            `${cb.consecutiveSameError} consecutive iterations with errors`,
            cb, postSha, projectRoot, reportFile,
          );
          return;
        }
      }

      state.completeTask('clean', `${fixedCount}/${totalStories} findings fixed (max iterations)`);
      renderer.stop();
      console.log(chalk.yellow(`Clean loop reached max iterations (${maxIterations}).`));
      syncToReport(projectRoot, reportFile);
      process.exitCode = 1;
    });
}
