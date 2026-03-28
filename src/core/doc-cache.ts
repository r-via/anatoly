// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Incremental Cache (SHA-256 per Page) — Story 29.9
 *
 * Maps each doc page to SHA-256 hashes of its source files.
 * On subsequent runs, only pages whose source files changed are regenerated.
 *
 * Cache file: `.anatoly/docs/.cache.json`
 * Hash granularity: per source file (one change → regenerate all dependent pages).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// --- Public interfaces ---

export interface DocCache {
  version: 1;
  /** pagePath → { sourceFilePath → SHA-256 hash } */
  pages: Record<string, Record<string, string>>;
}

export interface PageMapping {
  pagePath: string;
  sourceFiles: string[];
}

export interface CacheResult {
  /** Pages needing regeneration (source file hash changed) */
  stale: string[];
  /** Pages unchanged (cache hits) */
  fresh: string[];
  /** New pages not in cache */
  added: string[];
  /** Pages in cache but no longer mapped (source deleted) */
  removed: string[];
}

// --- Cache checking ---

/**
 * Compares current page mappings against the cache to determine
 * which pages need regeneration, which are fresh, which are new,
 * and which should be removed.
 *
 * Pages with zero source files ("base pages") are always treated as fresh
 * once cached, and only regenerated on bootstrap or explicit update.
 *
 * @param cache - The previously persisted doc cache to compare against.
 * @param currentPages - The current set of page-to-source-file mappings.
 * @param currentHashes - Map of source file paths to their current SHA-256 hashes.
 * @returns A {@link CacheResult} categorising each page as stale, fresh, added, or removed.
 */
export function checkDocCache(
  cache: DocCache,
  currentPages: PageMapping[],
  currentHashes: Map<string, string>,
): CacheResult {
  const stale: string[] = [];
  const fresh: string[] = [];
  const added: string[] = [];

  const currentPagePaths = new Set<string>();

  for (const page of currentPages) {
    currentPagePaths.add(page.pagePath);

    // Pages with no source files (base pages) are always fresh once cached.
    // They are only regenerated on bootstrap or explicit `docs update`.
    if (page.sourceFiles.length === 0) {
      if (cache.pages[page.pagePath]) {
        fresh.push(page.pagePath);
      } else {
        added.push(page.pagePath);
      }
      continue;
    }

    const cachedHashes = cache.pages[page.pagePath];
    if (!cachedHashes) {
      added.push(page.pagePath);
      continue;
    }

    // Check if source file list changed or any hash differs
    const cachedFiles = Object.keys(cachedHashes);
    const sourceFilesMatch =
      cachedFiles.length === page.sourceFiles.length &&
      page.sourceFiles.every(f => f in cachedHashes);

    if (!sourceFilesMatch) {
      stale.push(page.pagePath);
      continue;
    }

    const hashesMatch = page.sourceFiles.every(
      f => cachedHashes[f] === currentHashes.get(f),
    );

    if (hashesMatch) {
      fresh.push(page.pagePath);
    } else {
      stale.push(page.pagePath);
    }
  }

  // Find pages in cache that are no longer mapped
  const removed = Object.keys(cache.pages).filter(
    p => !currentPagePaths.has(p),
  );

  return { stale, fresh, added, removed };
}

// --- Cache mutation (pure) ---

/**
 * Returns a new cache with the given page entry added or updated.
 * The original cache object is not mutated.
 *
 * @param cache - The existing doc cache.
 * @param pagePath - The page path to add or update.
 * @param sourceHashes - A record mapping source file paths to their SHA-256 hashes.
 * @returns A new {@link DocCache} with the entry for `pagePath` set to `sourceHashes`.
 */
export function updateDocCacheEntry(
  cache: DocCache,
  pagePath: string,
  sourceHashes: Record<string, string>,
): DocCache {
  return {
    ...cache,
    pages: {
      ...cache.pages,
      [pagePath]: sourceHashes,
    },
  };
}

/**
 * Returns a new cache with the given page entry removed.
 * The original cache object is not mutated. If `pagePath` does not exist
 * in the cache, the returned cache is equivalent to the original.
 *
 * @param cache - The existing doc cache.
 * @param pagePath - The page path to remove.
 * @returns A new {@link DocCache} without the entry for `pagePath`.
 */
export function removeDocCacheEntry(
  cache: DocCache,
  pagePath: string,
): DocCache {
  const { [pagePath]: _, ...rest } = cache.pages;
  return { ...cache, pages: rest };
}

// --- Cache I/O ---

const EMPTY_CACHE: DocCache = { version: 1, pages: {} };

/**
 * Loads the doc cache from disk. Returns an empty cache if the file
 * does not exist or is malformed.
 *
 * @param cachePath - Absolute or relative path to the `.cache.json` file.
 * @returns The parsed {@link DocCache}, or an empty cache on any read/parse failure.
 */
export function loadDocCache(cachePath: string): DocCache {
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as DocCache;
    if (parsed.version === 1 && parsed.pages !== null && typeof parsed.pages === 'object') {
      return parsed;
    }
    return { ...EMPTY_CACHE };
  } catch {
    return { ...EMPTY_CACHE };
  }
}

/**
 * Saves the doc cache to disk. Creates parent directories if needed.
 *
 * @param cachePath - Absolute or relative path to write the `.cache.json` file.
 * @param cache - The {@link DocCache} to persist.
 */
export function saveDocCache(cachePath: string, cache: DocCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}
