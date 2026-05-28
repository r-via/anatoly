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
import { execSync, execFileSync } from 'node:child_process';

/**
 * Snapshot / restore of `.anatoly/cache/`.
 *
 * The project review cache (and the RAG vectors, refinements, summaries)
 * is the single most expensive artifact Anatoly produces. A 76-file Python
 * project costs ~$20 and ~98 minutes to fully re-evaluate from scratch.
 * A buggy run that overwrites the cache (e.g. the broken first cut of
 * --cache-refresh) silently destroys all of that value.
 *
 * Snapshots live under `.anatoly/cache-snapshots/`. Two storage formats:
 *   - `.tar.gz` file (preferred when `tar` is on PATH) — one file per
 *     snapshot, ~5-10× smaller than a raw mirror on a JSON-heavy cache,
 *     trivial to back up off-disk via a single cp/scp/rsync.
 *   - Directory mirror (fallback when `tar` is unavailable or the tar
 *     invocation fails) — original layout, useful for introspection with
 *     plain fs tools.
 *
 * Both formats hold the same payload: a `cache/` subtree mirroring
 * `.anatoly/cache/` byte-for-byte, plus a `_meta.json` at the root
 * recording when / why / by what command / at which git commit / under
 * which anatoly version the snapshot was taken.
 *
 * Why full copies and never hardlinks: the cache contains files that are
 * rewritten in place (review-index.json on every cache write, LanceDB
 * vector files, the per-file caches under refinements/ and nlp-summaries/).
 * Hardlinks share the inode — a live-cache mutation would mutate the
 * snapshot too, silently defeating the entire safety net. The test
 * "snapshot files are independent of the live cache" is the load-bearing
 * regression guard.
 *
 * Auto-snapshots fire before every destructive operation (`anatoly run
 * --cache-refresh`, `anatoly reset`, and before a restore). Manual
 * snapshots are user-initiated via `anatoly cache snapshot`.
 */

export type SnapshotReason = 'manual' | 'auto-cache-refresh' | 'auto-reset' | 'pre-restore';

export interface SnapshotMeta {
  /** Snapshot identifier (used by all CLI commands). Does NOT include the
   *  `.tar.gz` extension when the snapshot is stored as a tarball — the
   *  on-disk filename adds it. Same name shape for both storage formats
   *  so the user never has to think about which one they got. */
  name: string;
  /** Storage format on disk: 'tar' = `<name>.tar.gz` file,
   *  'dir' = `<name>/` directory. */
  format: 'tar' | 'dir';
  /** ISO 8601 timestamp when the snapshot started. */
  createdAt: string;
  /** Why this snapshot exists. Auto reasons indicate the operation that
   *  triggered it; `pre-restore` is created before a restore overwrites
   *  the current cache, so a botched restore is itself recoverable. */
  reason: SnapshotReason;
  /** The full command that triggered this snapshot, when applicable. */
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
  /** Total size of the snapshot in bytes. For tar.gz this is the
   *  compressed file size on disk; for dir this is the sum of file sizes
   *  in the mirror. */
  sizeBytes: number;
  /** Number of files in the snapshot (informational). */
  fileCount: number;
}

export interface CreateSnapshotInput {
  projectRoot: string;
  reason: SnapshotReason;
  triggerCommand?: string;
  note?: string;
  /** Force a specific storage format. Defaults to 'auto' which picks
   *  'tar' when the `tar` binary is available, 'dir' otherwise. Tests
   *  use 'dir' to keep results deterministic across CI environments. */
  format?: 'auto' | 'tar' | 'dir';
}

