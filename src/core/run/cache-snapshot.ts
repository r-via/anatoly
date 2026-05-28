// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import {
  existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync,
  copyFileSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { pkgVersion } from '../../utils/version.js';
import { execSync } from 'node:child_process';

/**
 * Snapshot / restore of `.anatoly/cache/`.
 *
 * The project review cache (and the RAG vectors, refinements, summaries)
 * is the single most expensive artifact Anatoly produces. A 76-file Python
 * project costs ~$20 and ~98 minutes to fully re-evaluate from scratch.
 * A buggy run that overwrites the cache (e.g. the broken first cut of
 * --cache-refresh) silently destroys all of that value.
 *
 * Snapshots are full mirrors of `.anatoly/cache/` written to
 * `.anatoly/cache-snapshots/<timestamp>_<reason>[_<noteSlug>]/`, with a
 * `_meta.json` recording when / why / by what command / at which git
 * commit / under which anatoly version. Auto-snapshots fire before every
 * destructive operation (`anatoly run --cache-refresh`, `anatoly reset`,
 * and before a restore). Manual snapshots are user-initiated via
 * `anatoly cache snapshot`.
 *
 * Storage strategy: full file copies. An earlier draft used hardlinks to
 * save space (~22 MB → ~few KB of directory entries), but the cache
 * contains files that are rewritten in place (review-index.json on every
 * cache write, LanceDB vector files, the per-file caches under
 * refinements/ and nlp-summaries/). Hardlinks share the inode — a live-
 * cache mutation would mutate the snapshot too, defeating the whole
 * point of the snapshot as a frozen-in-time recovery target. Full copies
 * keep snapshot bytes independent. For very large caches a future
 * follow-up could hardlink only the truly content-addressed files
 * (cache/reviews/<sha>.rev.json), but the correctness floor is copy.
 */

export type SnapshotReason = 'manual' | 'auto-cache-refresh' | 'auto-reset' | 'pre-restore';

export interface SnapshotMeta {
  /** Snapshot directory name (used as the identifier in CLI commands). */
  name: string;
  /** ISO 8601 timestamp when the snapshot started. */
  createdAt: string;
  /** Why this snapshot exists. Auto reasons indicate the operation that
   *  triggered it; `pre-restore` is created before a restore overwrites
   *  the current cache, so a botched restore is itself recoverable. */
  reason: SnapshotReason;
  /** The full command that triggered this snapshot, when applicable.
   *  Useful for reading `anatoly cache list` and remembering "ah right,
   *  that snapshot is from when I ran `--cache-refresh --axes utility`". */
  triggerCommand?: string;
  /** Current git HEAD commit at snapshot time. Empty when not in a git
   *  repo or when git is unavailable. */
  gitCommit?: string;
  /** Anatoly version that took the snapshot. A restore under a different
   *  version is allowed but the user should know — prompt-hash drift is
   *  the same concern as `cache reseed`. */
  anatolyVersion: string;
  /** Optional free-text note (from `--note` on `cache snapshot`). */
  note?: string;
  /** Total size of the snapshot in bytes (informational). */
  sizeBytes: number;
  /** Number of files in the snapshot (informational). */
  fileCount: number;
}

export interface CreateSnapshotInput {
  projectRoot: string;
  reason: SnapshotReason;
  triggerCommand?: string;
  note?: string;
}

const META_FILENAME = '_meta.json';
const CACHE_SUBDIR = 'cache';
const SNAPSHOTS_DIR = 'cache-snapshots';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of `.anatoly/cache/`. Returns the meta on success,
 * null when the cache directory does not exist (nothing to snapshot).
 *
 * The snapshot directory name is `<isoTimestamp>_<reason>[_<noteSlug>]`,
 * with a `_N` suffix added on collision so two snapshots taken in the
 * same second do not clobber each other.
 *
 * Writes are atomic: we build the snapshot in a hidden `.tmp-<rand>/`
 * directory and rename to the final name only after everything is in
 * place. A crash mid-snapshot leaves a `.tmp-*` directory that the next
 * `prune` will sweep, never a half-written final snapshot.
 */
export function createSnapshot(input: CreateSnapshotInput): SnapshotMeta | null {
  const cacheDir = anatolyPath(input.projectRoot, 'cache');
  if (!existsSync(cacheDir)) return null;

  const snapshotsDir = anatolyPath(input.projectRoot, SNAPSHOTS_DIR);
  mkdirSync(snapshotsDir, { recursive: true });

  const baseName = `${fsSafeTimestamp(new Date())}_${input.reason}${input.note ? `_${slugify(input.note)}` : ''}`;
  const finalName = uniqueDirName(snapshotsDir, baseName);
  const tmpName = `.tmp-${Math.random().toString(36).slice(2, 10)}-${finalName}`;
  const tmpPath = join(snapshotsDir, tmpName);
  const finalPath = join(snapshotsDir, finalName);

  mkdirSync(join(tmpPath, CACHE_SUBDIR), { recursive: true });

  const { sizeBytes, fileCount } = mirrorTree(cacheDir, join(tmpPath, CACHE_SUBDIR));

  const meta: SnapshotMeta = {
    name: finalName,
    createdAt: new Date().toISOString(),
    reason: input.reason,
    triggerCommand: input.triggerCommand,
    gitCommit: tryGitHead(input.projectRoot),
    anatolyVersion: pkgVersion,
    note: input.note,
    sizeBytes,
    fileCount,
  };
  writeFileSync(join(tmpPath, META_FILENAME), JSON.stringify(meta, null, 2));

  renameSync(tmpPath, finalPath);
  return meta;
}

