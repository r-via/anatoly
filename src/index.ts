// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';
import { createProgram } from './cli.js';

// Respect $NO_COLOR standard (https://no-color.org)
if ('NO_COLOR' in process.env) {
  chalk.level = 0;
}

const program = createProgram();
program.parse();
