// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../../../../schemas/config.js';
import { resolveDeliberationModel } from '../../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from '../types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from '../types.js';

const outputSchema = z.object({
  investigated: z.number(),
  confirmed: z.number(),
  reclassified: z.number(),
  budgetExceeded: z.boolean(),
});

export const agentsTier3Deliberator: PrimitiveEntry = {
  name: 'agents.tier3-deliberator',
  type: 'agentic',
  modelResolver: (cfg: Config) => resolveDeliberationModel(cfg),
  prompt: { kind: 'builder' },
  estimateCost: (input: CostEstimateInput): CostEstimate => {
    const shards = input.itemCount ?? 3;
    const inputTokens = shards * 4000;
    const outputTokens = shards * 1000;
    return {
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * 15 + outputTokens * 75) / 1_000_000,
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
  tools: [
    { name: 'bash', description: 'Execute shell commands for source verification' },
    { name: 'webSearch', description: 'Search documentation and references' },
  ],
};
