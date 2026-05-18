// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `evaluation/` bounded context: the Review + Deliberation phase, and the
 * shared kernel (`axis-evaluator`). doc 13 PR 7 is move-only; PR 7b splits
 * `axis-evaluator` into `contract.ts` (published language) + `evaluator.ts`
 * (impl) per doc 12 §4 and repoints the §4/§5 contract consumers from this
 * barrel to `evaluation/contract.js`. The `axes/` and `refinement/`
 * sub-folders nest here behind this single barrel (doc 12 §1 rule 1, §3.2).
 *
 * Published surface (doc 13 §8): the real public API of the context's
 * modules; everything outside `evaluation/` imports this barrel, never a
 * module path inside it. Intra-context modules import each other relatively.
 */

export {
  resolveAxisModel,
  resolveCodeSummaryModel,
  resolveDeliberationModel,
  resolveAgentModel,
  composeAxisSystemPrompt,
  runSingleTurnQuery,
  runUnit,
  getCodeFenceTag,
  getLanguageLines,
  buildProviderStats,
} from './evaluator.js';
export type {
  AxisContext,
  AxisEvaluator,
  AxisId,
  AxisResult,
  AxisSymbolResult,
  PreResolvedRag,
  PreResolvedRagEntry,
  RelevantDoc,
  SingleTurnQueryParams,
  SingleTurnQueryResult,
  ExecutionUnit,
  HarnessCtx,
} from './contract.js';

export { mergeAxisResults } from './axis-merger.js';

export {
  loadCalibration,
  formatCalibratedTime,
  recalibrateFromRuns,
  saveCalibration,
  estimateCalibratedMinutes,
} from './calibration.js';
export type { AxisCalibration, CalibrationData } from './calibration.js';

export {
  applyDeliberation,
  buildDeliberationSystemPrompt,
  buildDeliberationUserMessage,
  needsDeliberation,
  DeliberatedSymbolSchema,
  DeliberationResponseSchema,
} from './deliberation.js';
export type { DeliberatedSymbol, DeliberationResponse } from './deliberation.js';

export { evaluateFile } from './file-evaluator.js';
export type { AxisTiming, EvaluateFileOptions, EvaluateFileResult } from './file-evaluator.js';

export { triageFile, generateSkipReview, evaluatorAxesForSkip } from './triage.js';
export type { TriageResult, TriageTier } from './triage.js';

export { getEnabledEvaluators, ALL_AXIS_IDS, isDocAxisActive } from './axes/index.js';
export type { ArbitratedFragment } from './axes/reference-docs-context.js';

export { runRefinementPhase } from './refinement/phase.js';
export type { RefinementContext, RefinementResult, ProgressEvent } from './refinement/phase.js';
