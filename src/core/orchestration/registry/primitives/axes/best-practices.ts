// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  score: z.number().min(0).max(10),
  rules: z.array(z.object({ rule: z.string(), status: z.string() })),
  suggestions: z.array(z.string()),
  doc_divergences: z
    .array(z.object({ description: z.string() }))
    .optional(),
});

export const axesBestPractices = createAxisPrimitive({
  name: 'axes.best-practices',
  axisId: 'best_practices',
  defaultModel: 'sonnet',
  outputSchema,
});
