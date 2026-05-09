// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Isolated mode integration test.
 *
 * Verifies that replacing the shared/ symlink with a real directory triggers
 * "isolated mode" and that caches are written locally, not to ~/.anatoly/shared/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';
import {
  writeSharedReview,
  loadSharedReview,
} from '../core/shared-review-cache.js';
import type { ReviewFile } from '../schemas/review.js';

function makeReview(file: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict: 'CLEAN',
  } as unknown as ReviewFile;
}

describe('isolated mode integration (Story 52.7)', () => {
  let base: string;
  let projIso: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-iso-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME!;
    process.env.HOME = fakeHome;

    projIso = join(base, 'proj-iso');
    mkdirSync(projIso, { recursive: true });

    // Bootstrap normally — creates symlinks
    bootstrapAnatoly(projIso);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('after replacing symlink with real dir, bootstrap respects it (no re-creation)', () => {
    // Verify initial state: shared/ is a symlink
    const sharedPath = join(projIso, '.anatoly', 'shared');
    expect(lstatSync(sharedPath).isSymbolicLink()).toBe(true);

    // Replace symlink with real directory
    rmSync(sharedPath, { recursive: true, force: true });
    mkdirSync(sharedPath, { recursive: true });

    // Re-bootstrap
    bootstrapAnatoly(projIso);

    // shared/ should still be a real directory (not a symlink)
    const stat = lstatSync(sharedPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });

  it('cache written in isolated mode goes to project-local dir, not ~/.anatoly/shared/', () => {
    const sharedPath = join(projIso, '.anatoly', 'shared');

    // Replace symlink with real directory (isolated mode)
    rmSync(sharedPath, { recursive: true, force: true });
    mkdirSync(join(sharedPath, 'reviews'), { recursive: true });

    // Re-bootstrap to confirm isolated mode
    bootstrapAnatoly(projIso);

    // Write a review — should go to project-local shared/reviews/
    const content = 'export const isolated = true;\n';
    const review = makeReview('src/isolated.ts');
    writeSharedReview(projIso, review, content, 'sha256:p', 'model', ['correction']);

    // Verify: file exists under project-local shared/reviews/
    const localReviewsDir = join(projIso, '.anatoly', 'shared', 'reviews');
    const localEntries = readdirSync(localReviewsDir, { recursive: true });
    expect(localEntries.length).toBeGreaterThan(0);

    // Verify: ~/.anatoly/shared/reviews/ does NOT contain this review
    const globalReviewsDir = join(fakeHome, '.anatoly', 'shared', 'reviews');
    if (existsSync(globalReviewsDir)) {
      const globalEntries = readdirSync(globalReviewsDir, { recursive: true });
      // Global should be empty since we broke the symlink
      expect(globalEntries.length).toBe(0);
    }
  });

  it('review from isolated project is loadable from the same project', () => {
    const sharedPath = join(projIso, '.anatoly', 'shared');

    // Replace symlink with real directory
    rmSync(sharedPath, { recursive: true, force: true });
    mkdirSync(join(sharedPath, 'reviews'), { recursive: true });
    bootstrapAnatoly(projIso);

    const content = 'const isolated = 1;\n';
    const review = makeReview('src/iso.ts');
    const promptHash = 'sha256:iso-prompt';

    writeSharedReview(projIso, review, content, promptHash, 'model', ['correction']);

    const loaded = loadSharedReview(projIso, 'src/iso.ts', content, promptHash, ['correction']);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('CLEAN');
  });
});
