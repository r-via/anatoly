// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      utility: z.enum(['USED', 'DEAD', 'LOW_VALUE']),
    }),
  ),
});

export const axesUtility = createAxisPrimitive({
  name: 'axes.utility',
  axisId: 'utility',
  defaultModel: 'haiku',
  outputSchema,
});
