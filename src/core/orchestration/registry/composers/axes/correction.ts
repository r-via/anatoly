// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from '../types.js';

export const axesCorrectionComposer: ComposerEntry = {
  name: 'axes.correction',
  plan: {
    steps: [
      { id: 'pass1', primitive: 'axes.correction-pass1' },
      {
        id: 'verify',
        primitive: 'axes.correction-verify',
        readsFrom: ['pass1'],
        condition: (ex) => {
          const pass1 = ex.read('pass1', z.any()) as {
            symbols: Array<{ findings?: Array<unknown> }>;
          };
          const totalFindings = pass1.symbols.flatMap(
            (s) => s.findings ?? [],
          ).length;
          return totalFindings > 3;
        },
        onFailure: 'continue',
      },
    ],
  },
  inputSchema: z.any(),
  outputSchema: z.any(),
};
