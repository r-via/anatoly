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
 * Respects `axes.[axis].enabled` (default true for all axes).
 * When `axesFilter` is provided, only axes in both the config AND the filter are returned (intersection).
 */
export function getEnabledEvaluators(config: Config, axesFilter?: AxisId[]): AxisEvaluator[] {
  return ALL_EVALUATORS.filter((evaluator) => {
    const axisConfig = config.llm.axes?.[evaluator.id];
    if (axisConfig?.enabled === false) return false;
    if (axesFilter && !axesFilter.includes(evaluator.id)) return false;
    return true;
  });
}

/**
 * Get the full list of axis IDs (derived from ALL_EVALUATORS — single source of truth).
 */
export const ALL_AXIS_IDS: readonly AxisId[] = ALL_EVALUATORS.map((e) => e.id);
