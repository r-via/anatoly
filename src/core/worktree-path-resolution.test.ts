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
  describe('resolveSourcePath', () => {
    it('should return sourceRoot + relative when sourceRoot is provided', async () => {
      const { resolveSourcePath } = await import('./worktree-path-resolution.js');
      const result = resolveSourcePath({
        projectRoot: '/home/user/project',
        sourceRoot: '/home/user/project/.anatoly/worktrees/run-123',
        relativePath: 'src/index.ts',
      });
      expect(result).toBe('/home/user/project/.anatoly/worktrees/run-123/src/index.ts');
    });

    it('should return projectRoot + relative when sourceRoot is undefined', async () => {
      const { resolveSourcePath } = await import('./worktree-path-resolution.js');
      const result = resolveSourcePath({
        projectRoot: '/home/user/project',
        relativePath: 'src/index.ts',
      });
      expect(result).toBe('/home/user/project/src/index.ts');
    });
  });

  describe('resolveOutputPath', () => {
    it('should always use projectRoot for output paths', async () => {
      const { resolveOutputPath } = await import('./worktree-path-resolution.js');
      const result = resolveOutputPath({
        projectRoot: '/home/user/project',
        sourceRoot: '/home/user/project/.anatoly/worktrees/run-123',
        relativePath: '.anatoly/runs/run-123/reviews/foo.rev.json',
      });
      expect(result).toBe('/home/user/project/.anatoly/runs/run-123/reviews/foo.rev.json');
    });

    it('should use projectRoot when sourceRoot is undefined', async () => {
      const { resolveOutputPath } = await import('./worktree-path-resolution.js');
      const result = resolveOutputPath({
        projectRoot: '/home/user/project',
        relativePath: '.anatoly/runs/run-123/reviews/foo.rev.json',
      });
      expect(result).toBe('/home/user/project/.anatoly/runs/run-123/reviews/foo.rev.json');
    });
  });

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
