// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';
import type { Config } from '../../../../schemas/config.js';
import { resolveAxisModel } from '../../../axis-evaluator.js';
import type { AxisEvaluator, AxisId } from '../../../axis-evaluator.js';
import { DUMP_LOCATION_TEMPLATE } from './types.js';
import type { PrimitiveEntry, CostEstimateInput, CostEstimate } from './types.js';

// ---------------------------------------------------------------------------
// Constants for axis cost estimation
// ---------------------------------------------------------------------------

const AVG_SYSTEM_PROMPT_TOKENS = 800;
const AVG_OUTPUT_TOKENS = 400;
const CHARS_PER_TOKEN = 4;
/** Rough Sonnet-class pricing: $3/1M input, $15/1M output */
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAxisPrimitive(opts: {
  name: string;
  axisId: AxisId;
  defaultModel: 'sonnet' | 'haiku';
  outputSchema: z.ZodTypeAny;
  /** Override default output token estimate (e.g. for verify pass). */
  avgOutputTokens?: number;
}): PrimitiveEntry {
  const outputTokens = opts.avgOutputTokens ?? AVG_OUTPUT_TOKENS;

  return {
    name: opts.name,
    type: 'single-turn',
    modelResolver: (cfg: Config) =>
      resolveAxisModel(
        { id: opts.axisId, defaultModel: opts.defaultModel } as AxisEvaluator,
        cfg,
      ),
    prompt: { kind: 'builder' },
    estimateCost: (input: CostEstimateInput): CostEstimate => {
      const inputTokens =
        AVG_SYSTEM_PROMPT_TOKENS +
        Math.ceil((input.inputChars ?? 5000) / CHARS_PER_TOKEN);
      return {
        inputTokens,
        outputTokens,
        costUsd:
          inputTokens * INPUT_COST_PER_TOKEN +
          outputTokens * OUTPUT_COST_PER_TOKEN,
      };
    },
    response: {
      schema: opts.outputSchema,
      outputSchema: opts.outputSchema,
      retry: { maxRetries: 2 },
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
      strategy: 'prompt-hash',
    },
  };
}
