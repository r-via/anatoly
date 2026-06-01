// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Prompt invalidation integration test.
 *
 * Verifies that modifying a system prompt produces a new prompt_hash,
 * causing a cache miss for reviews that were cached with the old prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProjectReview,
  resolveAxisCache,
} from './index.js';
import { computePromptHash } from '../../utils/cache-meta.js';
import type { ReviewFile } from '../../schemas/review.js';

function makeReview(file: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict: 'CLEAN',
  } as unknown as ReviewFile;
}

const correctionMeta = (h: string, m = 'claude-3.5-sonnet') => ({ correction: { prompt_hash: h, model_id: m } });
const resolveCorrection = (root: string, file: string, content: string, h: string, m = 'claude-3.5-sonnet') =>
  resolveAxisCache(root, file, content, ['correction'], { correction: h }, { correction: m });

describe('prompt invalidation integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-prompt-'));
    mkdirSync(join(root, '.anatoly', 'cache', 'reviews'), { recursive: true });
    mkdirSync(join(root, '.anatoly', 'cache'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('changing a system prompt character produces a new prompt_hash → cache miss', () => {
    const systemPrompt = 'You are a code review assistant. Be thorough and precise.';
    const userTemplate = 'Review the following file: {{file}}';
    const fileContent = 'export function hello() { return "world"; }\n';
    const modelId = 'claude-3.5-sonnet';

    // Compute initial prompt hash
    const hash1 = computePromptHash({
      schemaVersion: 1,
      modelId,
      systemPrompt,
      userTemplate,
    });

    // Write review with initial prompt hash
    const review = makeReview('src/hello.ts');
    writeProjectReview(root, review, fileContent, correctionMeta(hash1, modelId), ['correction']);

    // Same prompt → reusable.
    const hit = resolveCorrection(root, 'src/hello.ts', fileContent, hash1, modelId);
    expect(hit.staleAxes).toEqual([]);
    expect(hit.cached!.verdict).toBe('CLEAN');

    // Modify one character in the system prompt
    const modifiedPrompt = 'You are a code review assistant. Be thorough and precise!'; // . → !
    const hash2 = computePromptHash({
      schemaVersion: 1,
      modelId,
      systemPrompt: modifiedPrompt,
      userTemplate,
    });

    // Hashes must differ
    expect(hash2).not.toBe(hash1);

    // Modified prompt → stale.
    expect(resolveCorrection(root, 'src/hello.ts', fileContent, hash2, modelId).staleAxes).toEqual(['correction']);
  });

  it('per-axis keys are path-scoped: a different path is not reused (re-evaluated)', () => {
    const modelId = 'model';
    const hash = 'sha256:p';
    const content = 'const x = 42;\n';

    // Write review for file A.
    writeProjectReview(root, makeReview('src/a.ts'), content, correctionMeta(hash, modelId), ['correction']);

    // File B with identical content but no index entry of its own → stale.
    // The pre-v2 cache reused the content-addressed blob across paths; per-axis
    // freshness keys are stored per path, so a rename/copy re-evaluates (safe).
    const res = resolveCorrection(root, 'src/b.ts', content, hash, modelId);
    expect(res.cached).toBeNull();
    expect(res.staleAxes).toEqual(['correction']);
  });
});
