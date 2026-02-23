import type { Command } from 'commander';

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear all cache, reviews, logs, tasks, and report')
    .action(() => {
      console.log('reset: not yet implemented');
    });
}
