// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { listRuns, readLatestPointer, updateLatestPointer } from '../utils/run-id.js';
import { isLockActive } from '../utils/lock.js';
import { confirm, isInteractive } from '../utils/confirm.js';

interface RunInfo {
  id: string;
  reviews: number;
  logs: number;
  hasMetrics: boolean;
  sizeKb: number;
}

function getRunInfo(runsDir: string, runId: string): RunInfo {
  const runDir = join(runsDir, runId);
  const reviewsDir = join(runDir, 'reviews');
  const logsDir = join(runDir, 'logs');
  const metricsFile = join(runDir, 'run-metrics.json');

  let reviews = 0;
  try { reviews = readdirSync(reviewsDir).length; } catch { /* empty */ }

  let logs = 0;
  try { logs = readdirSync(logsDir).length; } catch { /* empty */ }

  let hasMetrics = false;
  try { statSync(metricsFile); hasMetrics = true; } catch { /* empty */ }

  // Compute total directory size (shallow — skip deep recursion for speed)
  let sizeKb = 0;
  try {
    const entries = readdirSync(runDir, { withFileTypes: true });
    for (const entry of entries) {
      try {
        if (entry.isFile()) {
          sizeKb += statSync(join(runDir, entry.name)).size;
        } else if (entry.isDirectory()) {
          const sub = readdirSync(join(runDir, entry.name));
          for (const f of sub) {
            try { sizeKb += statSync(join(runDir, entry.name, f)).size; } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
    sizeKb = Math.round(sizeKb / 1024);
  } catch { /* empty */ }

  return { id: runId, reviews, logs, hasMetrics, sizeKb };
}

function isEmpty(info: RunInfo): boolean {
  return info.reviews === 0;
}

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function registerAuditCommand(program: Command): void {
  const auditCmd = program
    .command('audit')
    .description('Manage audit runs (list, remove)');

  // --- anatoly runs list ---
  auditCmd
    .command('list')
    .description('List all runs with status information')
    .option('--empty', 'show only empty (phantom) runs')
    .action(async (opts: { empty?: boolean }) => {
      const projectRoot = process.cwd();
      const runs = listRuns(projectRoot);

      if (runs.length === 0) {
        console.log('anatoly — audit list');
        console.log('  No runs found.');
        return;
      }

      const runsDir = resolve(projectRoot, '.anatoly', 'runs');
      let infos = runs.map((id) => getRunInfo(runsDir, id));

      if (opts.empty) {
        infos = infos.filter(isEmpty);
      }

      if (infos.length === 0) {
        console.log('anatoly — audit list');
        console.log('  No empty runs found.');
        return;
      }

      console.log('anatoly — audit list');
      console.log('');

      const table = new Table({
        chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '  ', 'left-mid': '', mid: '', 'mid-mid': '', right: '', 'right-mid': '', middle: ' ' },
        style: { 'padding-left': 0, 'padding-right': 0, head: ['dim'] },
        head: ['Run ID', 'Reviews', 'Logs', 'Size', 'Status'],
      });

      for (const info of infos) {
        const status = isEmpty(info)
          ? chalk.yellow('empty')
          : info.hasMetrics
            ? chalk.green('complete')
            : chalk.blue('partial');
        table.push([info.id, String(info.reviews), String(info.logs), formatSize(info.sizeKb), status]);
      }

      console.log(table.toString());

      const emptyCount = infos.filter(isEmpty).length;
      console.log('');
      console.log(`  ${infos.length} run(s)${emptyCount > 0 ? `, ${chalk.yellow(`${emptyCount} empty`)}` : ''}`);
    });

  // --- anatoly runs remove ---
  auditCmd
    .command('remove')
    .description('Remove runs (by ID or all empty/phantom runs)')
    .option('--empty', 'remove all empty (phantom) runs with 0 reviews')
    .option('-y, --yes', 'skip confirmation prompt')
    .argument('[runIds...]', 'specific run IDs to remove')
    .action(async (runIds: string[], opts: { empty?: boolean; yes?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before removing runs.'));
        process.exitCode = 1;
        return;
      }

      const runsDir = resolve(projectRoot, '.anatoly', 'runs');
      const allRuns = listRuns(projectRoot);

      let toDelete: string[];

      if (opts.empty) {
        const infos = allRuns.map((id) => getRunInfo(runsDir, id));
        toDelete = infos.filter(isEmpty).map((i) => i.id);
      } else if (runIds.length > 0) {
        // Validate provided IDs exist
        const invalid = runIds.filter((id) => !allRuns.includes(id));
        if (invalid.length > 0) {
          console.error(chalk.red(`Run(s) not found: ${invalid.join(', ')}`));
          process.exitCode = 1;
          return;
        }
        toDelete = runIds;
      } else {
        console.error('Specify run IDs to remove or use --empty to remove all phantom runs.');
        console.error('  Usage: anatoly audit remove <runId...>');
        console.error('  Usage: anatoly audit remove --empty');
        process.exitCode = 1;
        return;
      }

      if (toDelete.length === 0) {
        console.log('anatoly — audit remove');
        console.log('  No empty runs to remove.');
        return;
      }

      console.log('anatoly — audit remove');
      console.log('');
      for (const id of toDelete) {
        console.log(`  ${chalk.dim('•')} ${id}`);
      }
      console.log('');
      console.log(`  Will delete ${chalk.bold(String(toDelete.length))} run(s).`);
      console.log('');

      if (!opts.yes) {
        if (!isInteractive()) {
          console.log(`  ${chalk.red('error')}: runs remove requires confirmation in non-interactive mode`);
          console.log(`    → use ${chalk.bold('--yes')} to skip confirmation`);
          process.exitCode = 1;
          return;
        }
        const confirmed = await confirm('  Proceed?');
        if (!confirmed) {
          console.log('  Cancelled.');
          return;
        }
      }

      const currentLatest = readLatestPointer(runsDir);

      for (const id of toDelete) {
        rmSync(resolve(runsDir, id), { recursive: true, force: true });
      }

      // Repoint latest if it was deleted
      if (currentLatest && toDelete.includes(currentLatest)) {
        const remaining = listRuns(projectRoot);
        if (remaining.length > 0) {
          updateLatestPointer(runsDir, remaining[remaining.length - 1]);
          console.log(`  Updated ${chalk.bold('latest')} → ${remaining[remaining.length - 1]}`);
        } else {
          // No runs left — remove stale latest pointer
          try { rmSync(resolve(runsDir, 'latest'), { force: true }); } catch { /* ignore */ }
        }
      }

      console.log(`  Deleted ${chalk.bold(String(toDelete.length))} run(s).`);
    });
}
