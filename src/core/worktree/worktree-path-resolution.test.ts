// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 47.2 — Worktree path resolution tests
 *
 * Validates that sourceRoot/outputRoot separation works correctly:
 * - Source files are read from sourceRoot (worktree)
 * - Outputs are written to outputRoot (original project)
 * - Normal runs default sourceRoot === projectRoot
 */

import { describe, it, expect } from 'vitest';

describe('worktree path resolution', () => {
  describe('getEffectiveSourceRoot', () => {
    it('should return sourceRoot when provided', async () => {
      const { getEffectiveSourceRoot } = await import('./worktree-path-resolution.js');
      expect(getEffectiveSourceRoot('/project', '/worktree')).toBe('/worktree');
    });

    it('should return projectRoot when sourceRoot is undefined', async () => {
      const { getEffectiveSourceRoot } = await import('./worktree-path-resolution.js');
      expect(getEffectiveSourceRoot('/project', undefined)).toBe('/project');
    });
  });
});
