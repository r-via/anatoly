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

/**
 * Return the effective source root: `sourceRoot` if defined, otherwise `projectRoot`.
 */
export function getEffectiveSourceRoot(projectRoot: string, sourceRoot: string | undefined): string {
  return sourceRoot ?? projectRoot;
}
