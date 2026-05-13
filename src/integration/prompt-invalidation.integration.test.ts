// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Prompt invalidation integration test.
 *
 * Verifies that when the prompt hash changes (e.g. system prompt modified),
 * cached reviews are invalidated and must be re-evaluated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';
import { computePromptHash } from '../utils/cache-meta.js';
import {
  writeProjectReview,
  loadProjectReview,
} from '../core/project-review-cache.js';
import type { ReviewFile } from '../schemas/review.js';

function makeReview(file: string, verdict: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict,
  } as unknown as ReviewFile;
}

describe('prompt invalidation integration (Story 52.7)', () => {
  let base: string;
  let root: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-prompt-inv-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME!;
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.anatoly'), { recursive: true });  // simulate local install

    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    bootstrapAnatoly(root);
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('review is cached when prompt hash matches', () => {
    const fileContent = 'const x = 42;\n';
    const systemPrompt = 'You are a code reviewer. Check for correctness.';
    const userTemplate = 'Review this file: {{file}}';

    const promptHash = computePromptHash({
      schemaVersion: 1,
      modelId: 'claude-3.5-sonnet',
      systemPrompt,
      userTemplate,
    });

    const review = makeReview('src/app.ts', 'CLEAN');
    writeProjectReview(root, review, fileContent, promptHash, 'claude-3.5-sonnet', ['correction']);

    // Same prompt hash → cache hit
    const loaded = loadProjectReview(root, 'src/app.ts', fileContent, promptHash, ['correction']);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('CLEAN');
  });

  it('review is invalidated when system prompt changes (new prompt hash)', () => {
    const fileContent = 'const x = 42;\n';
    const systemPromptV1 = 'You are a code reviewer. Check for correctness.';
    const systemPromptV2 = 'You are a code reviewer. Check for correctness!'; // one char change
    const userTemplate = 'Review this file: {{file}}';

    const promptHashV1 = computePromptHash({
      schemaVersion: 1,
      modelId: 'claude-3.5-sonnet',
      systemPrompt: systemPromptV1,
      userTemplate,
    });

    const promptHashV2 = computePromptHash({
      schemaVersion: 1,
      modelId: 'claude-3.5-sonnet',
      systemPrompt: systemPromptV2,
      userTemplate,
    });

    // Prompt hashes should differ
    expect(promptHashV1).not.toBe(promptHashV2);

    // Write review with V1 prompt
    const review = makeReview('src/app.ts', 'CLEAN');
    writeProjectReview(root, review, fileContent, promptHashV1, 'claude-3.5-sonnet', ['correction']);

    // Load with V1 → cache hit
    expect(loadProjectReview(root, 'src/app.ts', fileContent, promptHashV1, ['correction'])).not.toBeNull();

    // Load with V2 → cache miss (prompt changed)
    expect(loadProjectReview(root, 'src/app.ts', fileContent, promptHashV2, ['correction'])).toBeNull();
  });

  it('re-evaluated review replaces stale one after prompt change', () => {
    const fileContent = 'const x = 42;\n';
    const promptHashOld = 'sha256:old-prompt';
    const promptHashNew = 'sha256:new-prompt';

    // Write original review
    const reviewV1 = makeReview('src/app.ts', 'CLEAN');
    writeProjectReview(root, reviewV1, fileContent, promptHashOld, 'model', ['correction']);

    // Old prompt → hit
    expect(loadProjectReview(root, 'src/app.ts', fileContent, promptHashOld, ['correction'])).not.toBeNull();
    // New prompt → miss
    expect(loadProjectReview(root, 'src/app.ts', fileContent, promptHashNew, ['correction'])).toBeNull();

    // Re-evaluate: write new review with new prompt hash (overwrites shared file)
    const reviewV2 = makeReview('src/app.ts', 'NEEDS_REFACTOR');
    writeProjectReview(root, reviewV2 as unknown as ReviewFile, fileContent, promptHashNew, 'model', ['correction']);

    // New prompt → hit with updated verdict
    const loaded = loadProjectReview(root, 'src/app.ts', fileContent, promptHashNew, ['correction']);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('NEEDS_REFACTOR');

    // Old prompt → miss (file was overwritten)
    expect(loadProjectReview(root, 'src/app.ts', fileContent, promptHashOld, ['correction'])).toBeNull();
  });
});
