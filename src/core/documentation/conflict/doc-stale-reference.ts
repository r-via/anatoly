// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { loadDocConflicts } from './doc-conflict-store.js';
import type { DocStaleReference } from '../../../schemas/review.js';

/**
 * Load code-wins applied entries from doc-conflicts.yaml and convert them
 * to DocStaleReference findings. Returns an empty array if no file exists
 * or on any error (defensive — never crash the pipeline).
 */
export function loadCodeWinsAsStaleReferences(projectRoot: string): DocStaleReference[] {
  try {
    const lock = loadDocConflicts(projectRoot);
    if (!lock) return [];

    return lock.entries
      .filter((e) => e.verdict === 'code-wins' && e.status === 'applied')
      .map((e) => ({
        kind: 'doc_stale_reference' as const,
        reference_path: e.reference_excerpt.path,
        reference_line_range: e.reference_excerpt.line_range,
        arbitrated_at: e.verdict_set_at ?? e.detected_at,
        arbitration_note: e.verdict_note,
      }));
  } catch {
    return [];
  }
}
