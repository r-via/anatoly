// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolveSystemPrompt } from '../platform/index.js';
import { computePromptHash } from '../../utils/cache-meta.js';

/**
 * Compute a combined prompt hash for a set of enabled axis system prompts.
 *
 * Used as the `prompt_hash` in shared review cache `_meta` headers, and
 * also by the reseed command to compute the hash a re-imported review
 * SHOULD carry now (so a future read matches).
 *
 * The hash bundles every axis prompt together: that is what makes a
 * `--axes utility` cache entry distinct from a full-axes cache entry,
 * even when each individual axis prompt is byte-identical.
 */
export function computeAxesPromptHash(axisIds: string[], modelId: string): string {
  const sortedAxes = [...axisIds].sort();
  const systemPrompts = sortedAxes.map((id) => {
    try { return resolveSystemPrompt(id); } catch { return id; }
  }).join('\0');
  return computePromptHash({
    schemaVersion: 1,
    modelId,
    systemPrompt: systemPrompts,
    userTemplate: '', // User template varies per file — we use content hash for that
  });
}
