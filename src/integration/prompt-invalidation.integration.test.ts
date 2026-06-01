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
  resolveAxisCache,
} from '../core/run/index.js';
import type { ReviewFile } from '../schemas/review.js';

function makeReview(file: string, verdict: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict,
  } as unknown as ReviewFile;
}

/** Single-axis (correction) per-axis maps for the helpers below. */
const correctionMeta = (h: string, m = 'claude-3.5-sonnet') => ({ correction: { prompt_hash: h, model_id: m } });
const resolveCorrection = (root: string, file: string, content: string, h: string, m = 'claude-3.5-sonnet') =>
  resolveAxisCache(root, file, content, ['correction'], { correction: h }, { correction: m });

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
    writeProjectReview(root, review, fileContent, correctionMeta(promptHash), ['correction']);

    // Same prompt hash → reusable.
    const res = resolveCorrection(root, 'src/app.ts', fileContent, promptHash);
    expect(res.staleAxes).toEqual([]);
    expect(res.cached!.verdict).toBe('CLEAN');
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
    writeProjectReview(root, review, fileContent, correctionMeta(promptHashV1), ['correction']);

    // V1 → reusable.
    expect(resolveCorrection(root, 'src/app.ts', fileContent, promptHashV1).staleAxes).toEqual([]);

    // V2 → stale (prompt changed).
    expect(resolveCorrection(root, 'src/app.ts', fileContent, promptHashV2).staleAxes).toEqual(['correction']);
  });

  it('re-evaluated review replaces stale one after prompt change', () => {
    const fileContent = 'const x = 42;\n';
    const promptHashOld = 'sha256:old-prompt';
    const promptHashNew = 'sha256:new-prompt';

    // Write original review
    const reviewV1 = makeReview('src/app.ts', 'CLEAN');
    writeProjectReview(root, reviewV1, fileContent, correctionMeta(promptHashOld, 'model'), ['correction']);

    // Old prompt → reusable; new prompt → stale.
    expect(resolveCorrection(root, 'src/app.ts', fileContent, promptHashOld, 'model').staleAxes).toEqual([]);
    expect(resolveCorrection(root, 'src/app.ts', fileContent, promptHashNew, 'model').staleAxes).toEqual(['correction']);

    // Re-evaluate: write new review with the new prompt hash (overwrites the key).
    const reviewV2 = makeReview('src/app.ts', 'NEEDS_REFACTOR');
    writeProjectReview(root, reviewV2 as unknown as ReviewFile, fileContent, correctionMeta(promptHashNew, 'model'), ['correction']);

    // New prompt → reusable with updated verdict.
    const loaded = resolveCorrection(root, 'src/app.ts', fileContent, promptHashNew, 'model');
    expect(loaded.staleAxes).toEqual([]);
    expect(loaded.cached!.verdict).toBe('NEEDS_REFACTOR');

    // Old prompt → stale (key was overwritten).
    expect(resolveCorrection(root, 'src/app.ts', fileContent, promptHashOld, 'model').staleAxes).toEqual(['correction']);
  });
});
