import type { Command } from 'commander';

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Estimate token count and review time via tiktoken (no LLM calls)')
    .action(() => {
      console.log('estimate: not yet implemented');
    });
}
