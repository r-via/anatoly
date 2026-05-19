// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { loadDocConflicts } from './doc-conflict-store.js';
import type { DocStaleReference, DocConflictFinding } from '../../../schemas/review.js';

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

/**
 * doc 16 PR 3a — load UNRESOLVED (pending) conflicts from doc-conflicts.yaml
 * and surface them as `doc_conflict` findings, so a detected code↔reference
 * contradiction is reported to the user instead of being silently dropped
 * (doc-15 no-silent-drop; the §3 "surface, do not adjudicate" clause). The
 * tool reports the divergence; resolving it stays the human's job
 * (`anatoly docs arbitrate`). Only active/stale-by-codechange pending
 * entries qualify (skipped/applied are resolved). Defensive: any failure
 * yields [] — never crash the pipeline.
 */
export function loadPendingConflictsAsDocConflicts(projectRoot: string): DocConflictFinding[] {
  try {
    const lock = loadDocConflicts(projectRoot);
    if (!lock) return [];

    return lock.entries
      .filter((e) =>
        e.verdict === 'pending' &&
        (e.status === 'active' || e.status === 'stale-by-codechange'),
      )
      .map((e) => ({
        kind: 'doc_conflict' as const,
        file: e.anchor.file,
        ...(e.anchor.symbol ? { symbol: e.anchor.symbol } : {}),
        reference_path: e.reference_excerpt.path,
        ...(e.reference_excerpt.line_range ? { reference_line_range: e.reference_excerpt.line_range } : {}),
        reference_text: e.reference_excerpt.text,
        code_summary: e.code_summary,
        detected_at: e.detected_at,
      }));
  } catch {
    return [];
  }
}
