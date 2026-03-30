// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi } from 'vitest';
import { getEnabledEvaluators, ALL_AXIS_IDS } from './index.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

/** Helper: config with all axes present and enabled. */
function allAxesConfig(extra: Record<string, unknown> = {}): Config {
  return makeConfig({
    axes: {
      utility: { enabled: true },
      duplication: { enabled: true },
      correction: { enabled: true },
      overengineering: { enabled: true },
      tests: { enabled: true },
      best_practices: { enabled: true },
      documentation: { enabled: true },
    },
    ...extra,
  });
}

describe('getEnabledEvaluators', () => {
  it('should return all evaluators when all axes are in config', () => {
    const config = allAxesConfig();
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length);
    expect(evaluators.map((e) => e.id)).toEqual([...ALL_AXIS_IDS]);
  });

  it('should return all evaluators with default config (all axes enabled by default)', () => {
    const config = makeConfig();
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(ALL_AXIS_IDS.length);
  });

  it('should return empty when all axes are explicitly absent', () => {
    const config = makeConfig({ axes: {} });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(0);
  });

  it('should only return axes present in config', () => {
    const config = makeConfig({
      axes: { utility: {}, tests: {} },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(2);
    expect(evaluators.map((e) => e.id)).toEqual(['utility', 'tests']);
  });

  it('should filter out explicitly disabled axes', () => {
    const config = makeConfig({
      axes: {
        utility: { enabled: false },
        duplication: {},
        best_practices: { enabled: false },
      },
    });
    const evaluators = getEnabledEvaluators(config);
    expect(evaluators).toHaveLength(1);
    expect(evaluators[0].id).toBe('duplication');
  });

  it('should log info for axes not in config', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = makeConfig({ axes: { utility: {} } });
    getEnabledEvaluators(config);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('correction');
    spy.mockRestore();
  });

  it('should filter by axesFilter when provided', () => {
    const config = allAxesConfig();
    const evaluators = getEnabledEvaluators(config, ['correction', 'tests']);
    expect(evaluators).toHaveLength(2);
    expect(evaluators.map((e) => e.id)).toEqual(['correction', 'tests']);
  });

  it('should intersect axesFilter with config-disabled axes', () => {
    const config = makeConfig({
      axes: { correction: { enabled: false }, tests: {} },
    });
    const evaluators = getEnabledEvaluators(config, ['correction', 'tests']);
    expect(evaluators).toHaveLength(1);
    expect(evaluators[0].id).toBe('tests');
  });

  it('should return all enabled axes when axesFilter is undefined', () => {
    const config = allAxesConfig();
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
