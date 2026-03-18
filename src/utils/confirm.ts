// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createInterface } from 'node:readline';

/**
 * Prompt the user for a y/n confirmation.
 * Returns true if the user confirms, false otherwise.
 * Rejects non-TTY environments — caller should check isTTY first.
 */
export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Check whether the current environment is interactive (TTY).
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}
