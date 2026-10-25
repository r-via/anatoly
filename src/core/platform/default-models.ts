// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Single source of truth for default model identifiers used when generating
 * a new `.anatoly.yml` (Zod schema defaults, init wizard, first-run wizard).
 *
 * Bumping a default = edit one line here. All consumers (schema, init,
 * setup-prompts) read from this constant.
 */
export const DEFAULT_MODELS = {
  /** Quality tier — axis evaluations (Sonnet). */
  quality: 'anthropic/claude-sonnet-5-5',
  /** Fast tier — triage, code summaries (Haiku). */
  fast: 'anthropic/claude-haiku-5-5',
  /** Deliberation tier — refinement / investigation (Opus). */
  deliberation: 'anthropic/claude-opus-5-5',
} as const;

/** Strip the provider prefix from a model ref (`anthropic/x` → `x`); bare ids pass through. */
export const bareModelId = (ref: string): string => ref.slice(ref.indexOf('/') + 1);

/**
 * The same defaults without the provider prefix (e.g. `claude-sonnet-5-5`),
 * for direct SDK calls and lookup tables keyed by bare model id.
 */
export const DEFAULT_MODEL_IDS = {
  quality: bareModelId(DEFAULT_MODELS.quality),
  fast: bareModelId(DEFAULT_MODELS.fast),
  deliberation: bareModelId(DEFAULT_MODELS.deliberation),
} as const;

/** Reasoning effort levels accepted by the Claude API (`output_config.effort`). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Default reasoning effort per tier, sent explicitly on every Claude Agent
 * SDK call. Left unset, the bundled CLI picks it per model: `high` for the
 * 4.6 models but `medium` for the 5.5 ones, which cost 0.15 F1 on the
 * slot-engine bench (ANA-4). `high` everywhere is the measured configuration
 * and what the 4.6 models already received. The CLI drops the field for
 * models without effort support (Haiku 4.5) and clamps unsupported levels.
 */
export const DEFAULT_EFFORT = {
  quality: 'high',
  fast: 'high',
  deliberation: 'high',
  code_summary: 'high',
} as const satisfies Record<string, EffortLevel>;
