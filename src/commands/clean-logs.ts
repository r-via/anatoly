import type { Command } from 'commander';

export function registerCleanLogsCommand(program: Command): void {
  program
    .command('clean-logs')
    .description('Delete all transcript files from .anatoly/logs/')
    .action(() => {
      console.log('clean-logs: not yet implemented');
    });
}
