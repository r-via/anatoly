import type { Command } from 'commander';

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Aggregate review results into a structured Markdown report')
    .action(() => {
      console.log('report: not yet implemented');
    });
}
