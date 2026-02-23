import type { Command } from 'commander';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear all cache, reviews, logs, tasks, and report')
    .action(() => {
      const projectRoot = process.cwd();
      const anatolyDir = resolve(projectRoot, '.anatoly');

      if (!existsSync(anatolyDir)) {
        console.log('anatoly — reset');
        console.log('  No .anatoly/ directory found.');
        return;
      }

      const dirs = ['tasks', 'reviews', 'logs', 'cache'];
      let cleaned = 0;

      for (const dir of dirs) {
        const dirPath = resolve(anatolyDir, dir);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Remove progress.json
      const progressPath = resolve(anatolyDir, 'progress.json');
      if (existsSync(progressPath)) {
        rmSync(progressPath);
        cleaned++;
      }

      // Remove report.md
      const reportPath = resolve(anatolyDir, 'report.md');
      if (existsSync(reportPath)) {
        rmSync(reportPath);
        cleaned++;
      }

      // Remove lock file
      const lockPath = resolve(anatolyDir, 'anatoly.lock');
      if (existsSync(lockPath)) {
        rmSync(lockPath);
        cleaned++;
      }

      console.log('anatoly — reset');
      console.log(`  cleared ${chalk.bold(String(cleaned))} item(s) from .anatoly/`);
    });
}
