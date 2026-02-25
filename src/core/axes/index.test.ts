import { describe, it, expect } from 'vitest';
import { getEnabledEvaluators, ALL_AXIS_IDS } from './index.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

describe('getEnabledEvaluators', () => {
  it('should return all 6 evaluators with default config', () => {
    const config = makeConfig();
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(6);
    expect(evaluators.map((e) => e.id)).toEqual([...ALL_AXIS_IDS]);
  });

  it('should filter out disabled axes', () => {
    const config = makeConfig({
      llm: { axes: { utility: { enabled: false }, best_practices: { enabled: false } } },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(4);
    expect(evaluators.map((e) => e.id)).not.toContain('utility');
    expect(evaluators.map((e) => e.id)).not.toContain('best_practices');
  });

  it('should keep axis enabled when config is missing for that axis', () => {
    const config = makeConfig({ llm: { axes: {} } });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(6);
  });

  it('should return empty when all axes disabled', () => {
    const config = makeConfig({
      llm: {
        axes: {
          utility: { enabled: false },
          duplication: { enabled: false },
          correction: { enabled: false },
          overengineering: { enabled: false },
          tests: { enabled: false },
          best_practices: { enabled: false },
        },
      },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(0);
  });
});

describe('ALL_AXIS_IDS', () => {
  it('should contain exactly 6 axis IDs', () => {
    expect(ALL_AXIS_IDS).toHaveLength(6);
    expect(ALL_AXIS_IDS).toEqual([
      'utility', 'duplication', 'correction', 'overengineering', 'tests', 'best_practices',
    ]);
  });
});
