// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { confirm, isInteractive } from '../utils/confirm.js';
import { VectorStore } from '../rag/vector-store.js';

/**
 * Count items that will be deleted during reset, for the confirmation summary.
 */
function countResetItems(anatolyDir: string, keepRag: boolean, keepDocs: boolean): { dirs: string[]; files: string[]; total: number } {
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
  if (!keepRag) {
    const ragDir = resolve(anatolyDir, 'rag');
    if (existsSync(ragDir)) {
      dirs.push('rag');
    }
  }

  // Check internal docs directory
  if (!keepDocs) {
    const docsDir = resolve(anatolyDir, 'docs');
    if (existsSync(docsDir)) {
      dirs.push('docs (internal documentation)');
    }
  }

  for (const file of ['progress.json', 'report.md', 'anatoly.lock', 'deliberation-memory.json', 'correction-memory.json']) {
    if (existsSync(resolve(anatolyDir, file))) {
      files.push(file);
    }
  }

  return { dirs, files, total: dirs.length + files.length };
}

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear all cache, reviews, logs, tasks, report, RAG index, and internal docs')
    .option('-y, --yes', 'skip confirmation prompt (for CI/scripts)')
    .option('--keep-rag', 'keep the RAG index (embeddings are slow to rebuild)')
    .option('--keep-docs', 'keep internal documentation (.anatoly/docs/)')
    .action(async (opts: { yes?: boolean; keepRag?: boolean; keepDocs?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before running this command.'));
        process.exitCode = 1;
        return;
      }

      const anatolyDir = resolve(projectRoot, '.anatoly');

      if (!existsSync(anatolyDir)) {
        console.log('anatoly — reset');
        console.log('  No .anatoly/ directory found.');
        return;
      }

      const keepRag = opts.keepRag === true;
      const keepDocs = opts.keepDocs === true;
      const { dirs, files, total } = countResetItems(anatolyDir, keepRag, keepDocs);

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

      // Clean RAG: drop LanceDB tables via API, then remove directory
      if (!keepRag) {
        const ragDir = resolve(anatolyDir, 'rag');
        if (existsSync(ragDir)) {
          for (const tableName of ['function_cards_lite', 'function_cards_advanced', 'function_cards']) {
            try {
              const store = new VectorStore(projectRoot, tableName);
              await store.init();
              await store.rebuild();
            } catch {
              // LanceDB cleanup failed — fall through to rmSync
            }
          }
          rmSync(ragDir, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Clean internal docs
      if (!keepDocs) {
        const docsDir = resolve(anatolyDir, 'docs');
        if (existsSync(docsDir)) {
          rmSync(docsDir, { recursive: true, force: true });
          cleaned++;
        }
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

      // Remove deliberation memory (and legacy correction memory)
      for (const memFile of ['deliberation-memory.json', 'correction-memory.json']) {
        const memPath = resolve(anatolyDir, memFile);
        if (existsSync(memPath)) {
          rmSync(memPath);
          cleaned++;
        }
      }

      console.log(`  cleared ${chalk.bold(String(cleaned))} item(s) from .anatoly/`);
    });
}
