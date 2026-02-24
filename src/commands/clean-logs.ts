import type { Command } from 'commander';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { listRuns } from '../utils/run-id.js';

export function registerCleanLogsCommand(program: Command): void {
  // Keep legacy command name for backwards compatibility
  program
    .command('clean-logs')
    .description('Delete all runs from .anatoly/runs/')
    .option('--keep <n>', 'keep the N most recent runs', parseInt)
    .action((opts: { keep?: number }) => {
      cleanRuns(opts.keep);
    });

  // New alias
  program
    .command('clean-runs')
    .description('Delete all runs from .anatoly/runs/')
    .option('--keep <n>', 'keep the N most recent runs', parseInt)
    .action((opts: { keep?: number }) => {
      cleanRuns(opts.keep);
    });
}

function cleanRuns(keep?: number): void {
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

  for (const runId of toDelete) {
    rmSync(resolve(runsDir, runId), { recursive: true, force: true });
  }

  const remaining = runs.length - toDelete.length;
  console.log('anatoly — clean-runs');
  console.log(`  deleted ${chalk.bold(String(toDelete.length))} run(s)${remaining > 0 ? `, kept ${remaining}` : ''}`);
}
