// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync } from 'node:fs';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { computeContentHash, atomicWriteJson } from '../utils/cache.js';
import { writeCacheWithMeta, loadCacheWithMeta } from '../utils/cache-meta.js';
import type { ReviewFile } from '../schemas/review.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewIndexEntry {
  hash: string;
  status: 'DONE' | 'CACHED';
  axes: string[];
  updated_at: string;
}

export interface ReviewIndex {
  version: 1;
  files: Record<string, ReviewIndexEntry>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Content-addressable path for a shared review payload.
 * Uses 2-hex-char sharding: `shared/reviews/<hash[0:2]>/<hash>.rev.json`
 */
export function sharedReviewPath(root: string, contentHash: string): string {
  return anatolyPath(root, 'shared/reviews', contentHash.slice(0, 2), contentHash + '.rev.json');
}

/**
 * Path to the per-project review index that tracks which files have been reviewed.
 */
export function reviewIndexPath(root: string): string {
  return anatolyPath(root, 'cache', 'review-index.json');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a review to the shared content-addressable store.
 *
 * 1. Computes content hash from file content (with line-ending normalization).
 * 2. Writes the review payload to `shared/reviews/<hash[0:2]>/<hash>.rev.json`
 *    with `_meta` headers via `writeCacheWithMeta`.
 * 3. Updates the per-project `cache/review-index.json`.
 */
export function writeSharedReview(
  root: string,
  review: ReviewFile,
  fileContent: string,
  promptHash: string,
  modelId: string,
  axes: string[],
): void {
  const contentHash = computeContentHash(fileContent);
  const sharedPath = sharedReviewPath(root, contentHash);

  // Write to shared store with _meta
  writeCacheWithMeta<ReviewFile>(sharedPath, review, {
    schema: 1,
    prompt_hash: promptHash,
    model_id: modelId,
  });

  // Update per-project review index
  const index = loadReviewIndex(root);
  index.files[review.file] = {
    hash: contentHash,
    status: 'DONE',
    axes: [...axes].sort(),
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(reviewIndexPath(root), index);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Try to load a cached review for a given file from the shared store.
 *
 * 1. Computes content hash from file content.
 * 2. Checks `cache/review-index.json` for matching hash + axes coverage.
 * 3. Reads `shared/reviews/<hash[0:2]>/<hash>.rev.json` via `loadCacheWithMeta`.
 * 4. Returns the review on hit, `null` on any miss.
 */
export function loadSharedReview(
  root: string,
  filePath: string,
  fileContent: string,
  promptHash: string,
  enabledAxes: string[],
): ReviewFile | null {
  const contentHash = computeContentHash(fileContent);
  const sharedPath = sharedReviewPath(root, contentHash);

  // Check per-project index first (fast path — avoids shared FS read)
  const index = loadReviewIndex(root);
  const entry = index.files[filePath];
  if (entry) {
    // Hash mismatch — content changed since last review
    if (entry.hash !== contentHash) return null;

    // Status must be DONE or CACHED
    if (entry.status !== 'DONE' && entry.status !== 'CACHED') return null;

    // Axes coverage check — cached review must cover all enabled axes
    const cachedAxes = new Set(entry.axes);
    const allCovered = enabledAxes.every((a) => cachedAxes.has(a));
    if (!allCovered) return null;

    return loadCacheWithMeta<ReviewFile>(sharedPath, { schema: 1, promptHash });
  }

  // Cross-project fallback: no index entry but shared payload may exist
  // (written by another project sharing the same ~/.anatoly/shared/).
  // Validate via _meta (prompt_hash + schema match).
  return loadCacheWithMeta<ReviewFile>(sharedPath, { schema: 1, promptHash });
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

export function loadReviewIndex(root: string): ReviewIndex {
  const path = reviewIndexPath(root);
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as ReviewIndex;
    if (raw.version !== 1) return { version: 1, files: {} };
    return raw;
  } catch {
    return { version: 1, files: {} };
  }
}
