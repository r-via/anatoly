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

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { anatolyPath } from '../utils/anatoly-paths.js';

// --- Public interfaces ---

/** Pipeline-complete marker (formerly `state/internal-docs/.scaffold-status.json`). */
export interface ScaffoldInfo {
  /** ISO-8601 timestamp of the last successful scaffold/update + coherence. */
  scaffoldedAt: string;
  /** Whether the last successful pipeline was a fresh scaffold or an update. */
  lastMode: 'bootstrap' | 'update';
  /** Run id that produced this status. */
  lastRunId?: string;
}

/** Global coherence-agent flag. */
export interface CoherenceInfo {
  /** Signature of the doc set the coherence pass last reviewed. */
  key: string;
  /** ISO-8601 timestamp of that successful coherence pass. */
  at: string;
}

/**
 * The single doc-flag ledger: `.anatoly/cache/doc-build/manifest.json`.
 *
 * One file holds every doc-pipeline flag — per-page generation
 * ({@link pages}), the pipeline-complete marker ({@link scaffold}), and the
 * global coherence flag ({@link coherence}) — so a retry never redoes work
 * already done. It lives under `cache/`: clearing `.anatoly/cache/` is an
 * explicit "redo from scratch" and correctly drops all completion state.
 */
export interface DocCache {
  /**
   * Schema version. v1/v2 are discarded on load:
   * - v1 entries were written by `runDocGeneration` at *planning* time
   *   (before the page existed) → poisoned, indistinguishable from real ones.
   * - v2 split per-page flags here from scaffold-status elsewhere.
   * From v3 every flag is in this one file and only ever written *after* the
   * work it records succeeded, so the whole ledger is trustworthy. A bump
   * forces exactly one clean regeneration.
   */
  version: 3;
  /** pagePath → { sourceFilePath → SHA-256 hash }. Written post-generation. */
  pages: Record<string, Record<string, string>>;
  /** Set once the whole pipeline (gen + lint + coherence) completed. */
  scaffold?: ScaffoldInfo;
  /** Set by the coherence agent once its pass completed. */
  coherence?: CoherenceInfo;
}

/** The one place every doc flag lives. */
export function docManifestPath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'cache/doc-build', 'manifest.json');
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
 * `isPageComplete` lets the caller veto a cache hit: a page whose source
 * hashes match but whose on-disk file was never actually generated (still a
 * scaffold stub, or missing) must NOT be treated as fresh. Without this a
 * crashed/partial generation run permanently poisons the manifest — the
 * cache records the page as done while the file stays a stub, so it is never
 * regenerated. When the predicate is omitted, behaviour is unchanged
 * (a cache record alone marks a page fresh).
 */
export function checkDocCache(
  cache: DocCache,
  currentPages: PageMapping[],
  currentHashes: Map<string, string>,
  isPageComplete?: (pagePath: string) => boolean,
): CacheResult {
  const stale: string[] = [];
  const fresh: string[] = [];
  const added: string[] = [];

  const currentPagePaths = new Set<string>();
  // A cached page only counts as a hit if it is also complete on disk.
  const cachedAndComplete = (pagePath: string): boolean =>
    Boolean(cache.pages[pagePath]) && (isPageComplete?.(pagePath) ?? true);

  for (const page of currentPages) {
    currentPagePaths.add(page.pagePath);

    // Pages with no source files (base pages) are fresh once cached AND
    // actually generated. A cached-but-still-stub base page falls through
    // to `added` so it gets (re)generated.
    if (page.sourceFiles.length === 0) {
      if (cachedAndComplete(page.pagePath)) {
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

    // Hashes match but the page was never written → regenerate (stale),
    // not fresh. This is the self-healing path for a poisoned manifest.
    if (hashesMatch && (isPageComplete?.(page.pagePath) ?? true)) {
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
 */
export function removeDocCacheEntry(
  cache: DocCache,
  pagePath: string,
): DocCache {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [pagePath]: _omitted, ...rest } = cache.pages;
  return { ...cache, pages: rest };
}

// --- Cache I/O ---

const EMPTY_CACHE: DocCache = { version: 3, pages: {} };

/**
 * Loads the doc cache from disk. Returns an empty cache if the file
 * does not exist or is malformed.
 */
export function loadDocCache(cachePath: string): DocCache {
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as DocCache;
    // Only the current schema is trusted. A v1/v2 (or unrecognised) manifest
    // is discarded — pre-v3 flags were either written before generation
    // (poisoned) or split across files — so the next run regenerates every
    // page and re-flags it post-success in this one ledger.
    if (parsed.version === 3 && typeof parsed.pages === 'object') {
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
 * Atomic write (temp file + rename): a crash mid-write can otherwise leave a
 * truncated manifest, which {@link loadDocCache} would discard as corrupt,
 * dropping every completion flag and forcing a full regeneration. rename(2)
 * within the same directory is atomic, so a reader ever sees the whole old
 * or whole new file.
 */
export function saveDocCache(cachePath: string, cache: DocCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
    renameSync(tmp, cachePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
    throw err;
  }
}
