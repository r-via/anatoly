import type { Command } from 'commander';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { listRuns } from '../utils/run-id.js';
import { confirm, isInteractive } from '../utils/confirm.js';

export function registerCleanRunsCommand(program: Command): void {
  program
    .command('clean-runs')
    .description('Delete all runs from .anatoly/runs/')
    .option('--keep <n>', 'keep the N most recent runs', parseInt)
    .option('-y, --yes', 'skip confirmation prompt (for CI/scripts)')
    .action(async (opts: { keep?: number; yes?: boolean }) => {
      await cleanRuns(opts.keep, opts.yes);
    });

}

async function cleanRuns(keep?: number, yes?: boolean): Promise<void> {
  const projectRoot = process.cwd();
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');

  const runs = listRuns(projectRoot);

  if (runs.length === 0) {
    // Fallback: check legacy flat logs directory
    const legacyLogsDir = resolve(projectRoot, '.anatoly', 'logs');
    if (existsSync(legacyLogsDir)) {
      rmSync(legacyLogsDir, { recursive: true, force: true });
      console.log('anatoly — clean-runs');
      console.log(`  deleted legacy logs directory`);
      return;
    }
    console.log('anatoly — clean-runs');
    console.log('  No runs found.');
    return;
  }

  const toKeep = keep ?? 0;
  const toDelete = toKeep > 0 ? runs.slice(0, Math.max(0, runs.length - toKeep)) : runs;

  if (toDelete.length === 0) {
    console.log('anatoly — clean-runs');
    console.log(`  Nothing to delete (${runs.length} run(s), keeping ${toKeep}).`);
    return;
  }

  // Confirmation when deleting all runs (--keep 0 or no --keep)
  if (toKeep === 0) {
    console.log('anatoly — clean-runs');
    console.log('');
    console.log(`  Will delete ${chalk.bold(String(toDelete.length))} run(s) from .anatoly/runs/`);
    console.log('');

    if (!yes) {
      if (!isInteractive()) {
        console.log(`  ${chalk.red('error')}: clean-runs requires confirmation in non-interactive mode`);
        console.log(`    → use ${chalk.bold('--yes')} to skip confirmation`);
        process.exitCode = 1;
        return;
      }

      const confirmed = await confirm('  Proceed?');
      if (!confirmed) {
        console.log('  clean-runs cancelled.');
        return;
      }
    }
  }

  for (const runId of toDelete) {
    rmSync(resolve(runsDir, runId), { recursive: true, force: true });
  }

  const remaining = runs.length - toDelete.length;
  if (toKeep > 0) {
    console.log('anatoly — clean-runs');
  }
  console.log(`  deleted ${chalk.bold(String(toDelete.length))} run(s)${remaining > 0 ? `, kept ${remaining}` : ''}`);
}
