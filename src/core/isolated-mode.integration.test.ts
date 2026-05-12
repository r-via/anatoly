// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Isolated mode integration test.
 *
 * Verifies that when `shared/` is replaced by a real directory
 * (not a symlink), bootstrapAnatoly respects it, and cached data
 * stays local to the project instead of going to `~/.anatoly/shared/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';
import {
  writeSharedReview,
  loadSharedReview,
} from './shared-review-cache.js';
import type { ReviewFile } from '../schemas/review.js';

function makeReview(file: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict: 'CLEAN',
  } as unknown as ReviewFile;
}

describe('isolated mode integration', () => {
  let base: string;
  let fakeHome: string;
  let savedHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-isolated-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME ?? homedir();
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('bootstrap creates symlinks by default', () => {
    const root = join(base, 'proj');
    mkdirSync(root);
    bootstrapAnatoly(root);

    const stat = lstatSync(join(root, '.anatoly', 'shared'));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('respects real directory when symlink is replaced (isolated mode)', () => {
    const root = join(base, 'proj-iso');
    mkdirSync(root);

    // 1. Normal bootstrap (creates symlinks)
    bootstrapAnatoly(root);
    expect(lstatSync(join(root, '.anatoly', 'shared')).isSymbolicLink()).toBe(true);

    // 2. Replace symlink with a real directory
    unlinkSync(join(root, '.anatoly', 'shared'));
    mkdirSync(join(root, '.anatoly', 'shared'), { recursive: true });

    // 3. Re-bootstrap — should NOT recreate the symlink
    bootstrapAnatoly(root);
    const stat = lstatSync(join(root, '.anatoly', 'shared'));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });

  it('cache writes go to local project dir in isolated mode, not user-wide shared', () => {
    const root = join(base, 'proj-iso');
    mkdirSync(root);

    // 1. Bootstrap normally
    bootstrapAnatoly(root);

    // 2. Replace symlink with real dir + create reviews subdir
    unlinkSync(join(root, '.anatoly', 'shared'));
    mkdirSync(join(root, '.anatoly', 'shared', 'reviews'), { recursive: true });

    // 3. Re-bootstrap
    bootstrapAnatoly(root);

    // 4. Write a review
    const fileContent = 'export function isolated() { return true; }\n';
    const review = makeReview('src/isolated.ts');
    writeSharedReview(root, review, fileContent, 'sha256:iso-prompt', 'model', ['correction']);

    // 5. Verify it's in the project dir, NOT in ~/.anatoly/shared/
    const loaded = loadSharedReview(root, 'src/isolated.ts', fileContent, 'sha256:iso-prompt', ['correction']);
    expect(loaded).not.toBeNull();

    // The user-wide shared dir should NOT have the review
    const userWideReviews = join(fakeHome, '.anatoly', 'shared', 'reviews');
    if (existsSync(userWideReviews)) {
      // If it exists, check no review was written there
      const entries = readdirSync(userWideReviews, { recursive: true }) as string[];
      // Entries could be subdirs from bootstrap, but no .rev.json files
      const jsonFiles = entries.filter((e: string) => e.endsWith('.json'));
      expect(jsonFiles.length).toBe(0);
    }
  });
});
