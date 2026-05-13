// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { createAxisPrimitive } from '../_axis-helpers.js';

const outputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED']),
    }),
  ),
  docs_coverage: z.number().optional(),
});

export const axesDocumentation = createAxisPrimitive({
  name: 'axes.documentation',
  axisId: 'documentation',
  defaultModel: 'sonnet',
  outputSchema,
});
