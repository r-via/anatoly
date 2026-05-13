// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../../../../schemas/config.js';
import { resolveCodeSummaryModel } from '../../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from '../types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from '../types.js';

const outputSchema = z.object({
  summaries: z.record(
    z.string(),
    z.object({
      summary: z.string(),
      docSummary: z.string(),
      keyConcepts: z.array(z.string()),
    }),
  ),
});

export const ragNlpSummary: PrimitiveEntry = {
  name: 'rag.nlp-summary',
  type: 'single-turn',
  modelResolver: (cfg: Config) => resolveCodeSummaryModel(cfg),
  prompt: { kind: 'builder' },
  estimateCost: (input: CostEstimateInput): CostEstimate => {
    const items = input.itemCount ?? 10;
    const inputTokens = items * 600;
    const outputTokens = items * 200;
    return {
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * 0.25 + outputTokens * 1.25) / 1_000_000,
    };
  },
  response: {
    schema: outputSchema,
    outputSchema,
  },
  dump: {
    enabled: true,
    format: 'markdown',
    location: DUMP_LOCATION_TEMPLATE,
  },
  log: {},
  cost: {
    pricingModel: 'api-token-based',
    capture: 'actual',
  },
  cache: {
    strategy: 'content-hash',
  },
};
