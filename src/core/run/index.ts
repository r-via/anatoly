// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `run/` bounded context: run lifecycle, configuration, resumability state.
 *
 * Distinct from `orchestration/`, which sequences phases; this context holds
 * the state being sequenced (config, status, progress, estimates, the
 * project review cache, background-run launch, the ndjson tail).
 *
 * Published surface (doc 12 §1 rule 1, doc 13 PR 4). Everything outside this
 * context imports this barrel, never a module path inside it. The surface is
 * exactly the symbols current external importers use, no speculative API
 * (doc 13 §8).
 */

export { resolveDocMode, buildRunConfig, writeRunConfig, readRunConfig } from './run-config.js';

export {
  writeRunStatus,
  readRunStatus,
  listRunStatuses,
  isProcessAlive,
  getGitInfo,
  detectResumableRun,
} from './run-status.js';
export type { RunStatus, ResumableRun } from './run-status.js';

export { launchBackgroundRun, buildForwardedArgs } from './background-runner.js';

export { ProgressManager } from './progress-manager.js';

export {
  loadTasks,
  forecastRun,
  formatTokenCount,
  FORECAST_STEP_CATEGORY_ORDER,
  countTokens,
  estimateFileSeconds,
  estimateTasksTokens,
} from './estimator.js';
export type { ForecastStep } from './estimator.js';

export {
  writeProjectReview,
  loadProjectReview,
  loadProjectReviewRaw,
  loadLegacyPathBasedReview,
  projectReviewPath,
} from './project-review-cache.js';

export { tailNdjson } from './ndjson-tail.js';
export type { TailHandle } from './ndjson-tail.js';
