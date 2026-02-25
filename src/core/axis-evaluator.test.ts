import { describe, it, expect } from 'vitest';
import { resolveAxisModel } from './axis-evaluator.js';
import type { AxisEvaluator, AxisContext, AxisResult } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';
import { ConfigSchema } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function makeEvaluator(defaultModel: 'sonnet' | 'haiku'): AxisEvaluator {
  return {
    id: 'utility',
    defaultModel,
    evaluate: async (_ctx: AxisContext, _abort: AbortController): Promise<AxisResult> => {
      throw new Error('not implemented');
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveAxisModel', () => {
  it('should use config axis model override when specified', () => {
    const config = makeConfig({
      llm: { axes: { utility: { enabled: true, model: 'custom-model-123' } } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('custom-model-123');
  });

  it('should use fast_model for haiku evaluators when no axis override', () => {
    const config = makeConfig({
      llm: { fast_model: 'claude-haiku-4-5-20251001' },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should use main model for sonnet evaluators when no axis override', () => {
    const config = makeConfig({
      llm: { model: 'claude-sonnet-4-6' },
    });
    const evaluator = makeEvaluator('sonnet');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-sonnet-4-6');
  });

  it('should fall back to index_model when fast_model is not set for haiku evaluators', () => {
    const config = makeConfig();
    const evaluator = makeEvaluator('haiku');
    // fast_model is optional, should fall back to index_model
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should prefer axis model over fast_model and main model', () => {
    const config = makeConfig({
      llm: {
        model: 'claude-sonnet-4-6',
        fast_model: 'claude-haiku-4-5-20251001',
        axes: { utility: { model: 'override-model' } },
      },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('override-model');
  });
});
