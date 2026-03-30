// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Config } from '../../schemas/config.js';
import type { AxisEvaluator, AxisId } from '../axis-evaluator.js';

import { UtilityEvaluator } from './utility.js';
import { DuplicationEvaluator } from './duplication.js';
import { CorrectionEvaluator } from './correction.js';
import { OverengineeringEvaluator } from './overengineering.js';
import { TestsEvaluator } from './tests.js';
import { BestPracticesEvaluator } from './best-practices.js';
import { DocumentationEvaluator } from './documentation.js';

/**
 * All available evaluators in execution order.
 */
const ALL_EVALUATORS: AxisEvaluator[] = [
  new UtilityEvaluator(),
  new DuplicationEvaluator(),
  new CorrectionEvaluator(),
  new OverengineeringEvaluator(),
  new TestsEvaluator(),
  new BestPracticesEvaluator(),
  new DocumentationEvaluator(),
];

/**
 * Returns the list of enabled evaluators based on the config.
 * An axis must be present in `axes` to be enabled — absent axes are skipped
 * with a warning. Axes explicitly set to `enabled: false` are also skipped.
 * When `axesFilter` is provided, only axes in both the config AND the filter are returned (intersection).
 */
export function getEnabledEvaluators(config: Config, axesFilter?: AxisId[]): AxisEvaluator[] {
  const skipped: string[] = [];
  const result = ALL_EVALUATORS.filter((evaluator) => {
    const axisConfig = config.axes?.[evaluator.id];
    if (!axisConfig) {
      skipped.push(evaluator.id);
      return false;
    }
    if (axisConfig.enabled === false) return false;
    if (axesFilter && !axesFilter.includes(evaluator.id)) return false;
    return true;
  });
  if (skipped.length > 0) {
    console.info(`ℹ Axes not in config (disabled): ${skipped.join(', ')}. Add them to 'axes' in .anatoly.yml to enable.`);
  }
  return result;
}

/**
 * Get the full list of axis IDs (derived from ALL_EVALUATORS — single source of truth).
 */
export const ALL_AXIS_IDS: readonly AxisId[] = ALL_EVALUATORS.map((e) => e.id);
