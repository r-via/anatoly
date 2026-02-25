import type { Config } from '../../schemas/config.js';
import type { AxisEvaluator, AxisId } from '../axis-evaluator.js';

import { UtilityEvaluator } from './utility.js';
import { DuplicationEvaluator } from './duplication.js';
import { CorrectionEvaluator } from './correction.js';
import { OverengineeringEvaluator } from './overengineering.js';
import { TestsEvaluator } from './tests.js';
import { BestPracticesEvaluator } from './best-practices.js';

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
];

/**
 * Returns the list of enabled evaluators based on the config.
 * Respects `axes.[axis].enabled` (default true for all axes).
 */
export function getEnabledEvaluators(config: Config): AxisEvaluator[] {
  return ALL_EVALUATORS.filter((evaluator) => {
    const axisConfig = config.llm.axes?.[evaluator.id];
    return axisConfig?.enabled !== false;
  });
}

/**
 * Get the full list of axis IDs.
 */
export const ALL_AXIS_IDS: readonly AxisId[] = [
  'utility',
  'duplication',
  'correction',
  'overengineering',
  'tests',
  'best_practices',
] as const;
