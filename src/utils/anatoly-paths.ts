// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from './logger.js';

/**
 * All known sub-folders under `<root>/.anatoly/`.
 */
export type AnatolyArea =
  | 'shared/reviews'
  | 'shared/refinements'
  | 'shared/nlp-summaries'
  | 'shared/pricing'
  | 'shared/pricing/sources'
  | 'shared/grammars'
  | 'shared/models'
  | 'shared/models/gguf'
  | 'shared/models/hf-cache'
  | 'user'
  | 'state'
  | 'state/internal-docs'
  | 'cache'
  | 'cache/rag'
  | 'cache/rag/lancedb'
  | 'cache/doc-build'
  | 'runs'
  | 'runtime'
  | 'setup'
  | 'baseline';

/**
 * Resolve a path under `<root>/.anatoly/<area>/[...rest]`.
 */
export function anatolyPath(root: string, area: AnatolyArea, ...rest: string[]): string {
  return join(root, '.anatoly', ...area.split('/'), ...rest);
}

/**
 * Resolve a path under `<root>/.anatoly/runs/<runId>/[...rest]`.
 */
export function runPath(root: string, runId: string, ...rest: string[]): string {
  return join(root, '.anatoly', 'runs', runId, ...rest);
}

/** Resolve the user-wide anatoly root (`~/.anatoly/`). */
function userWideRoot(): string {
  return join(process.env.HOME ?? homedir(), '.anatoly');
}

/**
 * Should `~/.anatoly/shared/models/gguf` be a symlink to `~/.anatoly/models/`?
 *
 * Yes when:
 *   - `~/.anatoly/models/` exists with at least one `.gguf` file (canonical
 *     model home, populated by `anatoly local-embeddings install` or manual
 *     downloads), AND
 *   - `target` (the shared/models/gguf path) is not already a real directory
 *     with content (would be lost by replacing with a symlink).
 *
 * The empty-or-missing target case is the common path: bootstrap creates the
 * symlink before any model is downloaded into the shared tree.
 */
