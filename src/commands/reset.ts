import type { Command } from 'commander';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { confirm, isInteractive } from '../utils/confirm.js';
import { VectorStore } from '../rag/vector-store.js';

/**
 * Count items that will be deleted during reset, for the confirmation summary.
 */
function countResetItems(anatolyDir: string): { dirs: string[]; files: string[]; total: number } {
  const dirs: string[] = [];
  const files: string[] = [];

  for (const dir of ['tasks', 'reviews', 'logs', 'cache']) {
    const dirPath = resolve(anatolyDir, dir);
    if (existsSync(dirPath)) {
      dirs.push(dir);
    }
  }

  // Check runs directory
  const runsDir = resolve(anatolyDir, 'runs');
  if (existsSync(runsDir)) {
    try {
      const runEntries = readdirSync(runsDir).filter((e) => e !== 'latest');
      if (runEntries.length > 0) {
        dirs.push(`runs (${runEntries.length} run(s))`);
      }
    } catch {
      // ignore read errors
    }
  }

  // Check RAG directory
  const ragDir = resolve(anatolyDir, 'rag');
  if (existsSync(ragDir)) {
    dirs.push('rag');
  }

  for (const file of ['progress.json', 'report.md', 'anatoly.lock']) {
    if (existsSync(resolve(anatolyDir, file))) {
      files.push(file);
    }
  }

  return { dirs, files, total: dirs.length + files.length };
}

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear all cache, reviews, logs, tasks, report, and RAG index')
    .option('-y, --yes', 'skip confirmation prompt (for CI/scripts)')
    .action(async (opts: { yes?: boolean }) => {
      const projectRoot = process.cwd();
      const anatolyDir = resolve(projectRoot, '.anatoly');

      if (!existsSync(anatolyDir)) {
        console.log('anatoly — reset');
        console.log('  No .anatoly/ directory found.');
        return;
      }

      const { dirs, files, total } = countResetItems(anatolyDir);

      if (total === 0) {
        console.log('anatoly — reset');
        console.log('  Nothing to clean.');
        return;
      }

      // Show summary of what will be deleted
      console.log('anatoly — reset');
      console.log('');
      console.log('  The following will be deleted:');
      for (const d of dirs) {
        console.log(`    ${chalk.red('×')} .anatoly/${d}/`);
      }
      for (const f of files) {
        console.log(`    ${chalk.red('×')} .anatoly/${f}`);
      }
      console.log('');

      // Confirmation gate
      if (!opts.yes) {
        if (!isInteractive()) {
          console.log(`  ${chalk.red('error')}: reset requires confirmation in non-interactive mode`);
          console.log(`    → use ${chalk.bold('--yes')} to skip confirmation`);
          process.exitCode = 1;
          return;
        }

        const confirmed = await confirm('  Proceed with reset?');
        if (!confirmed) {
          console.log('  reset cancelled.');
          return;
        }
      }

      let cleaned = 0;

      for (const dir of ['tasks', 'reviews', 'logs', 'cache', 'runs']) {
        const dirPath = resolve(anatolyDir, dir);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Clean RAG: drop LanceDB table via API, then remove directory
      const ragDir = resolve(anatolyDir, 'rag');
      if (existsSync(ragDir)) {
        try {
          const store = new VectorStore(projectRoot);
          await store.init();
          await store.rebuild();
        } catch {
          // LanceDB cleanup failed — fall through to rmSync
        }
        rmSync(ragDir, { recursive: true, force: true });
        cleaned++;
      }

      // Remove progress.json
      const progressPath = resolve(anatolyDir, 'progress.json');
      if (existsSync(progressPath)) {
        rmSync(progressPath);
        cleaned++;
      }

      // Remove report.md
      const reportPath = resolve(anatolyDir, 'report.md');
      if (existsSync(reportPath)) {
        rmSync(reportPath);
        cleaned++;
      }

      // Remove lock file
      const lockPath = resolve(anatolyDir, 'anatoly.lock');
      if (existsSync(lockPath)) {
        rmSync(lockPath);
        cleaned++;
      }

      console.log(`  cleared ${chalk.bold(String(cleaned))} item(s) from .anatoly/`);
    });
}
