// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../../../../schemas/config.js';
import { resolveAgentModel } from '../../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from '../types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from '../types.js';

const outputSchema = z.object({
  pagesWritten: z.number(),
  pagesFailed: z.number(),
});

export const agentsDocGenerator: PrimitiveEntry = {
  name: 'agents.doc-generator',
  type: 'agentic',
  modelResolver: (cfg: Config) => resolveAgentModel('scaffolding', cfg),
  prompt: { kind: 'builder' },
  estimateCost: (input: CostEstimateInput): CostEstimate => {
    const pages = input.itemCount ?? 5;
    const inputTokens = pages * 2000;
    const outputTokens = pages * 1500;
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
    { name: 'bash', description: 'Execute shell commands for file inspection' },
  ],
};