/**
 * List all snapshots, newest first. Silently skips entries that lack a
 * readable `_meta.json` (orphaned tmp dirs from a crashed snapshot, or
 * stray directories the user dropped in there).
 */
export function listSnapshots(projectRoot: string): SnapshotMeta[] {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  if (!existsSync(snapshotsDir)) return [];

  const out: SnapshotMeta[] = [];
  for (const entry of readdirSync(snapshotsDir)) {
    if (entry.startsWith('.tmp-')) continue;
    const metaPath = join(snapshotsDir, entry, META_FILENAME);
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
      out.push(meta);
    } catch {
      // Malformed meta: skip rather than crashing the listing.
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Restore a named snapshot over `.anatoly/cache/`. Takes a `pre-restore`
 * auto-snapshot of the current cache before overwriting, so a botched
 * restore is itself recoverable. Returns the count of files restored.
 *
 * Throws when the named snapshot does not exist; the caller (CLI) is
 * responsible for the user-facing error message.
 */
export function restoreSnapshot(projectRoot: string, name: string): { restored: number; preRestoreSnapshot: SnapshotMeta | null } {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  const sourcePath = join(snapshotsDir, name, CACHE_SUBDIR);
  if (!existsSync(sourcePath)) {
    throw new Error(`Snapshot "${name}" not found or missing cache/ subdirectory`);
  }

  // Pre-restore safety snapshot of the live cache (so a wrong choice of
  // snapshot name is recoverable in turn).
  const preRestore = createSnapshot({
    projectRoot,
    reason: 'pre-restore',
    note: `before-restore-of-${name}`,
  });

  const liveCacheDir = anatolyPath(projectRoot, 'cache');
  if (existsSync(liveCacheDir)) rmSync(liveCacheDir, { recursive: true, force: true });
  mkdirSync(liveCacheDir, { recursive: true });

  const { fileCount } = mirrorTree(sourcePath, liveCacheDir);
  return { restored: fileCount, preRestoreSnapshot: preRestore };
}

/**
 * Delete a single snapshot by name. Returns true if it existed and was
 * deleted, false if the name was unknown. Used by `cache prune --name`
 * and by retention cleanup.
 */
export function deleteSnapshot(projectRoot: string, name: string): boolean {
  const path = join(anatolyPath(projectRoot, SNAPSHOTS_DIR), name);
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Prune snapshots down to the most recent `keep`. Returns the names that
 * were removed (oldest first). Also sweeps any orphaned `.tmp-*` dirs
 * left behind by a crashed snapshot.
 *
 * Retention is FIFO across all snapshots regardless of reason — manual
 * snapshots are not protected. Users who want to preserve a specific
 * snapshot can copy it elsewhere or rename it (we identify snapshots by
 * directory name, so renaming is supported as long as the rename does
 * not collide with another snapshot).
 */
export function pruneSnapshots(projectRoot: string, keep: number): { kept: number; pruned: string[] } {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  if (!existsSync(snapshotsDir)) return { kept: 0, pruned: [] };

  // Sweep stale tmp dirs first (these have no meta, never count toward retention).
  for (const entry of readdirSync(snapshotsDir)) {
    if (entry.startsWith('.tmp-')) {
      try { rmSync(join(snapshotsDir, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  const all = listSnapshots(projectRoot); // already newest-first
  if (all.length <= keep) return { kept: all.length, pruned: [] };

  const toPrune = all.slice(keep);
  const pruned: string[] = [];
  for (const meta of toPrune) {
    if (deleteSnapshot(projectRoot, meta.name)) pruned.push(meta.name);
  }
  return { kept: keep, pruned };
}

/**
 * Convenience: snapshot + prune in one call, the pattern used by the
 * auto-snapshot hooks before `--cache-refresh` and `reset`. The default
 * keep count (5) matches the validated scope; callers can override per
 * config later.
 */
export function snapshotAndPrune(input: CreateSnapshotInput, keep = 5): SnapshotMeta | null {
  const meta = createSnapshot(input);
  if (meta) pruneSnapshots(input.projectRoot, keep);
  return meta;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Recursively copy `src` into `dest`. Per-file copy errors (e.g. source
 * vanished mid-snapshot) are tolerated: the file is skipped, the snapshot
 * keeps going. Best-effort is the right tradeoff for a safety net.
 */
function mirrorTree(src: string, dest: string): { sizeBytes: number; fileCount: number } {
  let sizeBytes = 0;
  let fileCount = 0;
  const stack: string[] = [src];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const srcPath = join(dir, entry.name);
      const rel = relative(src, srcPath);
      const destPath = join(dest, rel);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        stack.push(srcPath);
      } else if (entry.isFile()) {
        mkdirSync(dirname(destPath), { recursive: true });
        try {
          copyFileSync(srcPath, destPath);
          sizeBytes += statSync(srcPath).size;
          fileCount += 1;
        } catch { /* skip — non-fatal */ }
      }
      // symlinks / sockets / etc. intentionally skipped; the cache only
      // contains regular files in practice.
    }
  }
  return { sizeBytes, fileCount };
}

function fsSafeTimestamp(date: Date): string {
  // ISO without colons (Windows-safe) and with a Z suffix to mark UTC.
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function uniqueDirName(parent: string, base: string): string {
  if (!existsSync(join(parent, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existsSync(join(parent, candidate))) return candidate;
  }
  // Pathological: 1000 collisions in the same second. Bail with a random.
  return `${base}_${Math.random().toString(36).slice(2, 8)}`;
}

function tryGitHead(projectRoot: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: resolve(projectRoot),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}
