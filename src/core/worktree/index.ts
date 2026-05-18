// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `worktree/` bounded context: git worktree isolation.
 *
 * Published surface (doc 12 §1 rule 1, doc 13 PR 1). Everything outside this
 * context imports this barrel, never a module path inside it. The surface is
 * exactly the symbols current external importers use, no speculative API
 * (doc 13 §8).
 */

export { createWorktreeManager } from './worktree-manager.js';
export { cleanupOrphanedWorktrees } from './worktree-cleanup.js';
export { getEffectiveSourceRoot } from './worktree-path-resolution.js';
