import type { Command } from 'commander';
import { existsSync, symlinkSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { parseUncheckedActions } from './fix.js';

export function registerFixRunCommand(program: Command): void {
  program
    .command('fix-run <report-file>')
    .description('Generate fix artifacts and launch Ralph to remediate findings')
    .action((reportFile: string) => {
      const projectRoot = process.cwd();
      const absPath = resolve(projectRoot, reportFile);

      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${reportFile}`));
        process.exit(1);
      }

      // Check Ralph installation
      const ralphScript = resolve(projectRoot, 'scripts', 'ralph', 'ralph.sh');
      if (!existsSync(ralphScript)) {
        console.error(chalk.red('Ralph not found at scripts/ralph/ralph.sh'));
        console.error(chalk.red('See https://github.com/snarktank/ralph for installation'));
        process.exit(1);
      }

      // Derive shard name and fix directory
      const shardName = basename(reportFile, '.md');
      const fixDir = resolve(projectRoot, '.anatoly', 'fix', shardName);
      const prdPath = join(fixDir, 'prd.json');
      const claudeMdPath = join(fixDir, 'CLAUDE.md');

      // Generate artifacts if not already present
      if (!existsSync(prdPath) || !existsSync(claudeMdPath)) {
        console.log(chalk.blue('Generating fix artifacts...'));
        execSync(`npx anatoly fix ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      }

      // Verify artifacts were created
      if (!existsSync(prdPath)) {
        const content = readFileSync(absPath, 'utf-8');
        const items = parseUncheckedActions(content);
        if (items.length === 0) {
          console.log(chalk.yellow('No unchecked actions found — nothing to fix.'));
          return;
        }
        console.error(chalk.red('Fix artifacts not found after generation.'));
        process.exit(1);
      }

      // Symlink prd.json and CLAUDE.md to project root (where Ralph expects them)
      const rootPrd = resolve(projectRoot, 'prd.json');
      const rootClaudeMd = resolve(projectRoot, 'CLAUDE.md');

      // Create symlinks (remove existing ones first if they are symlinks)
      for (const [src, dest] of [[prdPath, rootPrd], [claudeMdPath, rootClaudeMd]] as const) {
        try {
          unlinkSync(dest);
        } catch {
          // File may not exist — that's fine
        }
        symlinkSync(src, dest);
        console.log(chalk.gray(`  Linked ${basename(dest)} → .anatoly/fix/${shardName}/${basename(dest)}`));
      }

      console.log('');
      console.log(chalk.blue('Launching Ralph...'));
      console.log('');

      // Launch Ralph with stdio inherited so the user sees everything
      const result = spawnSync(ralphScript, ['--tool', 'claude'], {
        cwd: projectRoot,
        stdio: 'inherit',
      });

      console.log('');

      // After Ralph finishes, sync checkboxes back
      console.log(chalk.blue('Syncing fix results back to report...'));
      try {
        execSync(`npx anatoly fix-sync ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      } catch {
        console.warn(chalk.yellow('fix-sync encountered an error (non-fatal)'));
      }

      // Clean up symlinks
      for (const dest of [rootPrd, rootClaudeMd]) {
        try {
          unlinkSync(dest);
        } catch {
          // Ignore cleanup errors
        }
      }

      if (result.status !== 0) {
        console.error(chalk.red(`Ralph exited with code ${result.status}`));
        process.exit(result.status ?? 1);
      }

      console.log(chalk.green('Fix run complete.'));
    });
}
