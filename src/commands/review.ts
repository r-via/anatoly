import type { Command } from 'commander';

export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Run agentic review on all pending files sequentially')
    .action(() => {
      console.log('review: not yet implemented');
    });
}
