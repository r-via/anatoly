// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from '../types.js';

export const refinementPipelineComposer: ComposerEntry = {
  name: 'refinement-pipeline',
  plan: {
    steps: [
      { id: 'deliberate', primitive: 'agents.tier3-deliberator' },
    ],
  },
  inputSchema: z.any(),
  outputSchema: z.any(),
};
