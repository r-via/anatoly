// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      duplication: z.enum(['UNIQUE', 'DUPLICATE']),
      duplicate_target: z.string().optional(),
    }),
  ),
});

export const axesDuplication = createAxisPrimitive({
  name: 'axes.duplication',
  axisId: 'duplication',
  defaultModel: 'haiku',
  outputSchema,
});
