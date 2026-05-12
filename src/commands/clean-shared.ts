// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { clearShared } from '../utils/anatoly-paths.js';

/**
 * Prompt the user for confirmation on stdin/stdout.
 * Returns `true` if the user typed `y` or `yes` (case-insensitive).
 */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Registers the `clean shared` CLI sub-command.
 *
 * Clears the user-wide shared cache (`~/.anatoly/shared/`) which contains
 * reviews, refinements, NLP summaries, pricing, grammars, and models.
 * Prompts for confirmation unless `--yes` is passed.
 */
export function registerCleanSharedCommand(program: Command): void {
  program
    .command('shared')
    .description('Clear the user-wide shared cache (~/.anatoly/shared/)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm(
          chalk.yellow(
            'This will clear ~/.anatoly/shared/ (pricing, grammars, models).\n' +
            'This affects ALL projects sharing this cache. Project-local caches\n' +
            '(reviews, refinements, NLP summaries under cache/) are NOT touched. Continue? [y/N] ',
          ),
        );
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      clearShared();
      console.log(chalk.green('✓ Shared cache cleared.'));
    });
}
