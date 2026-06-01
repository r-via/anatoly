// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { computeContentHash, atomicWriteJson, toOutputName } from '../../utils/cache.js';
import { writeCacheWithMeta, loadCacheWithMetaIgnoringPromptHash } from '../../utils/cache-meta.js';
import { getLogger } from '../../utils/logger.js';
import { ReviewFileSchema, type ReviewFile } from '../../schemas/review.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-axis freshness key. An axis recorded here was evaluated at the entry's
 * content `hash`, under this exact axis system-prompt hash and model. A read
 * reuses the cached verdict only when both still match the current run.
 */
export interface AxisCacheMeta {
  prompt_hash: string;
  model_id: string;
  updated_at: string;
}

export interface ReviewIndexEntry {
  /** Content hash of the file when the blob was written (blob address). */
  hash: string;
  status: 'DONE' | 'CACHED';
  /**
   * Per-axis freshness keys. Replaces the pre-v2 `string[]` coverage list:
   * each axis now carries its own prompt-hash + model so a single-axis run
   * invalidates only its own key and a full run reuses the rest.
   */
  axes: Record<string, AxisCacheMeta>;
  updated_at: string;
}

export interface ReviewIndex {
  version: 2;
  files: Record<string, ReviewIndexEntry>;
}

/** Sentinel `_meta.prompt_hash` for blobs whose freshness is tracked per-axis in the index. */
const PER_AXIS_BLOB_PROMPT_HASH = 'sha256:per-axis-index';

/** Result of {@link resolveAxisCache}: the cached blob plus the requested-axis split. */
export interface AxisCacheResolution {
  /** The cached full-coverage review blob for this content, or null on miss. */
  cached: ReviewFile | null;
  /** Requested axes whose per-axis key matches — reuse the cached verdict. */
  reusableAxes: string[];
  /** Requested axes that must be (re-)evaluated this run. */
  staleAxes: string[];
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
 * Write a (merged) review to the project-local content-addressable store and
 * record per-axis freshness keys.
 *
 * 1. Computes content hash from file content (with line-ending normalization).
 * 2. Writes the review payload to `cache/reviews/<hash[0:2]>/<hash>.rev.json`.
 *    The blob carries full coverage (the caller merges fresh axes onto the
 *    cached blob); freshness is tracked per-axis in the index, not on the blob.
 * 3. Merges the `justRunAxes` keys into the index entry, preserving keys for
 *    axes that were reused this run (only when content is unchanged).
 *
 * @param review     The full-coverage review to persist (post-merge).
 * @param axisMeta   Per-axis `{prompt_hash, model_id}` for the axes just run.
 * @param justRunAxes Axes evaluated (and succeeded) this run — their keys are
 *                    (re)written. Axes absent here keep their prior key when
 *                    the content hash is unchanged, else are dropped (stale).
 */
export function writeProjectReview(
  root: string,
  review: ReviewFile,
  fileContent: string,
  axisMeta: Record<string, { prompt_hash: string; model_id: string }>,
  justRunAxes: string[],
): void {
  const contentHash = computeContentHash(fileContent);
  const cachePath = projectReviewPath(root, contentHash);

  const blobModelId =
    [...new Set(Object.values(axisMeta).map((m) => m.model_id))].sort().join('+') || 'unknown';
  writeCacheWithMeta<ReviewFile>(cachePath, review, {
    schema: 1,
    prompt_hash: PER_AXIS_BLOB_PROMPT_HASH,
    model_id: blobModelId,
  });

  const now = new Date().toISOString();
  const index = loadReviewIndex(root);
  const prev = index.files[review.file];
  // Preserve prior per-axis keys ONLY when the blob still addresses the same
  // content; a content change means the old keys describe a file that no
  // longer exists at this hash, so those axes must be re-evaluated next run.
  const axes: Record<string, AxisCacheMeta> =
    prev && prev.hash === contentHash ? { ...prev.axes } : {};
  for (const axis of justRunAxes) {
    const m = axisMeta[axis];
    if (!m) continue;
    axes[axis] = { prompt_hash: m.prompt_hash, model_id: m.model_id, updated_at: now };
  }
  index.files[review.file] = { hash: contentHash, status: 'DONE', axes, updated_at: now };
  atomicWriteJson(reviewIndexPath(root), index);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Resolve the per-axis cache state for a file: which requested axes can be
 * reused from the cached blob and which must be (re-)evaluated this run.
 *
 * Freshness rules:
 *  - content changed (or no entry / blob missing) → ALL requested axes stale;
 *    `cached` is null (the merge base is "nothing").
 *  - otherwise, per requested axis: reusable iff the index records that axis
 *    with a matching prompt-hash AND model; else stale.
 *
 * The blob is read ignoring its `_meta.prompt_hash` (freshness is per-axis in
 * the index now, not a single bundle hash on the blob). Returning the cached
 * blob lets the caller merge fresh stale-axis verdicts onto it via
 * {@link mergeRefreshedReview} so the rewritten blob keeps full coverage.
 */
export function resolveAxisCache(
  root: string,
  filePath: string,
  fileContent: string,
  requestedAxes: string[],
  axisPromptHashes: Record<string, string>,
  axisModelIds: Record<string, string>,
): AxisCacheResolution {
  const contentHash = computeContentHash(fileContent);
  const index = loadReviewIndex(root);
  const entry = index.files[filePath];

  const allStale = (): AxisCacheResolution => ({ cached: null, reusableAxes: [], staleAxes: [...requestedAxes] });

  if (!entry || entry.hash !== contentHash) return allStale();
  if (entry.status !== 'DONE' && entry.status !== 'CACHED') return allStale();

  const loaded = loadCacheWithMetaIgnoringPromptHash<ReviewFile>(projectReviewPath(root, contentHash), { schema: 1 });
  if (!loaded) return allStale(); // index says reviewed but blob is gone

  const reusableAxes: string[] = [];
  const staleAxes: string[] = [];
  for (const axis of requestedAxes) {
    const meta = entry.axes[axis];
    if (meta && meta.prompt_hash === axisPromptHashes[axis] && meta.model_id === axisModelIds[axis]) {
      reusableAxes.push(axis);
    } else {
      staleAxes.push(axis);
    }
  }
  return { cached: loaded.data, reusableAxes, staleAxes };
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

/**
 * @internal — exposed for tests; callers should go through
 * writeProjectReview / resolveAxisCache.
 *
 * Returns an empty v2 index for any non-v2 on-disk file. This is the
 * migration: a pre-v2 index (per-file `string[]` coverage, no per-axis
 * prompt keys) is silently abandoned, forcing a one-time full re-evaluation,
 * after which the per-axis keys are populated. The content-addressed blobs on
 * disk are untouched and get re-referenced as they are rewritten.
 */
export function loadReviewIndex(root: string): ReviewIndex {
  const path = reviewIndexPath(root);
  if (!existsSync(path)) return { version: 2, files: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as ReviewIndex;
    if (raw.version !== 2) return { version: 2, files: {} };
    return raw;
  } catch {
    return { version: 2, files: {} };
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