const META_FILENAME = '_meta.json';
const CACHE_SUBDIR = 'cache';
const SNAPSHOTS_DIR = 'cache-snapshots';
const TAR_EXT = '.tar.gz';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of `.anatoly/cache/`. Returns the meta on success,
 * null when the cache directory does not exist (nothing to snapshot).
 *
 * Atomicity: the tar.gz path stages files in a hidden `.tmp-<rand>-stage/`,
 * tars to `.tmp-<rand>.tar.gz`, then renames the tarball into place
 * (single atomic operation). The dir path mirrors files into
 * `.tmp-<rand>-<name>/` and renames the directory into place. A crash
 * mid-snapshot leaves an orphaned `.tmp-*` entry that the next `prune`
 * sweeps — never a half-written snapshot under the final name.
 */
export function createSnapshot(input: CreateSnapshotInput): SnapshotMeta | null {
  const cacheDir = anatolyPath(input.projectRoot, 'cache');
  if (!existsSync(cacheDir)) return null;

  const snapshotsDir = anatolyPath(input.projectRoot, SNAPSHOTS_DIR);
  mkdirSync(snapshotsDir, { recursive: true });

  const baseName = `${fsSafeTimestamp(new Date())}_${input.reason}${input.note ? `_${slugify(input.note)}` : ''}`;
  const finalName = uniqueSnapshotName(snapshotsDir, baseName);

  const preferred = input.format ?? 'auto';
  const wantTar = preferred === 'tar' || (preferred === 'auto' && isTarAvailable());

  if (wantTar) {
    const meta = createSnapshotTar(input, snapshotsDir, finalName, cacheDir);
    if (meta) return meta;
    // tar invocation failed (binary missing at exec time, permission,
    // disk full mid-stream) → fall back to dir so the user still gets a
    // snapshot. Log via stderr; we have no logger here without coupling
    // to the orchestration runtime.
    process.stderr.write(`anatoly cache snapshot: tar failed, falling back to directory mirror\n`);
  }
  return createSnapshotDir(input, snapshotsDir, finalName, cacheDir);
}

/**
 * List all snapshots, newest first. Silently skips entries that lack a
 * readable `_meta.json` (orphaned tmp dirs / tarballs from a crashed
 * snapshot, or stray entries the user dropped in there).
 */
