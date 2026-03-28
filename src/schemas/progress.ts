// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

/**
 * Possible lifecycle states for a single file in a review run.
 *
 * A file moves through PENDING → IN_PROGRESS → DONE/TIMEOUT/ERROR.
 * CACHED indicates the file's content hash matched a prior run and
 * was reused without re-evaluation.
 */
export const FileStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'TIMEOUT',
  'ERROR',
  'CACHED',
]);

/**
 * Schema for the per-file progress entry within a review run.
 *
 * Each record tracks a file's current {@link FileStatusSchema | status},
 * the content hash used for cache invalidation, and an optional error
 * message if the review failed.
 */
export const FileProgressSchema = z.object({
  file: z.string(),
  hash: z.string(),
  status: FileStatusSchema,
  updated_at: z.string(),
  error: z.string().optional(),
  /** Sorted list of axis IDs that were evaluated (used for per-axis cache invalidation) */
  axes: z.array(z.string()).optional(),
});

/**
 * Schema for the top-level progress manifest persisted per run.
 *
 * `version: z.literal(1)` enforces an exact schema version so that future
 * changes can be detected and migrated rather than silently misinterpreted.
 */
export const ProgressSchema = z.object({
  version: z.literal(1),
  started_at: z.string(),
  files: z.record(z.string(), FileProgressSchema),
});

export type FileStatus = z.infer<typeof FileStatusSchema>;
export type FileProgress = z.infer<typeof FileProgressSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
