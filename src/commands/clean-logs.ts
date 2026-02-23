import type { Command } from 'commander';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';

export function registerCleanLogsCommand(program: Command): void {
  program
    .command('clean-logs')
    .description('Delete all transcript files from .anatoly/logs/')
    .action(() => {
      const projectRoot = process.cwd();
      const logsDir = resolve(projectRoot, '.anatoly', 'logs');

      if (!existsSync(logsDir)) {
        console.log('anatoly — clean-logs');
        console.log('  No logs directory found.');
        return;
      }

      let deleted = 0;
      const entries = readdirSync(logsDir);
      for (const entry of entries) {
        if (entry.endsWith('.transcript.md')) {
          unlinkSync(join(logsDir, entry));
          deleted++;
        }
      }

      console.log('anatoly — clean-logs');
      console.log(`  deleted ${chalk.bold(String(deleted))} transcript(s)`);
    });
}
