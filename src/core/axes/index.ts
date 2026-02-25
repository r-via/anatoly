import type { Config } from '../../schemas/config.js';
import type { AxisEvaluator, AxisId } from '../axis-evaluator.js';

// Evaluator imports will be added as each evaluator is implemented in Stories 19.3-19.5
// import { UtilityEvaluator } from './utility.js';
// import { DuplicationEvaluator } from './duplication.js';
// import { CorrectionEvaluator } from './correction.js';
// import { OverengineeringEvaluator } from './overengineering.js';
// import { TestsEvaluator } from './tests.js';
// import { BestPracticesEvaluator } from './best-practices.js';

/**
 * All available evaluators in execution order.
 * Will be populated as evaluators are implemented (Stories 19.3-19.5).
 */
const ALL_EVALUATORS: AxisEvaluator[] = [
  // To be added by Stories 19.3-19.5
];

/**
 * Resolve the effective model for an axis evaluator based on config overrides.
 *
 * Priority: axes.[axis].model → (haiku ? fast_model : model) → evaluator.defaultModel fallback
 */
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const axisConfig = config.llm.axes?.[evaluator.id];
  if (axisConfig?.model) return axisConfig.model;

  return evaluator.defaultModel === 'haiku'
    ? (config.llm.fast_model ?? config.llm.index_model)
    : config.llm.model;
}

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
