// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from '../types.js';

export const docConflictPipelineComposer: ComposerEntry = {
  name: 'doc-conflict-pipeline',
  plan: {
    steps: [
      { id: 'detect', primitive: 'agents.doc-conflict-detector' },
      {
        id: 'aggregate',
        readsFrom: ['detect'],
        inputMapper: (exchange) => {
          const detection = exchange.read('detect', z.any()) as {
            newConflicts: number;
            applied: number;
            stale: number;
            pending: number;
          };
          return {
            totalConflicts: detection.newConflicts + detection.stale,
            resolved: detection.applied,
            pending: detection.pending,
          };
        },
      },
    ],
  },
  inputSchema: z.any(),
  outputSchema: z.any(),
};
