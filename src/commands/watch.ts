import type { Command } from 'commander';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch for file changes and incrementally re-scan and re-review')
    .action(() => {
      console.log('watch: not yet implemented');
    });
}
