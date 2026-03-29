// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { getEnabledEvaluators, ALL_AXIS_IDS } from './index.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

describe('getEnabledEvaluators', () => {
  it('should return all evaluators with default config', () => {
    const config = makeConfig();
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length);
    expect(evaluators.map((e) => e.id)).toEqual([...ALL_AXIS_IDS]);
  });

  it('should filter out disabled axes', () => {
    const config = makeConfig({
      axes: { utility: { enabled: false }, best_practices: { enabled: false } },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length - 2);
    expect(evaluators.map((e) => e.id)).not.toContain('utility');
    expect(evaluators.map((e) => e.id)).not.toContain('best_practices');
  });

  it('should keep axis enabled when config is missing for that axis', () => {
    const config = makeConfig({ axes: {} });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length);
  });

  it('should return empty when all axes disabled', () => {
    const config = makeConfig({
      axes: {
        utility: { enabled: false },
        duplication: { enabled: false },
        correction: { enabled: false },
        overengineering: { enabled: false },
        tests: { enabled: false },
        best_practices: { enabled: false },
        documentation: { enabled: false },
      },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(0);
  });

  it('should filter by axesFilter when provided', () => {
    const config = makeConfig();
    const evaluators = getEnabledEvaluators(config, ['correction', 'tests']);
    expect(evaluators).toHaveLength(2);
    expect(evaluators.map((e) => e.id)).toEqual(['correction', 'tests']);
  });

  it('should intersect axesFilter with config-disabled axes', () => {
    const config = makeConfig({
      axes: { correction: { enabled: false } },
    });
    const evaluators = getEnabledEvaluators(config, ['correction', 'tests']);
    expect(evaluators).toHaveLength(1);
    expect(evaluators[0].id).toBe('tests');
  });

  it('should return all enabled axes when axesFilter is undefined', () => {
    const config = makeConfig();
    const evaluators = getEnabledEvaluators(config, undefined);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length);
  });
});

describe('ALL_AXIS_IDS', () => {
  it('should be derived from evaluators and contain all expected axes', () => {
    expect(ALL_AXIS_IDS.length).toBeGreaterThanOrEqual(7);
    expect(ALL_AXIS_IDS).toContain('utility');
    expect(ALL_AXIS_IDS).toContain('duplication');
    expect(ALL_AXIS_IDS).toContain('correction');
    expect(ALL_AXIS_IDS).toContain('overengineering');
    expect(ALL_AXIS_IDS).toContain('tests');
    expect(ALL_AXIS_IDS).toContain('best_practices');
    expect(ALL_AXIS_IDS).toContain('documentation');
  });
});
