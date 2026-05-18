// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Worktree Path Resolution — Story 47.2
 *
 * When a review runs against a git worktree snapshot, source files must be
 * read from the worktree (`sourceRoot`) while outputs (reviews, logs, cache)
 * are written to the original project directory (`projectRoot` / `outputRoot`).
 *
 * In normal (foreground) mode, sourceRoot === projectRoot.
 */

import { resolve } from 'node:path';

interface PathContext {
  /** Absolute path to the original project directory (used for outputs). */
  projectRoot: string;
  /** Absolute path to the source tree (worktree or same as projectRoot). */
  sourceRoot?: string;
  /** Relative file path (from project root). */
  relativePath: string;
}

/**
 * Resolve a source file path — reads from `sourceRoot` when available,
 * otherwise falls back to `projectRoot`.
 */
export function resolveSourcePath(ctx: PathContext): string {
  const root = ctx.sourceRoot ?? ctx.projectRoot;
  return resolve(root, ctx.relativePath);
}

/**
 * Resolve an output file path — always uses `projectRoot` regardless of
 * whether a worktree is active.
 */
export function resolveOutputPath(ctx: PathContext): string {
  return resolve(ctx.projectRoot, ctx.relativePath);
}

/**
 * Return the effective source root: `sourceRoot` if defined, otherwise `projectRoot`.
 */
export function getEffectiveSourceRoot(projectRoot: string, sourceRoot: string | undefined): string {
  return sourceRoot ?? projectRoot;
}
