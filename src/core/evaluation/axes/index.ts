// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Config } from '../../../schemas/config.js';
import type { AxisEvaluator, AxisId } from '../contract.js';
import type { RunContext } from '../../../commands/run.js';

import { UtilityEvaluator } from './utility.js';
import { DuplicationEvaluator } from './duplication.js';
import { CorrectionEvaluator } from './correction.js';
import { OverengineeringEvaluator } from './overengineering.js';
import { TestsEvaluator } from './tests.js';
import { BestPracticesEvaluator } from './best-practices.js';
import { DocumentationEvaluator } from './documentation.js';
import { FlowEvaluator } from './flow.js';

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
  new FlowEvaluator(),
];

/**
 * Whether the documentation axis is active for this run. Relocated verbatim
 * from `commands/run.ts` (PR 3, doc 11): it is a doc-axis gate predicate
 * shared by the orchestration spine and the setup phase, so it lives with the
 * other axis-enablement logic rather than forcing the extracted setup phase
 * to import back into the commands layer. `RunContext` is type-only (erased).
 */
export function isDocAxisActive(ctx: RunContext): boolean {
  if (ctx.config.axes?.documentation?.enabled === false) return false;
  if (ctx.axesFilter && !ctx.axesFilter.includes('documentation')) return false;
  return true;
}

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
    process.stderr.write(`ℹ Axes not in config (disabled): ${skipped.join(', ')}. Add them to 'axes' in .anatoly.yml to enable.\n`);
  }
  return result;
}

/**
 * Get the full list of axis IDs (derived from ALL_EVALUATORS — single source of truth).
 */
export const ALL_AXIS_IDS: readonly AxisId[] = ALL_EVALUATORS.map((e) => e.id);

/**
 * Per-axis default model tier (`haiku` | `sonnet`), derived from each
 * evaluator's `defaultModel` — single source of truth. The report uses this to
 * label which tier evaluated each axis. It replaces a hardcoded map that lived
 * in the reporting layer and had drifted out of sync (it claimed `haiku` for
 * axes that actually run on `sonnet`). Note: a per-axis `axes.<id>.model`
 * config override is not reflected here; this reports the evaluator default.
 */
export const AXIS_DEFAULT_MODELS: Record<AxisId, 'haiku' | 'sonnet'> =
  Object.fromEntries(ALL_EVALUATORS.map((e) => [e.id, e.defaultModel])) as Record<AxisId, 'haiku' | 'sonnet'>;
