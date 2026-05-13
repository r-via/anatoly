// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { computeContentHash, atomicWriteJson, toOutputName } from '../utils/cache.js';
import { writeCacheWithMeta, loadCacheWithMeta } from '../utils/cache-meta.js';
import { getLogger } from '../utils/logger.js';
import { ReviewFileSchema, type ReviewFile } from '../schemas/review.js';

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
 * Content-addressable path for a review payload.
 * Uses 2-hex-char sharding: `cache/reviews/<hash[0:2]>/<hash>.rev.json`.
 * Project-local — reviews derive from user code, so they never leave this project.
 */
export function projectReviewPath(root: string, contentHash: string): string {
  return anatolyPath(root, 'cache/reviews', contentHash.slice(0, 2), contentHash + '.rev.json');
}

/**
 * Path to the per-project review index that tracks which files have been reviewed.
 * @internal — exposed for tests; not part of the cache module's external API.
 */
export function reviewIndexPath(root: string): string {
  return anatolyPath(root, 'cache', 'review-index.json');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a review to the project-local content-addressable store.
 *
 * 1. Computes content hash from file content (with line-ending normalization).
 * 2. Writes the review payload to `cache/reviews/<hash[0:2]>/<hash>.rev.json`
 *    with `_meta` headers via `writeCacheWithMeta`.
 * 3. Updates the per-project `cache/review-index.json`.
 */
export function writeProjectReview(
  root: string,
  review: ReviewFile,
  fileContent: string,
  promptHash: string,
  modelId: string,
  axes: string[],
): void {
  const contentHash = computeContentHash(fileContent);
  const cachePath = projectReviewPath(root, contentHash);

  writeCacheWithMeta<ReviewFile>(cachePath, review, {
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
 * Try to load a cached review for a given file from the project-local store.
 *
 * 1. Computes content hash from file content.
 * 2. Checks `cache/review-index.json` for matching hash + axes coverage.
 * 3. Reads `cache/reviews/<hash[0:2]>/<hash>.rev.json` via `loadCacheWithMeta`.
 * 4. Returns the review on hit, `null` on any miss.
 */
export function loadProjectReview(
  root: string,
  filePath: string,
  fileContent: string,
  promptHash: string,
  enabledAxes: string[],
): ReviewFile | null {
  const contentHash = computeContentHash(fileContent);
  const cachePath = projectReviewPath(root, contentHash);

  // Check per-project index first — covers the common case (same file path, same content)
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

    return loadCacheWithMeta<ReviewFile>(cachePath, { schema: 1, promptHash });
  }

  // No index entry → fall back to content-addressable lookup within THIS
  // project's cache. Catches the case where the same file content appeared
  // under a different path (renames, vendored duplicates).
  return loadCacheWithMeta<ReviewFile>(cachePath, { schema: 1, promptHash });
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

/** @internal — exposed for tests; callers should go through write/loadProjectReview. */
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

// ---------------------------------------------------------------------------
// Legacy fallback (transitional — pre-Story-52.4 path-based cache)
// ---------------------------------------------------------------------------

let _legacyCacheWarned = false;

/**
 * Read a review from the pre-Story-52.4 path-based cache layout
 * (`cache/reviews/<baseName>.rev.json`). Returns `null` if no legacy entry
 * exists or it fails schema validation.
 *
 * This is a read-only transitional fallback: caches written before May 2026
 * lived at path-based locations rather than the current content-addressable
 * sharded layout. Removing the fallback would silently invalidate every
 * pre-migration cache entry on disk; keeping it here lets old projects
 * survive an upgrade without forcing an `anatoly reset`.
 *
 * On the first hit per process, emits a one-shot warning. Plan to remove
 * this function after a release cycle (track via repo issue, not memory).
 */
export function loadLegacyPathBasedReview(projectRoot: string, filePath: string): ReviewFile | null {
  const legacyPath = join(anatolyPath(projectRoot, 'cache', 'reviews'), `${toOutputName(filePath)}.rev.json`);
  if (!existsSync(legacyPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const review = ReviewFileSchema.parse(raw);
    if (!_legacyCacheWarned) {
      getLogger().warn(
        'detected pre-Story-52.4 path-based review cache. These entries will be re-evaluated on next change; the fallback will be removed in a future release.',
      );
      _legacyCacheWarned = true;
    }
    return review;
  } catch {
    return null;
  }
}
