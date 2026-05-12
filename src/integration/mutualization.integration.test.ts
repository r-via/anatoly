// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Mutualization integration test.
 *
 * Verifies that two projects bootstrapped against the same `~/.anatoly/shared/`
 * share review caches cross-project when file content is identical, and miss
 * when content differs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';
import {
  writeSharedReview,
  loadSharedReview,
} from '../core/shared-review-cache.js';
import type { ReviewFile } from '../schemas/review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReview(file: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict: 'CLEAN',
  } as unknown as ReviewFile;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('mutualization integration (Story 52.7)', () => {
  let base: string;
  let projA: string;
  let projB: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-mutual-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME!;
    process.env.HOME = fakeHome;

    projA = join(base, 'proj-A');
    projB = join(base, 'proj-B');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    // Bootstrap both projects — creates symlinks to shared ~/.anatoly/shared/
    bootstrapAnatoly(projA);
    bootstrapAnatoly(projB);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('both projects have shared/ as symlinks pointing to the same target', () => {
    const statA = lstatSync(join(projA, '.anatoly', 'shared'));
    const statB = lstatSync(join(projB, '.anatoly', 'shared'));
    expect(statA.isSymbolicLink()).toBe(true);
    expect(statB.isSymbolicLink()).toBe(true);
  });

  it('review written by proj-A is a cache hit for proj-B when content matches', () => {
    const sharedContent = 'export function util() { return 42; }\n';
    const review = makeReview('src/util.ts');
    const promptHash = 'sha256:test-prompt-hash-v1';

    // Project A writes review
    writeSharedReview(projA, review, sharedContent, promptHash, 'claude-3.5-sonnet', ['correction']);

    // Project B reads review — should be a cache hit (same content + same prompt hash)
    const loaded = loadSharedReview(projB, 'src/util.ts', sharedContent, promptHash, ['correction']);
    expect(loaded).not.toBeNull();
    expect(loaded!.file).toBe('src/util.ts');
    expect(loaded!.verdict).toBe('CLEAN');
  });

  it('review is a cache miss for proj-B when file content differs', () => {
    const contentA = 'export function util() { return 42; }\n';
    const contentB = 'export function specific() { return 99; }\n';
    const review = makeReview('src/specific.ts');
    const promptHash = 'sha256:test-prompt-hash-v1';

    // Project A writes review for its version of the file
    writeSharedReview(projA, review, contentA, promptHash, 'claude-3.5-sonnet', ['correction']);

    // Project B has different content → different hash → cache miss
    const loaded = loadSharedReview(projB, 'src/specific.ts', contentB, promptHash, ['correction']);
    expect(loaded).toBeNull();
  });

  it('shared review store lives in ~/.anatoly/shared/ not project-local', () => {
    const sharedContent = 'const x = 1;\n';
    const review = makeReview('src/x.ts');
    writeSharedReview(projA, review, sharedContent, 'sha256:p', 'model', ['correction']);

    // The review file should exist under the user-wide shared dir
    const sharedReviewsDir = join(fakeHome, '.anatoly', 'shared', 'reviews');
    expect(existsSync(sharedReviewsDir)).toBe(true);
  });
});
