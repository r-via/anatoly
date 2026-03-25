// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.
import chalk from 'chalk';

// --- BEGIN GENERATED (scripts/sync-motd.js) ---
export const MOTD_LINES = [
  '    ___                __        __     ',
  '   /   |  ____  ____ _/ /_____  / /_  __',
  '  / /| | / __ \\/ __ \`/ __/ __ \\/ / / / /',
  ' / ___ |/ / / / /_/ / /_/ /_/ / / /_/ / ',
  '/_/  |_/_/ /_/\\__,_/\\__/\\____/_/\\__, /  [v0.8.2]',
  '                               /____/   "Can i Clean Here ?"',
  '=============================================================',
];

const COLORS = [
  chalk.cyan,
  chalk.cyanBright,
  chalk.blueBright,
  chalk.blue,
  chalk.magenta,
  chalk.magentaBright,
  chalk.dim,
];
// --- END GENERATED ---

export function printBanner(altMotd?: string): void {
  for (let i = 0; i < MOTD_LINES.length; i++) {
    let line = MOTD_LINES[i];
    if (altMotd && line.includes('"')) {
      line = line.replace(/"[^"]*"/, `"${altMotd}"`);
    }
    console.log(COLORS[i](line));
  }
  console.log();
}
