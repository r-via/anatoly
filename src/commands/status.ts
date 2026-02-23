import type { Command } from 'commander';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current audit progress and findings summary')
    .action(() => {
      console.log('status: not yet implemented');
    });
}
