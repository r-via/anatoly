// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

/**
 * The structured user-flow artifact (doc 23, section 3.3).
 *
 * A `UserFlow` is the deterministic skeleton of one parcours through the
 * project: where an external actor enters (`entry`), the ordered path of
 * project symbols it traverses (`steps`), and the terminal side effects it
 * reaches (`effects`). It is derived mechanically from the cross-file
 * reference graph (FunctionCard.referencedImports / calledInternals +
 * UsageGraph) with NO LLM, so the same index plus the same source always
 * produce the same skeletons (doc 23 invariant I2). The model is purely
 * DESCRIPTIVE: `finality` narrates the code (in Stage 1 it is the entry
 * card's already-indexed summary, never an invented business purpose, I3);
 * there is no verdict field and no expectation field.
 *
 * It is the canonical source-of-truth that the dead-intent router, the future
 * conformance matcher, a future web UI, and external runtime tools consume
 * (doc 23, section 4). The narrated, human-ratifiable page (Stage 2) is a
 * separate render produced by the doc pipeline, grounded by this artifact.
 *
 * Stage 1 is deliberately honest about what the graph proves: `entry.kind`,
 * `step.role`, and `effect.kind` are derived from each card's
 * `behavioralProfile` only (per-language route/CLI/handler conventions are
 * deferred, FP-safe), so the enums name exactly what the deterministic walk
 * can know and nothing more.
 */

/** Bump on a breaking shape change to the on-disk artifact. */
export const USER_FLOW_ARTIFACT_VERSION = 1;

/**
 * The flow entry point. Stage 1 only enters at a reference-graph root whose
 * behavioural profile marks a request/command boundary, so `kind` is exactly
 * that profile (`side_effect` for `sideEffectful`, `async` for `async`).
 */
export const FlowEndpointSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  kind: z.enum(['side_effect', 'async']),
});

/**
 * One hop on the ordered path. `role` is derived from the step card's
 * `behavioralProfile`: `effect` (sideEffectful), `state` (stateful), `async`
 * (async), `transform` (pure/memoized/utility), `unknown` (no profile
 * indexed). The array is in deterministic traversal (depth-first, pre-order)
 * order.
 */
export const FlowStepSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  role: z.enum(['transform', 'effect', 'state', 'async', 'unknown']),
});

/**
 * A terminal side effect reached on the path. `kind` is derived from the
 * card's `behavioralProfile` (`side_effect` for sideEffectful I/O,
 * `state_mutation` for stateful). The richer persistence/response/emit
 * taxonomy of the doc model is aspirational and needs the Stage-2 narration;
 * the deterministic walk reports only the coarse kind the profile proves.
 */
export const FlowEffectSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  kind: z.enum(['side_effect', 'state_mutation']),
});

export const UserFlowSchema = z.object({
  /** Stable, deterministic id derived from the entry: `flow:<file>::<symbol>`. */
  id: z.string(),
  /**
   * Human label. Stage 1 = the entry symbol name (literal fallback, I3); the
   * doc-pipeline narration enriches it in Stage 2.
   */
  name: z.string(),
  /**
   * One sentence describing what the path accomplishes, inferred from code.
   * Stage 1 = the entry card's indexed summary, or the symbol name when no
   * summary exists. Never an invented business purpose (I3).
   */
  finality: z.string(),
  entry: FlowEndpointSchema,
  steps: z.array(FlowStepSchema),
  effects: z.array(FlowEffectSchema),
  /**
   * How cleanly the skeleton resolved deterministically (0-100). NOT a
   * verdict: it reflects resolution quality (ambiguous import resolution and
   * depth-cap truncation lower it), so consumers can weigh a flow.
   */
  confidence: z.int().min(0).max(100),
  /**
   * Entry resolved but the path reached no terminal effect: a candidate
   * dead-intent flow (doc 23, section 5). Feeds the doc-22 dead_intent router.
   */
  unwired: z.boolean(),
});

/**
 * The on-disk artifact written to `.anatoly/state/internal-flows/flows.json`.
 * Re-derived and overwritten in place every run (the internal-docs persistence
 * model, not the per-run findings model): a stable, well-known path every
 * consumer reads.
 */
export const UserFlowArtifactSchema = z.object({
  version: z.literal(USER_FLOW_ARTIFACT_VERSION),
  /** == flows.length; carried for cheap consumer inspection without parsing the array. */
  flowCount: z.int().min(0),
  flows: z.array(UserFlowSchema),
});

export type FlowEndpoint = z.infer<typeof FlowEndpointSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowEffect = z.infer<typeof FlowEffectSchema>;
export type UserFlow = z.infer<typeof UserFlowSchema>;
export type UserFlowArtifact = z.infer<typeof UserFlowArtifactSchema>;