function shouldLinkLegacyModels(uwRoot: string, target: string): boolean {
  const canonical = join(uwRoot, 'models');
  if (!existsSync(canonical)) return false;

  try {
    const ggufFiles = readdirSync(canonical).filter((f) => f.endsWith('.gguf'));
    if (ggufFiles.length === 0) return false;
  } catch {
    return false;
  }

  // If target already exists, only replace it when it's empty or a stale symlink.
  if (existsSync(target) || symlinkExists(target)) {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) return true; // existing symlink → safe to recreate
      if (stat.isDirectory()) {
        const entries = readdirSync(target);
        return entries.length === 0;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Shared sub-directories that must exist under `~/.anatoly/shared/`. */
const SHARED_SUBDIRS = [
  'reviews',
  'refinements',
  'nlp-summaries',
  'pricing',
  join('pricing', 'sources'),
  'grammars',
  'models',
  join('models', 'gguf'),
  join('models', 'hf-cache'),
] as const;

/** Project-only sub-directories created under `<root>/.anatoly/`. */
const PROJECT_SUBDIRS = [
  'state',
  join('cache', 'rag', 'lancedb'),
  join('cache', 'doc-build'),
  'runs',
  'runtime',
  'setup',
] as const;

/**
 * Shared content directories whose contents are cleared by {@link clearShared}.
 * Subset of SHARED_SUBDIRS — only top-level data folders (not structural parents).
 */
const SHARED_CLEARABLE = [
  'reviews',
  'refinements',
  'nlp-summaries',
  'pricing',
  'grammars',
  'models',
] as const;

/** Cached HF cache path, set by bootstrapAnatoly. */
let hfCachePath_: string | null = null;

/**
 * Return the HF cache directory set during bootstrap.
 * Falls back to computing it from `~/.anatoly/shared/models/hf-cache`.
 */
export function getHfCachePath(): string {
  return hfCachePath_ ?? join(userWideRoot(), 'shared', 'models', 'hf-cache');
}

/**
 * Idempotent bootstrap of the `.anatoly/` layout for a project root.
 *
 * 1. Creates `<root>/.anatoly/` (0700).
 * 2. Creates `~/.anatoly/{shared,user}/` (0700) with shared subdirs.
 * 3. Creates symlinks `<root>/.anatoly/shared` → `~/.anatoly/shared/`
 *    and `<root>/.anatoly/user` → `~/.anatoly/user/` unless they already
 *    exist as real directories (isolated mode) or mount-points.
 * 4. Creates project-only subdirs (state/, cache/, runs/, runtime/, setup/).
 * 5. Sets `HF_HOME` and `TRANSFORMERS_CACHE` env vars for the HF SDK.
 */
export function bootstrapAnatoly(root: string): void {
  const dotAnatoly = join(root, '.anatoly');
  const uwRoot = userWideRoot();

  // 1. Project-level root
  mkdirSync(dotAnatoly, { recursive: true, mode: 0o700 });

  // 2. User-wide roots + shared subdirs
  mkdirSync(join(uwRoot, 'shared'), { recursive: true, mode: 0o700 });
  mkdirSync(join(uwRoot, 'user'), { recursive: true, mode: 0o700 });

  for (const sub of SHARED_SUBDIRS) {
    const target = join(uwRoot, 'shared', sub);
    // Special case: `models/gguf` symlinks to `~/.anatoly/models/` when that
    // legacy location exists with GGUF files. Models stay at their canonical
    // home; shared/ exposes them via symlink so anatolyPath resolution still
    // works without forcing the user to mv 10+ GB of weights.
    if (sub === join('models', 'gguf') && shouldLinkLegacyModels(uwRoot, target)) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      try {
        symlinkSync(join(uwRoot, 'models'), target, 'dir');
        continue;
      } catch (err) {
        getLogger().warn(
          { err: String(err) },
          'failed to symlink shared/models/gguf to ~/.anatoly/models — falling back to mkdir',
        );
      }
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  // 3. Symlinks (or respect existing real dirs / mount-points)
  ensureLink(dotAnatoly, 'shared', join(uwRoot, 'shared'));
  ensureLink(dotAnatoly, 'user', join(uwRoot, 'user'));

  // 4. Project-only subdirs
  for (const sub of PROJECT_SUBDIRS) {
    mkdirSync(join(dotAnatoly, sub), { recursive: true, mode: 0o700 });
  }

  // 5. Env vars for HF SDK (written, never read by Anatoly)
  hfCachePath_ = anatolyPath(root, 'shared/models/hf-cache');
  process.env.HF_HOME = hfCachePath_;
  process.env.TRANSFORMERS_CACHE = hfCachePath_;
}

/**
 * Ensure `<parent>/<name>` is a symlink to `target`, unless it already exists
 * as a real directory (isolated mode) or mount-point.
 */
function ensureLink(parent: string, name: string, target: string): void {
  const linkPath = join(parent, name);

  if (existsSync(linkPath) || symlinkExists(linkPath)) {
    try {
      const stat = lstatSync(linkPath);

      // Already a symlink — nothing to do
      if (stat.isSymbolicLink()) return;

      // Real directory — could be isolated mode or mount-point
      if (stat.isDirectory()) {
        if (isMountPoint(linkPath)) {
          getLogger().info(`${name}/ is a mount-point — respecting`);
        } else {
          getLogger().info(
            `${name}/ is a real directory (isolated mode), not a symlink — respecting`,
          );
        }
        return;
      }
    } catch {
      // stat failed — remove stale entry and recreate
    }
  }

  try {
    symlinkSync(target, linkPath, 'dir');
  } catch (err: unknown) {
    // Windows without Developer Mode → EPERM
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      getLogger().warn(
        'Could not create symlink on Windows (Developer Mode required) — using local directory. Cross-project sharing disabled.',
      );
      mkdirSync(linkPath, { recursive: true, mode: 0o700 });
    } else {
      throw err;
    }
  }
}

/** Check if a path exists as a symlink (lstat doesn't throw). */
function symlinkExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if a path is a mount-point by comparing device IDs
 * between the path and its parent.
 */
function isMountPoint(p: string): boolean {
  try {
    const parentDev = lstatSync(join(p, '..')).dev;
    const targetDev = lstatSync(p).dev;
    return parentDev !== targetDev;
  } catch {
    return false;
  }
}

/**
 * Clear the project-local cache: removes all contents under `<root>/.anatoly/cache/`.
 * Does NOT touch state/, runs/, or shared/.
 */
export function clearCache(root: string): void {
  const cacheDir = anatolyPath(root, 'cache');
  if (!existsSync(cacheDir)) return;

  // Remove contents, not the dir itself
  for (const entry of readdirSync(cacheDir)) {
    rmSync(join(cacheDir, entry), { recursive: true, force: true });
  }
}

/**
 * Clear the user-wide shared cache: removes all contents under
 * `~/.anatoly/shared/{reviews,refinements,nlp-summaries,pricing,grammars,models}/`.
 * Does NOT touch `~/.anatoly/user/`.
 */
export function clearShared(): void {
  const sharedDir = join(userWideRoot(), 'shared');
  if (!existsSync(sharedDir)) return;

  getLogger().warn(
    'clearing user-wide shared cache — affects all projects sharing ~/.anatoly/',
  );

  for (const sub of SHARED_CLEARABLE) {
    const subDir = join(sharedDir, sub);
    if (!existsSync(subDir)) continue;
    for (const entry of readdirSync(subDir)) {
      rmSync(join(subDir, entry), { recursive: true, force: true });
    }
  }
}
