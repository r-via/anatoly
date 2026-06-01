// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolveSystemPrompt } from '../platform/index.js';
import { computePromptHash } from '../../utils/cache-meta.js';

/**
 * Compute the freshness hash for a SINGLE axis: its system prompt + the model
 * that axis runs on. This is the per-axis review cache key.
 *
 * The per-axis review cache stores one of these per (file, axis) so that a
 * `--axes utility` run only invalidates utility's key and a later full run
 * reuses the other six axes' cached verdicts. A change to one axis's system
 * prompt (or its model) invalidates only that axis, never the rest. This is
 * the inverse of the pre-v2 bundle hash, which combined every enabled axis's
 * prompt into one digest and so made a single-axis run's cache entry disjoint
 * from a full run's — forcing a full re-evaluation to recover coverage.
 *
 * The content dimension is handled separately by the content-addressed blob
 * (a file edit invalidates every axis for that file), so it is deliberately
 * NOT part of this hash.
 */
export function computeAxisPromptHash(axisId: string, modelId: string): string {
  let systemPrompt: string;
  try { systemPrompt = resolveSystemPrompt(axisId); } catch { systemPrompt = axisId; }
  return computePromptHash({
    schemaVersion: 1,
    modelId,
    systemPrompt,
    userTemplate: '', // User template varies per file — we use content hash for that
  });
}
