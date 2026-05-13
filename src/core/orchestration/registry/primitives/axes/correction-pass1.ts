// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
      findings: z
        .array(z.object({ description: z.string(), severity: z.string() }))
        .optional(),
    }),
  ),
  actions: z.array(z.object({ description: z.string() })),
  doc_divergences: z
    .array(z.object({ description: z.string() }))
    .optional(),
});

export const axesCorrectionPass1 = createAxisPrimitive({
  name: 'axes.correction-pass1',
  axisId: 'correction',
  defaultModel: 'sonnet',
  outputSchema,
});
