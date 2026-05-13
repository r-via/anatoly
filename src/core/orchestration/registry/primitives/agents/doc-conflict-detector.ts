// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../../../../schemas/config.js';
import { resolveAgentModel } from '../../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from '../types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from '../types.js';

const outputSchema = z.object({
  newConflicts: z.number(),
  applied: z.number(),
  stale: z.number(),
  pending: z.number(),
});

export const agentsDocConflictDetector: PrimitiveEntry = {
  name: 'agents.doc-conflict-detector',
  type: 'agentic',
  modelResolver: (cfg: Config) => resolveAgentModel('review', cfg),
  prompt: { kind: 'builder' },
  estimateCost: (input: CostEstimateInput): CostEstimate => {
    const items = input.itemCount ?? 20;
    const inputTokens = items * 1500;
    const outputTokens = items * 300;
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
};
