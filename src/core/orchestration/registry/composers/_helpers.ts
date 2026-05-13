// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from './types.js';

/**
 * Factory for single-step axis composers that wrap one primitive call.
 */
export function createSingleAxisComposer(primitiveName: string): ComposerEntry {
  return {
    name: primitiveName.replace(/^axes\./, 'axes.'),
    plan: {
      steps: [{ id: 'eval', primitive: primitiveName }],
    },
    inputSchema: z.any(),
    outputSchema: z.any(),
  };
}
