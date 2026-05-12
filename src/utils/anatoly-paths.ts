// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from './logger.js';

/**
 * Storage areas under `<project>/.anatoly/`.
 *
 * - `shared/*` — **multi-tenant safe**: provider-public pricing sources,
 *   language-public tree-sitter WASM, product-public GGUF weights. Bind-
 *   mountable on multi-tenant infra. Nothing derived from user code lives here.
 * - `cache/*` — project-local derived artifacts: reviews, refinements, NLP
 *   summaries, RAG vectors, doc-build snapshots. Always lives directly under
 *   `<project>/.anatoly/cache/` because the content is about THIS project's
 *   code. Safe to delete; will be regenerated.
 * - `state/*`, `runs/`, `runtime/`, `setup/` — project-local non-cache state.
 * - `user/*` — reserved for cross-project, single-user configurations
 *   (e.g. user prefs that apply to all of this user's projects). Not used
 *   for code-derived artifacts.
 */
export type AnatolyArea =
  | 'shared/pricing'
  | 'shared/pricing/sources'
  | 'shared/grammars'
  | 'shared/models'
  | 'shared/models/gguf'
  | 'shared/models/hf-cache'
  | 'user'
  | 'cache/reviews'
  | 'cache/refinements'
  | 'cache/nlp-summaries'
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

/**
 * Multi-tenant safe sub-directories under `~/.anatoly/shared/`.
 *
 * Contents are provider/language/product-public: pricing sources from
 * litellm/openrouter, tree-sitter WASM, GGUF model weights. None of these
 * derive from user code — they're safe to share across tenants on a
 * multi-tenant deployment.
 */
const SHARED_SUBDIRS = [
  'pricing',
  join('pricing', 'sources'),
  'grammars',
  'models',
  join('models', 'gguf'),
  join('models', 'hf-cache'),
] as const;

/**
 * Project-only sub-directories created under `<root>/.anatoly/`.
 *
 * The `cache/` subtree holds project-local derived artifacts:
 *   - `cache/reviews/`         — per-file review payloads (content-addressable)
 *   - `cache/refinements/`     — tier3 investigation cache (content-addressable)
 *   - `cache/nlp-summaries/`   — RAG NLP summaries (content-addressable by bodyHash)
 *   - `cache/rag/lancedb/`     — RAG vector store
 *   - `cache/doc-build/`       — doc generation cache
 *   - `cache/pricing.json`     — normalized pricing keyed by project's model set
 * All safe to delete; will be regenerated. Not shared across projects because
 * the content is fundamentally about THIS project's code.
 */
const PROJECT_SUBDIRS = [
  'state',
  join('cache', 'reviews'),
  join('cache', 'refinements'),
  join('cache', 'nlp-summaries'),
  join('cache', 'rag', 'lancedb'),
  join('cache', 'doc-build'),
  'runs',
  'runtime',
  'setup',
] as const;

/**
 * Shared content directories whose contents are cleared by {@link clearShared}.
 * Subset of SHARED_SUBDIRS — only top-level data folders (not structural parents).
 * Project-local caches (reviews/refinements/nlp-summaries) live under cache/
 * and are cleared by `anatoly reset` or `rm -rf .anatoly/cache/`.
 */
const SHARED_CLEARABLE = [
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

  // 5. Migrate legacy state files (pre-Epic-52 layout). Files at `.anatoly/`
  // root that should live under `state/` are moved in place — zero data loss,
  // zero user action required.
  migrateLegacyState(dotAnatoly);

  // 6. Env vars for HF SDK (written, never read by Anatoly)
  hfCachePath_ = anatolyPath(root, 'shared/models/hf-cache');
  process.env.HF_HOME = hfCachePath_;
  process.env.TRANSFORMERS_CACHE = hfCachePath_;
}

/**
 * Move pre-Epic-52 state artifacts from `.anatoly/` root to `.anatoly/state/`.
 *
 * - `.anatoly/calibration.json`        → `.anatoly/state/calibration.json`
 * - `.anatoly/deliberation-memory.json`→ `.anatoly/state/deliberation-memory.json`
 * - `.anatoly/docs/`                   → `.anatoly/state/internal-docs/`
 *   (unless `state/internal-docs/` already has content — then the legacy
 *    copy is removed as stale)
 *
 * Idempotent: if the new location already holds the file (newer version
 * written by current code), the legacy copy is removed without overwrite.
 */
function migrateLegacyState(dotAnatoly: string): void {
  const stateDir = join(dotAnatoly, 'state');

  // Simple file migrations
  for (const filename of ['calibration.json', 'deliberation-memory.json']) {
    const legacyPath = join(dotAnatoly, filename);
    const targetPath = join(stateDir, filename);
    if (!existsSync(legacyPath)) continue;
    try {
      const legacyStat = lstatSync(legacyPath);
      if (!legacyStat.isFile()) continue;
      if (existsSync(targetPath)) {
        // Already migrated — remove the stale legacy copy.
        rmSync(legacyPath, { force: true });
      } else {
        renameSync(legacyPath, targetPath);
      }
    } catch (err) {
      getLogger().warn(
        { err: String(err), file: filename },
        'failed to migrate legacy state file — leaving in place',
      );
    }
  }

  // Directory migrations: legacy dirs at .anatoly/ root → their canonical home.
  const dirMigrations: Array<{ legacy: string; target: string; label: string }> = [
    { legacy: join(dotAnatoly, 'docs'),    target: join(stateDir, 'internal-docs'),         label: 'docs/ → state/internal-docs/' },
    { legacy: join(dotAnatoly, 'rag'),     target: join(dotAnatoly, 'cache', 'rag'),        label: 'rag/ → cache/rag/' },
  ];

  for (const { legacy, target, label } of dirMigrations) {
    if (!existsSync(legacy)) continue;
    try {
      if (!lstatSync(legacy).isDirectory()) continue;
      const targetHasContent = existsSync(target) && readdirSync(target).length > 0;
      if (targetHasContent) {
        // New code already populated the canonical location — legacy is dead.
        rmSync(legacy, { recursive: true, force: true });
      } else {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        renameSync(legacy, target);
      }
    } catch (err) {
      getLogger().warn({ err: String(err), migration: label }, 'failed to migrate legacy directory — leaving in place');
    }
  }
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
 * `~/.anatoly/shared/{pricing,grammars,models}/`. Multi-tenant safe content
 * only — does NOT touch `~/.anatoly/user/` (which holds per-tenant caches
 * derived from user code).
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

