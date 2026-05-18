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
  quality: 'anthropic/claude-sonnet-4-6',
  /** Fast tier — triage, code summaries (Haiku). */
  fast: 'anthropic/claude-haiku-4-5-20251001',
  /** Deliberation tier — refinement / investigation (Opus). */
  deliberation: 'anthropic/claude-opus-4-6',
} as const;
