import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { parseUncheckedActions } from './clean.js';

const COMPLETION_SIGNAL = '<promise>COMPLETE</promise>';

/** Circuit breaker state for the TypeScript clean-run loop. */
interface CircuitBreakerState {
  consecutiveNoProgress: number;
  consecutiveSameError: number;
  lastProgressIteration: number;
  startSha: string;
  lastGoodSha: string;
}

const CB_NO_PROGRESS_THRESHOLD = 3;
const CB_SAME_ERROR_THRESHOLD = 5;

function getGitSha(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

function hasGitChanges(cwd: string, sinceSha: string): boolean {
  try {
    const diff = execSync(`git diff --name-only ${sinceSha} HEAD`, { cwd, stdio: 'pipe' }).toString().trim();
    return diff.length > 0;
  } catch {
    return false;
  }
}

function rollbackToSha(cwd: string, sha: string): boolean {
  try {
    execSync(`git reset --hard ${sha}`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function finalSync(projectRoot: string, reportFile: string): void {
  try {
    console.log(chalk.blue('Final sync...'));
    execSync(`npx anatoly clean-sync ${reportFile}`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  } catch {
    // Non-fatal
  }
}

export function registerCleanRunCommand(program: Command): void {
  program
    .command('clean-run <report-file>')
    .description('Generate clean artifacts and run Ralph loop to remediate findings')
    .option('-n, --iterations <n>', 'max Ralph iterations', '10')
    .action((reportFile: string, opts: { iterations: string }) => {
      const projectRoot = process.cwd();
      const absPath = resolve(projectRoot, reportFile);
      const maxIterations = parseInt(opts.iterations, 10) || 10;

      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${reportFile}`));
        process.exit(1);
      }

      // Derive shard name and fix directory
      const shardName = basename(reportFile, '.md');
      const cleanDir = resolve(projectRoot, '.anatoly', 'clean', shardName);
      const prdPath = join(cleanDir, 'prd.json');
      const claudeMdPath = join(cleanDir, 'CLAUDE.md');
      // Generate artifacts if not already present
      if (!existsSync(prdPath) || !existsSync(claudeMdPath)) {
        console.log(chalk.blue('Generating clean artifacts...'));
        execSync(`npx anatoly clean ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      }

      // Verify artifacts were created
      if (!existsSync(prdPath)) {
        const content = readFileSync(absPath, 'utf-8');
        const items = parseUncheckedActions(content);
        if (items.length === 0) {
          console.log(chalk.yellow('No unchecked actions found — nothing to clean.'));
          return;
        }
        console.error(chalk.red('Clean artifacts not found after generation.'));
        process.exit(1);
      }

      console.log('');
      console.log(chalk.blue(`Ralph clean loop \u2014 ${maxIterations} iterations max`));
      console.log('');

      // Circuit breaker state
      const cb: CircuitBreakerState = {
        consecutiveNoProgress: 0,
        consecutiveSameError: 0,
        lastProgressIteration: 0,
        startSha: getGitSha(projectRoot),
        lastGoodSha: getGitSha(projectRoot),
      };

      for (let i = 1; i <= maxIterations; i++) {
        console.log('===============================================================');
        console.log(`  Ralph Iteration ${i} of ${maxIterations}`);
        console.log('===============================================================');

        const preSha = getGitSha(projectRoot);

        // Read CLAUDE.md fresh each iteration (it doesn't change, but keep it clean)
        const claudeMd = readFileSync(claudeMdPath, 'utf-8');

        // Spawn a fresh Claude Code instance — full tools, full context, no SDK constraints
        const result = spawnSync('claude', ['--dangerously-skip-permissions', '--print'], {
          input: claudeMd,
          cwd: projectRoot,
          stdio: ['pipe', 'pipe', 'inherit'],
          timeout: 15 * 60 * 1000, // 15 min per iteration
        });

        const output = result.stdout?.toString() ?? '';
        const hasError = result.status !== 0;

        // Print agent output
        if (output) {
          process.stdout.write(output);
          process.stdout.write('\n');
        }

        // Sync completed fixes back to the report
        try {
          execSync(`npx anatoly clean-sync ${reportFile}`, {
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

        // Check if all stories pass in prd.json
        try {
          const currentPrd = JSON.parse(readFileSync(prdPath, 'utf-8'));
          const allDone = currentPrd.userStories?.every((s: { passes: boolean }) => s.passes);
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
          cb.consecutiveSameError = 0;
          cb.lastProgressIteration = i;
          cb.lastGoodSha = postSha;
        } else {
          cb.consecutiveNoProgress++;
        }

        if (hasError) {
          cb.consecutiveSameError++;
        } else {
          cb.consecutiveSameError = 0;
        }

        // Check circuit breaker thresholds
        if (cb.consecutiveNoProgress >= CB_NO_PROGRESS_THRESHOLD) {
          console.log('');
          console.log(chalk.red('==============================================================='));
          console.log(chalk.red('  CIRCUIT BREAKER OPEN — No progress detected'));
          console.log(chalk.red(`  ${cb.consecutiveNoProgress} consecutive iterations without changes`));
          console.log(chalk.red('==============================================================='));

          // Rollback to last known good state
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
          return;
        }

        if (cb.consecutiveSameError >= CB_SAME_ERROR_THRESHOLD) {
          console.log('');
          console.log(chalk.red('==============================================================='));
          console.log(chalk.red('  CIRCUIT BREAKER OPEN — Repeated errors detected'));
          console.log(chalk.red(`  ${cb.consecutiveSameError} consecutive iterations with errors`));
          console.log(chalk.red('==============================================================='));

          // Rollback to last known good state
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
      console.log(chalk.yellow(`Check .anatoly/clean/${shardName}/progress.txt for status.`));
      finalSync(projectRoot, reportFile);
      process.exitCode = 1;
    });
}
