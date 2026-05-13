// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      original_correction: z.string(),
      verified_correction: z.string(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
});

export const axesCorrectionVerify = createAxisPrimitive({
  name: 'axes.correction-verify',
  axisId: 'correction',
  defaultModel: 'sonnet',
  outputSchema,
  avgOutputTokens: 300,
});
