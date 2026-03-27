// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import 'dotenv/config';
import chalk from 'chalk';
import { createProgram } from './cli.js';

// Respect $NO_COLOR standard (https://no-color.org)
if ('NO_COLOR' in process.env) {
  chalk.level = 0;
}

const program = createProgram();
// Keep process alive until parseAsync resolves (needed for async commands in plain mode)
const keepAlive = setInterval(() => {}, 60_000);
program.parseAsync()
  .catch((err: unknown) => {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
