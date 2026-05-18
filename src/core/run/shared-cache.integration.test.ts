// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProjectReview,
  loadProjectReview,
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

    writeProjectReview(projA, review, fileContent, 'sha256:prompt-v1', 'claude-3.5-sonnet', ['correction', 'utility']);

    // Same content, same axes, but DIFFERENT project — must miss.
    const loaded = loadProjectReview(projB, 'src/util.ts', fileContent, 'sha256:prompt-v1', ['correction', 'utility']);
    expect(loaded).toBeNull();
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
      writeProjectReview(root, review, content, 'sha256:p', 'model', ['correction']);

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

  it('returns null when prompt_hash changes (prompt modified)', () => {
    const review = makeReview('src/foo.ts');
    const content = 'const x = 42;\n';

    // Write with prompt hash X
    writeProjectReview(root, review, content, 'sha256:original-prompt-hash', 'model', ['correction']);

    // Verify cache hit with same hash
    const hit = loadProjectReview(root, 'src/foo.ts', content, 'sha256:original-prompt-hash', ['correction']);
    expect(hit).not.toBeNull();

    // Simulate prompt modification → new prompt_hash Y
    const miss = loadProjectReview(root, 'src/foo.ts', content, 'sha256:modified-prompt-hash', ['correction']);
    expect(miss).toBeNull(); // Cache miss — review must be re-evaluated
  });

  it('re-evaluated review replaces stale one when prompt changes', () => {
    const content = 'const x = 42;\n';
    const reviewV1 = { ...makeReview('src/foo.ts'), verdict: 'CLEAN' as const };
    const reviewV2 = { ...makeReview('src/foo.ts'), verdict: 'NEEDS_REFACTOR' as const };

    // Write v1 with old prompt
    writeProjectReview(root, reviewV1, content, 'sha256:old-prompt', 'model', ['correction']);

    // Can't load with new prompt
    expect(loadProjectReview(root, 'src/foo.ts', content, 'sha256:new-prompt', ['correction'])).toBeNull();

    // Write v2 with new prompt (overwrites same cache entry since content hash is same)
    writeProjectReview(root, reviewV2 as unknown as ReviewFile, content, 'sha256:new-prompt', 'model', ['correction']);

    // Now loads with new prompt
    const loaded = loadProjectReview(root, 'src/foo.ts', content, 'sha256:new-prompt', ['correction']);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('NEEDS_REFACTOR');

    // Old prompt still misses (because cache entry was overwritten)
    expect(loadProjectReview(root, 'src/foo.ts', content, 'sha256:old-prompt', ['correction'])).toBeNull();
  });
});
