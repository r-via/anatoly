import type { Command } from 'commander';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute full audit pipeline: scan → estimate → review → report')
    .action(() => {
      console.log('run: not yet implemented');
    });
}