export function listSnapshots(projectRoot: string): SnapshotMeta[] {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  if (!existsSync(snapshotsDir)) return [];

  const out: SnapshotMeta[] = [];
  for (const entry of readdirSync(snapshotsDir)) {
    if (entry.startsWith('.tmp-') || entry.startsWith('.tmp.')) continue;
    const full = join(snapshotsDir, entry);
    const meta = readSnapshotMeta(full);
    if (meta) out.push(meta);
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
  const found = resolveSnapshotPath(projectRoot, name);
  if (!found) {
    throw new Error(`Snapshot "${name}" not found`);
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

  let fileCount: number;
  if (found.format === 'tar') {
    fileCount = extractTarCacheInto(found.path, liveCacheDir);
  } else {
    const sourceCacheDir = join(found.path, CACHE_SUBDIR);
    fileCount = mirrorTree(sourceCacheDir, liveCacheDir).fileCount;
  }
  return { restored: fileCount, preRestoreSnapshot: preRestore };
}

/**
 * Delete a single snapshot by name. Returns true if it existed and was
 * deleted, false if the name was unknown.
 */
export function deleteSnapshot(projectRoot: string, name: string): boolean {
  const found = resolveSnapshotPath(projectRoot, name);
  if (!found) return false;
  rmSync(found.path, { recursive: true, force: true });
  return true;
}

/**
 * Prune snapshots down to the most recent `keep`. Returns the names that
 * were removed (oldest first). Also sweeps any orphaned `.tmp-*` entries
 * left behind by a crashed snapshot.
 *
 * Retention is FIFO across all snapshots regardless of reason — manual
 * snapshots are not protected. Users who want to preserve a specific
 * snapshot can move it elsewhere or rename it (we identify snapshots by
 * name, so renaming is supported as long as no collision exists).
 */
export function pruneSnapshots(projectRoot: string, keep: number): { kept: number; pruned: string[] } {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  if (!existsSync(snapshotsDir)) return { kept: 0, pruned: [] };

  // Sweep stale tmp entries first (these have no meta, never count toward retention).
  for (const entry of readdirSync(snapshotsDir)) {
    if (entry.startsWith('.tmp-') || entry.startsWith('.tmp.')) {
      try { rmSync(join(snapshotsDir, entry), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  const all = listSnapshots(projectRoot);
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
 * keep count (5) matches the validated scope; callers can override later.
 */
export function snapshotAndPrune(input: CreateSnapshotInput, keep = 5): SnapshotMeta | null {
  const meta = createSnapshot(input);
  if (meta) pruneSnapshots(input.projectRoot, keep);
  return meta;
}

// ---------------------------------------------------------------------------
// tar.gz path
// ---------------------------------------------------------------------------

function createSnapshotTar(
  input: CreateSnapshotInput,
  snapshotsDir: string,
  finalName: string,
  cacheDir: string,
): SnapshotMeta | null {
  const stageDir = join(snapshotsDir, `.tmp-stage-${randomToken()}-${finalName}`);
  const tmpTar = join(snapshotsDir, `.tmp-${randomToken()}-${finalName}${TAR_EXT}`);
  const finalPath = join(snapshotsDir, `${finalName}${TAR_EXT}`);

  try {
    mkdirSync(join(stageDir, CACHE_SUBDIR), { recursive: true });
    const { sizeBytes: rawSize, fileCount } = mirrorTree(cacheDir, join(stageDir, CACHE_SUBDIR));

    const meta: SnapshotMeta = {
      name: finalName,
      format: 'tar',
      createdAt: new Date().toISOString(),
      reason: input.reason,
      triggerCommand: input.triggerCommand,
      gitCommit: tryGitHead(input.projectRoot),
      anatolyVersion: pkgVersion,
      note: input.note,
      sizeBytes: rawSize, // overridden below to the compressed on-disk size
      fileCount,
    };
    writeFileSync(join(stageDir, META_FILENAME), JSON.stringify(meta, null, 2));

    execFileSync(
      'tar',
      ['-czf', tmpTar, '-C', stageDir, CACHE_SUBDIR, META_FILENAME],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    // sizeBytes on the final meta is the COMPRESSED size; users care about
    // disk footprint, not the pre-compression mirror size. Re-write the
    // meta on the next snapshot cycle if needed; for now we surface the
    // file size at list time, which is the source of truth anyway.
    const compressedSize = statSync(tmpTar).size;
    meta.sizeBytes = compressedSize;
    // Re-stamp meta inside the tar so list-from-tarball sees the right size.
    // Cheapest path: rebuild the tar with the updated meta. For small
    // savings we accept the redundant work — meta is ~1 KB.
    writeFileSync(join(stageDir, META_FILENAME), JSON.stringify(meta, null, 2));
    rmSync(tmpTar, { force: true });
    execFileSync(
      'tar',
      ['-czf', tmpTar, '-C', stageDir, CACHE_SUBDIR, META_FILENAME],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    meta.sizeBytes = statSync(tmpTar).size;

    renameSync(tmpTar, finalPath);
    return meta;
  } catch {
    // Cleanup any partial artifacts and let the caller fall back.
    try { rmSync(tmpTar, { force: true }); } catch { /* best-effort */ }
    return null;
  } finally {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function extractTarCacheInto(tarPath: string, destCacheDir: string): number {
  // Extract directly into the live cache parent: tar will recreate the
  // `cache/` subtree and the `_meta.json` next to it. We then move
  // `cache/*` up into destCacheDir and drop the leftovers.
  const parent = dirname(destCacheDir);
  const stagingDir = join(parent, `.tmp-extract-${randomToken()}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', stagingDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    const extractedCache = join(stagingDir, CACHE_SUBDIR);
    if (!existsSync(extractedCache)) return 0;
    const { fileCount } = mirrorTree(extractedCache, destCacheDir);
    return fileCount;
  } finally {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// directory path (fallback when tar is unavailable)
// ---------------------------------------------------------------------------

function createSnapshotDir(
  input: CreateSnapshotInput,
  snapshotsDir: string,
  finalName: string,
  cacheDir: string,
): SnapshotMeta {
  const tmpName = `.tmp-${randomToken()}-${finalName}`;
  const tmpPath = join(snapshotsDir, tmpName);
  const finalPath = join(snapshotsDir, finalName);

  mkdirSync(join(tmpPath, CACHE_SUBDIR), { recursive: true });
  const { sizeBytes, fileCount } = mirrorTree(cacheDir, join(tmpPath, CACHE_SUBDIR));

  const meta: SnapshotMeta = {
    name: finalName,
    format: 'dir',
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

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/**
 * Locate a snapshot on disk by name. Tries tar (`<name>.tar.gz`) first
 * because tar is the default storage format; falls back to dir (`<name>/`)
 * for snapshots that were created on a tar-less environment or for
 * manually-extracted snapshots the user kept around. Returns null on no
 * match.
 */
function resolveSnapshotPath(projectRoot: string, name: string): { path: string; format: 'tar' | 'dir' } | null {
  const snapshotsDir = anatolyPath(projectRoot, SNAPSHOTS_DIR);
  const tarPath = join(snapshotsDir, `${name}${TAR_EXT}`);
  if (existsSync(tarPath)) return { path: tarPath, format: 'tar' };
  const dirPath = join(snapshotsDir, name);
  if (existsSync(dirPath)) return { path: dirPath, format: 'dir' };
  return null;
}

/**
 * Read the `_meta.json` of a snapshot regardless of storage format.
 * Returns null on malformed / missing meta — listing skips silently.
 */
function readSnapshotMeta(path: string): SnapshotMeta | null {
  try {
    const stat = statSync(path);
    if (stat.isFile() && path.endsWith(TAR_EXT)) {
      // `tar -xzOf` streams a single member to stdout; we capture it
      // without ever touching disk. No staging directory needed.
      const raw = execFileSync('tar', ['-xzOf', path, META_FILENAME], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(raw) as SnapshotMeta;
    }
    if (stat.isDirectory()) {
      const metaPath = join(path, META_FILENAME);
      if (!existsSync(metaPath)) return null;
      return JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
    }
    return null;
  } catch {
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// Environment probes + small helpers
// ---------------------------------------------------------------------------

let _tarAvailable: boolean | undefined;

/**
 * Returns true when a usable `tar` binary is on PATH. Cached after the
 * first probe so the check costs nothing on subsequent snapshots within
 * the same process.
 */
function isTarAvailable(): boolean {
  if (_tarAvailable !== undefined) return _tarAvailable;
  try {
    execFileSync('tar', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _tarAvailable = true;
  } catch {
    _tarAvailable = false;
  }
  return _tarAvailable;
}

/** Test-only hook: reset the cached tar probe so tests can force re-probe. */
export function _resetTarProbeForTests(): void {
  _tarAvailable = undefined;
}

function fsSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Resolve a unique name in `snapshotsDir`. A name is "taken" iff either a
 * `<name>.tar.gz` file or a `<name>/` directory already exists. Collisions
 * are resolved with `_2`, `_3`, ... up to 1000 before falling back to a
 * random suffix.
 */
function uniqueSnapshotName(snapshotsDir: string, base: string): string {
  if (!nameTaken(snapshotsDir, base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!nameTaken(snapshotsDir, candidate)) return candidate;
  }
  return `${base}_${randomToken()}`;
}

function nameTaken(snapshotsDir: string, name: string): boolean {
  return existsSync(join(snapshotsDir, name)) || existsSync(join(snapshotsDir, `${name}${TAR_EXT}`));
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
