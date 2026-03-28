// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared base schema for per-symbol LLM responses across all axes.
// Each axis extends this with its own verdict enum via .extend().
// ---------------------------------------------------------------------------

export const BaseSymbolSchema = z
  .object({
    name: z.string(),
    line_start: z.int().min(1),
    line_end: z.int().min(1),
    confidence: z.int().min(0).max(100),
    detail: z.string().min(10),
  })
  .refine((d) => d.line_end >= d.line_start, {
    message: 'line_end must be >= line_start',
  });
