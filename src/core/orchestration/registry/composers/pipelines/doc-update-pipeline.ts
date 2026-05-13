// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from '../types.js';

export const docUpdatePipelineComposer: ComposerEntry = {
  name: 'doc-update-pipeline',
  plan: {
    steps: [
      { id: 'chunk', primitive: 'rag.doc-chunk' },
      {
        id: 'generate',
        primitive: 'agents.doc-generator',
        readsFrom: ['chunk'],
      },
    ],
  },
  inputSchema: z.any(),
  outputSchema: z.any(),
};
