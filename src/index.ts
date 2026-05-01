// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { release } from 'node:os';
import 'dotenv/config';
import chalk from 'chalk';
import { createProgram } from './cli.js';

// Early WSL-with-Windows-Node guard: when anatoly is launched inside WSL
// but the resolved Node interpreter lives on a Windows mount
// (e.g. /mnt/c/nvm4w/nodejs/node.exe via binfmt_misc), the CLI runs but
// with cross-OS path semantics that confuse every downstream tool
// (LanceDB, transformers cache, child_process spawns). Fail fast with
// the remediation command rather than degrading later.
//
// This guard does NOT catch the variant where `exec node` itself fails
// at the npm shim layer (no binfmt) — that error never reaches our JS,
// the install doc covers it.
if (process.platform === 'linux' && /microsoft/i.test(release())) {
  if (process.execPath.startsWith('/mnt/') || /^[A-Za-z]:[\\/]/.test(process.execPath)) {
    process.stderr.write(
      [
        '',
        'anatoly: detected WSL with a Windows-installed Node.js.',
        `  current node: ${process.execPath}`,
        '',
        'anatoly needs Node.js installed *inside* the WSL distribution.',
        'Install via nvm and re-run:',
        '',
        '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
        '  exec $SHELL',
        '  nvm install 20.19',
        '  npm install -g @r-via/anatoly',
        '',
      ].join('\n') + '\n',
    );
    process.exit(1);
  }
}

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
