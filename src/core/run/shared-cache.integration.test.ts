// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProjectReview,
  resolveAxisCache,
  projectReviewPath,
} from './index.js';
import {
  writeSharedNlpSummary,
  loadSharedNlpSummary,
  computeBodyHash,
} from '../../rag/indexer.js';
import { computeContentHash } from '../../utils/cache.js';
import type { ReviewFile } from '../../schemas/review.js';

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

/** Per-axis `{prompt_hash, model_id}` map for writeProjectReview. */
function meta(axes: string[], promptHash = 'sha256:p', model = 'model'): Record<string, { prompt_hash: string; model_id: string }> {
  return Object.fromEntries(axes.map((a) => [a, { prompt_hash: promptHash, model_id: model }]));
}

/** Per-axis prompt-hash / model maps for resolveAxisCache. */
function keys(axes: string[], promptHash = 'sha256:p', model = 'model'): { prompt: Record<string, string>; model: Record<string, string> } {
  return {
    prompt: Object.fromEntries(axes.map((a) => [a, promptHash])),
    model: Object.fromEntries(axes.map((a) => [a, model])),
  };
}

/**
 * Bootstrap two projects that share the same `~/.anatoly/shared/` via symlinks.
 * Returns { projA, projB, sharedDir }.
 */
function setupCrossProjectEnv(): { projA: string; projB: string; sharedDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'anatoly-cross-'));
  // shared/ only holds multi-tenant safe dirs now (pricing/grammars/models).
  // No reviews/refinements/nlp-summaries — those are project-local under cache/.
  const sharedDir = join(base, 'shared');
  mkdirSync(sharedDir, { recursive: true });

  const projA = join(base, 'proj-A');
  const projB = join(base, 'proj-B');
  mkdirSync(join(projA, '.anatoly', 'cache'), { recursive: true });
  mkdirSync(join(projB, '.anatoly', 'cache'), { recursive: true });
  mkdirSync(join(projB, '.anatoly', 'cache', 'rag'), { recursive: true });

  // Symlink shared/ from each project to the common shared dir
  symlinkSync(sharedDir, join(projA, '.anatoly', 'shared'));
  symlinkSync(sharedDir, join(projB, '.anatoly', 'shared'));

  return {
    projA,
    projB,
    sharedDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Regression guard: code-derived artifacts MUST NOT leak cross-project
// ---------------------------------------------------------------------------
//
// Pre-existing design (Story 52.4-52.5 "AC6") tried to dedupe reviews and NLP
// summaries cross-project via `~/.anatoly/shared/{reviews,nlp-summaries}/`.
// That was rolled back: reviews and NLP summaries describe the user's CODE
// (confidential per project on a multi-tenant deployment), so they must live
// project-local under `cache/`. These tests assert the isolation, so any
// future regression that re-routes these artifacts under shared/ trips a CI
// alarm.

describe('isolation guard: reviews + NLP summaries are project-local', () => {
  let env: ReturnType<typeof setupCrossProjectEnv>;

  beforeEach(() => {
    env = setupCrossProjectEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('review path resolves under project-local cache/, not shared/', () => {
    const { projA } = env;
    const hash = computeContentHash('const x = 1;\n');
    const path = projectReviewPath(projA, hash);
    expect(path).toContain(join(projA, '.anatoly', 'cache', 'reviews'));
    expect(path).not.toContain(join(projA, '.anatoly', 'shared'));
  });

  it('review written by project A is NOT readable by project B (no cross-project leak)', () => {
    const { projA, projB } = env;
    const fileContent = 'export function util() { return 42; }\n';
    const review = makeReview('src/util.ts');

    writeProjectReview(projA, review, fileContent, meta(['correction', 'utility'], 'sha256:prompt-v1'), ['correction', 'utility']);

    // Same content, same axes, but DIFFERENT project — must miss (all stale).
    const k = keys(['correction', 'utility'], 'sha256:prompt-v1');
    const res = resolveAxisCache(projB, 'src/util.ts', fileContent, ['correction', 'utility'], k.prompt, k.model);
    expect(res.cached).toBeNull();
    expect(res.staleAxes.sort()).toEqual(['correction', 'utility']);
  });

  it('NLP summary written by project A is NOT readable by project B', () => {
    const { projA, projB } = env;
    const summary = { summary: 'Formats dates', docSummary: '', keyConcepts: ['date'], behavioralProfile: 'pure' as const };
    const bodyHash = computeBodyHash('function formatDate(d) { return d.toISOString(); }');

    writeSharedNlpSummary(projA, bodyHash, summary, 'flash-2.0');

    const loaded = loadSharedNlpSummary(projB, bodyHash);
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC7: Sharding test (256 hex prefixes)
// ---------------------------------------------------------------------------

describe('sharding distribution (AC7)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-shard-'));
    mkdirSync(join(root, '.anatoly', 'cache', 'reviews'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should distribute 256 files across 2-hex-char prefix directories', () => {
    const seenPrefixes = new Set<string>();

    // Generate 256 unique file contents that produce different hashes
    for (let i = 0; i < 256; i++) {
      const content = `unique-shard-content-${i}-${Math.random().toString(36)}`;
      const hash = computeContentHash(content);
      const prefix = hash.slice(0, 2);
      seenPrefixes.add(prefix);

      const review = makeReview(`src/file-${i}.ts`);
      writeProjectReview(root, review, content, meta(['correction']), ['correction']);

      const cachePath = projectReviewPath(root, hash);
      expect(existsSync(cachePath)).toBe(true);
    }

    // With 256 random hashes, we should see a good distribution
    // (statistically ≥50 unique prefixes out of 256 possible)
    expect(seenPrefixes.size).toBeGreaterThan(50);

    // Verify no shard directory contains an unreasonable number of files
    const reviewsDir = join(root, '.anatoly', 'cache', 'reviews');
    for (const prefix of readdirSync(reviewsDir)) {
      const prefixDir = join(reviewsDir, prefix);
      const files = readdirSync(prefixDir);
      // Each file in a shard dir — with 256 files and ~100+ shards,
      // no shard should have more than ~20 files
      expect(files.length).toBeLessThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// AC8: Prompt invalidation test
// ---------------------------------------------------------------------------

describe('prompt invalidation (AC8)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-prompt-inv-'));
    mkdirSync(join(root, '.anatoly', 'cache', 'reviews'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('marks the axis stale when its prompt_hash changes (prompt modified)', () => {
    const review = makeReview('src/foo.ts');
    const content = 'const x = 42;\n';

    writeProjectReview(root, review, content, meta(['correction'], 'sha256:original-prompt-hash'), ['correction']);

    // Same prompt hash → reusable.
    const hit = resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:original-prompt-hash' }, { correction: 'model' });
    expect(hit.staleAxes).toEqual([]);
    expect(hit.reusableAxes).toEqual(['correction']);

    // Modified prompt hash → stale (must be re-evaluated).
    const miss = resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:modified-prompt-hash' }, { correction: 'model' });
    expect(miss.staleAxes).toEqual(['correction']);
  });

  it('re-evaluated review replaces the stale one when the prompt changes', () => {
    const content = 'const x = 42;\n';
    const reviewV1 = { ...makeReview('src/foo.ts'), verdict: 'CLEAN' as const };
    const reviewV2 = { ...makeReview('src/foo.ts'), verdict: 'NEEDS_REFACTOR' as const };

    writeProjectReview(root, reviewV1, content, meta(['correction'], 'sha256:old-prompt'), ['correction']);

    // New prompt → stale.
    expect(resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:new-prompt' }, { correction: 'model' }).staleAxes).toEqual(['correction']);

    // Re-write v2 with the new prompt (same content → overwrites the axis key).
    writeProjectReview(root, reviewV2 as unknown as ReviewFile, content, meta(['correction'], 'sha256:new-prompt'), ['correction']);

    // New prompt now reuses v2.
    const loaded = resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:new-prompt' }, { correction: 'model' });
    expect(loaded.staleAxes).toEqual([]);
    expect(loaded.cached!.verdict).toBe('NEEDS_REFACTOR');

    // Old prompt is now stale (key was overwritten).
    expect(resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:old-prompt' }, { correction: 'model' }).staleAxes).toEqual(['correction']);
  });
});
