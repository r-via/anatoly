// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../../../../schemas/config.js';
import { resolveAgentModel } from '../../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from '../types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from '../types.js';

const outputSchema = z.object({
  text: z.string(),
});

export const agentsVercelAgent: PrimitiveEntry = {
  name: 'agents.vercel-agent',
  type: 'agentic',
  modelResolver: (cfg: Config) => resolveAgentModel('review', cfg),
  prompt: { kind: 'builder' },
  estimateCost: (input: CostEstimateInput): CostEstimate => {
    const inputTokens = 3000 + Math.ceil((input.inputChars ?? 5000) / 4);
    const outputTokens = 2000;
    return {
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000,
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
    { name: 'bash', description: 'Execute shell commands' },
    { name: 'webSearch', description: 'Search the web for information' },
  ],
};
