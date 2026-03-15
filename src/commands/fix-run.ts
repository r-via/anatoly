import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { parseUncheckedActions } from './fix.js';

export function registerFixRunCommand(program: Command): void {
  program
    .command('fix-run <report-file>')
    .description('Generate fix artifacts and launch Ralph loop to remediate findings')
    .option('-n, --iterations <n>', 'max Ralph iterations', '10')
    .action((reportFile: string, opts: { iterations: string }) => {
      const projectRoot = process.cwd();
      const absPath = resolve(projectRoot, reportFile);

      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${reportFile}`));
        process.exit(1);
      }

      // Derive shard name and fix directory
      const shardName = basename(reportFile, '.md');
      const fixDir = resolve(projectRoot, '.anatoly', 'fix', shardName);
      const ralphPath = join(fixDir, 'ralph.sh');

      // Generate artifacts if not already present
      if (!existsSync(ralphPath)) {
        console.log(chalk.blue('Generating fix artifacts...'));
        execSync(`npx anatoly fix ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      }

      // Verify ralph.sh was created
      if (!existsSync(ralphPath)) {
        const content = readFileSync(absPath, 'utf-8');
        const items = parseUncheckedActions(content);
        if (items.length === 0) {
          console.log(chalk.yellow('No unchecked actions found — nothing to fix.'));
          return;
        }
        console.error(chalk.red('Fix artifacts not found after generation.'));
        process.exit(1);
      }

      console.log('');
      console.log(chalk.blue('Launching Ralph fix loop...'));
      console.log('');

      // Launch the generated ralph.sh with stdio inherited
      const result = spawnSync(ralphPath, [opts.iterations], {
        cwd: projectRoot,
        stdio: 'inherit',
      });

      // fix-sync is already called inside ralph.sh after each iteration,
      // but run a final sync to be safe
      console.log('');
      console.log(chalk.blue('Final sync of fix results...'));
      try {
        execSync(`npx anatoly fix-sync ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      } catch {
        console.warn(chalk.yellow('fix-sync encountered an error (non-fatal)'));
      }

      if (result.status !== 0 && result.status !== null) {
        console.error(chalk.red(`Ralph exited with code ${result.status}`));
        process.exit(result.status);
      }

      console.log(chalk.green('Fix run complete.'));
    });
}
