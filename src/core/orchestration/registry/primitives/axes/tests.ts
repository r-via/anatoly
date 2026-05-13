// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      tests: z.enum(['GOOD', 'WEAK', 'NONE']),
    }),
  ),
  doc_divergences: z
    .array(z.object({ description: z.string() }))
    .optional(),
});

export const axesTests = createAxisPrimitive({
  name: 'axes.tests',
  axisId: 'tests',
  defaultModel: 'sonnet',
  outputSchema,
});
