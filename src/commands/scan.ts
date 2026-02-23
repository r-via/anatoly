import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Parse AST and compute SHA-256 hashes for all TypeScript files')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const result = await scanProject(projectRoot, config);

      console.log('anatoly — scan');
      console.log(`  files     ${result.filesScanned}`);
      console.log(`  new       ${result.filesNew}`);
      console.log(`  cached    ${result.filesCached}`);
    });
}
