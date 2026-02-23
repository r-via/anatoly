import type { Command } from 'commander';

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Parse AST and compute SHA-256 hashes for all TypeScript files')
    .action(() => {
      console.log('scan: not yet implemented');
    });
}
