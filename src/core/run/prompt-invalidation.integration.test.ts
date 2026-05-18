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
  loadProjectReview,
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
    writeProjectReview(root, review, fileContent, hash1, modelId, ['correction']);

    // Verify cache hit with same prompt
    const hit = loadProjectReview(root, 'src/hello.ts', fileContent, hash1, ['correction']);
    expect(hit).not.toBeNull();
    expect(hit!.verdict).toBe('CLEAN');

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

    // Cache miss with modified prompt
    const miss = loadProjectReview(root, 'src/hello.ts', fileContent, hash2, ['correction']);
    expect(miss).toBeNull();
  });

  it('same file content + same prompt → cache hit across different file paths', () => {
    const systemPrompt = 'Review code.';
    const userTemplate = '{{file}}';
    const modelId = 'model';
    const hash = computePromptHash({ schemaVersion: 1, modelId, systemPrompt, userTemplate });
    const content = 'const x = 42;\n';

    // Write review for file A
    writeProjectReview(root, makeReview('src/a.ts'), content, hash, modelId, ['correction']);

    // Load for file B with identical content → cache hit (content-addressed)
    const loaded = loadProjectReview(root, 'src/b.ts', content, hash, ['correction']);
    expect(loaded).not.toBeNull();
  });
});
