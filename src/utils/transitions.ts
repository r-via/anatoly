// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';
import { printBanner } from './banner.js';

/**
 * Visual transition between setup and audit phases (Story 49.3).
 *
 * Note: lives outside `banner.ts` because that file is regenerated wholesale
 * by `scripts/sync-motd.js` on every prebuild and would clobber any addition.
 *
 * - Normal mode: box-drawing separator + ASCII banner + "Starting audit..." + blank line.
 * - Plain mode: simple `--- starting audit ---` text line.
 */
export function printSetupToAuditTransition(opts: { plain: boolean }): void {
  if (opts.plain) {
    console.log('--- starting audit ---');
    return;
  }

  console.log(chalk.dim('─'.repeat(61)));
  printBanner('The weight is good !  Starting audit...');
}
