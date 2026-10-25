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

const bareId = (ref: string): string => ref.slice(ref.indexOf('/') + 1);

/**
 * The same defaults without the provider prefix (e.g. `claude-sonnet-5-5`),
 * for direct SDK calls and lookup tables keyed by bare model id.
 */
export const DEFAULT_MODEL_IDS = {
  quality: bareId(DEFAULT_MODELS.quality),
  fast: bareId(DEFAULT_MODELS.fast),
  deliberation: bareId(DEFAULT_MODELS.deliberation),
} as const;
