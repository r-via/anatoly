// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProjectReview,
  writeProjectReviewAtHash,
  resolveAxisCache,
  projectReviewPath,
  loadReviewIndex,
} from './project-review-cache.js';
import { computeContentHash } from '../../utils/cache.js';
import type { ReviewFile } from '../../schemas/review.js';

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'anatoly-project-review-'));
  mkdirSync(join(root, '.anatoly', 'cache', 'reviews'), { recursive: true });
  return root;
}

function makeReview(file: string): ReviewFile {
  return {
    file,
    symbols: [],
    actions: [],
    verdict: 'CLEAN',
  } as unknown as ReviewFile;
}

/** Build the per-axis `{prompt_hash, model_id}` map writeProjectReview expects. */
function meta(axes: string[], promptHash = 'sha256:p', model = 'model'): Record<string, { prompt_hash: string; model_id: string }> {
  return Object.fromEntries(axes.map((a) => [a, { prompt_hash: promptHash, model_id: model }]));
}

/** Build the per-axis prompt-hash / model maps resolveAxisCache expects. */
function keys(axes: string[], promptHash = 'sha256:p', model = 'model'): { prompt: Record<string, string>; model: Record<string, string> } {
  return {
    prompt: Object.fromEntries(axes.map((a) => [a, promptHash])),
    model: Object.fromEntries(axes.map((a) => [a, model])),
  };
}

describe('project-review-cache (per-axis)', () => {
  let root: string;

  beforeEach(() => { root = makeTempProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  describe('projectReviewPath', () => {
    it('uses a 2-hex-char sharding prefix', () => {
      const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const path = projectReviewPath(root, hash);
      expect(path).toContain(join('cache', 'reviews', 'ab', hash + '.rev.json'));
    });
  });

  describe('writeProjectReview', () => {
    it('writes the blob with a _meta header and per-axis index keys', () => {
      const content = 'const x = 42;\n';
      const hash = computeContentHash(content);
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['correction', 'utility']), ['correction', 'utility']);

      const cachePath = projectReviewPath(root, hash);
      expect(existsSync(cachePath)).toBe(true);
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(raw._meta.schema).toBe(1);
      expect(raw.data.file).toBe('src/foo.ts');

      const index = loadReviewIndex(root);
      const entry = index.files['src/foo.ts'];
      expect(entry.hash).toBe(hash);
      expect(entry.status).toBe('DONE');
      expect(Object.keys(entry.axes).sort()).toEqual(['correction', 'utility']);
      expect(entry.axes.correction.prompt_hash).toBe('sha256:p');
      expect(entry.axes.correction.model_id).toBe('model');
    });

    it('preserves prior axis keys when re-writing a different axis (same content)', () => {
      const content = 'const x = 42;\n';
      // First run: utility only.
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['utility']), ['utility']);
      // Second run: correction only — utility must survive.
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['correction']), ['correction']);

      const entry = loadReviewIndex(root).files['src/foo.ts'];
      expect(Object.keys(entry.axes).sort()).toEqual(['correction', 'utility']);
    });

    it('drops prior axis keys when the content changed', () => {
      writeProjectReview(root, makeReview('src/foo.ts'), 'old\n', meta(['utility']), ['utility']);
      // Content changed → utility key is stale, only the freshly-run axis remains.
      writeProjectReview(root, makeReview('src/foo.ts'), 'new\n', meta(['correction']), ['correction']);

      const entry = loadReviewIndex(root).files['src/foo.ts'];
      expect(Object.keys(entry.axes)).toEqual(['correction']);
    });
  });

  describe('resolveAxisCache', () => {
    it('reuses all requested axes on a full match', () => {
      const content = 'const x = 42;\n';
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['correction', 'utility']), ['correction', 'utility']);

      const k = keys(['correction', 'utility']);
      const res = resolveAxisCache(root, 'src/foo.ts', content, ['correction', 'utility'], k.prompt, k.model);
      expect(res.cached).not.toBeNull();
      expect(res.cached!.file).toBe('src/foo.ts');
      expect(res.staleAxes).toEqual([]);
      expect(res.reusableAxes.sort()).toEqual(['correction', 'utility']);
    });

    it('marks every requested axis stale when the file is not in the index', () => {
      const k = keys(['correction']);
      const res = resolveAxisCache(root, 'src/missing.ts', 'content', ['correction'], k.prompt, k.model);
      expect(res.cached).toBeNull();
      expect(res.staleAxes).toEqual(['correction']);
      expect(res.reusableAxes).toEqual([]);
    });

    it('marks every axis stale when content changed', () => {
      writeProjectReview(root, makeReview('src/foo.ts'), 'const x = 42;\n', meta(['correction']), ['correction']);
      const k = keys(['correction']);
      const res = resolveAxisCache(root, 'src/foo.ts', 'const x = 99;\n', ['correction'], k.prompt, k.model);
      expect(res.cached).toBeNull();
      expect(res.staleAxes).toEqual(['correction']);
    });

    it('marks only the drifted axis stale, reusing the rest (per-axis invalidation)', () => {
      const content = 'const x = 42;\n';
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['correction', 'utility']), ['correction', 'utility']);

      // correction's prompt drifted; utility unchanged.
      const prompt = { correction: 'sha256:NEW', utility: 'sha256:p' };
      const model = { correction: 'model', utility: 'model' };
      const res = resolveAxisCache(root, 'src/foo.ts', content, ['correction', 'utility'], prompt, model);
      expect(res.cached).not.toBeNull();
      expect(res.staleAxes).toEqual(['correction']);
      expect(res.reusableAxes).toEqual(['utility']);
    });

    it('marks an axis stale when its model changed', () => {
      const content = 'const x = 42;\n';
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['correction']), ['correction']);
      const res = resolveAxisCache(root, 'src/foo.ts', content, ['correction'], { correction: 'sha256:p' }, { correction: 'OTHER-MODEL' });
      expect(res.staleAxes).toEqual(['correction']);
    });

    it('reuses covered axes and flags the uncovered ones (the utility-then-full case)', () => {
      const content = 'const x = 42;\n';
      // Prior run only evaluated utility.
      writeProjectReview(root, makeReview('src/foo.ts'), content, meta(['utility']), ['utility']);

      // Full run requests all axes — only the six missing ones are stale.
      const requested = ['correction', 'utility', 'duplication', 'overengineering', 'tests', 'best_practices', 'documentation'];
      const k = keys(requested);
      const res = resolveAxisCache(root, 'src/foo.ts', content, requested, k.prompt, k.model);
      expect(res.reusableAxes).toEqual(['utility']);
      expect(res.staleAxes.sort()).toEqual(['best_practices', 'correction', 'documentation', 'duplication', 'overengineering', 'tests']);
    });

    it('matches across CRLF/LF line endings', () => {
      writeProjectReview(root, makeReview('src/foo.ts'), 'line1\nline2\n', meta(['correction']), ['correction']);
      const k = keys(['correction']);
      const res = resolveAxisCache(root, 'src/foo.ts', 'line1\r\nline2\r\n', ['correction'], k.prompt, k.model);
      expect(res.staleAxes).toEqual([]);
      expect(res.reusableAxes).toEqual(['correction']);
    });
  });

  describe('provenance (writeProjectReviewAtHash)', () => {
    it('keys the entry by the given source hash and stamps content_hash on the blob', () => {
      const srcContent = 'SOURCE CONTENT\n';
      const srcHash = computeContentHash(srcContent);
      writeProjectReviewAtHash(root, makeReview('src/foo.ts'), srcHash, meta(['correction']), ['correction']);

      expect(loadReviewIndex(root).files['src/foo.ts'].hash).toBe(srcHash);

      // Reused only when the current content hashes to the keyed source hash.
      const k = keys(['correction']);
      const res = resolveAxisCache(root, 'src/foo.ts', srcContent, ['correction'], k.prompt, k.model);
      expect(res.staleAxes).toEqual([]);
      expect(res.cached!.content_hash).toBe(srcHash);
    });

    it('does NOT reuse when current content differs from the keyed hash (the reseed re-stamp bug)', () => {
      // Simulate reseed: key a review by the OLD content it describes.
      const srcHash = computeContentHash('OLD VERSION\n');
      writeProjectReviewAtHash(root, makeReview('src/foo.ts'), srcHash, meta(['correction']), ['correction']);

      // The file now holds DIFFERENT content → must be stale (re-evaluated),
      // never served from the old review.
      const k = keys(['correction']);
      const res = resolveAxisCache(root, 'src/foo.ts', 'NEW VERSION\n', ['correction'], k.prompt, k.model);
      expect(res.cached).toBeNull();
      expect(res.staleAxes).toEqual(['correction']);
    });
  });

  describe('index migration', () => {
    it('abandons a pre-v2 index (forces a one-time re-evaluation)', () => {
      // Simulate a v1 index on disk: writeProjectReview writes v2; we resolve
      // through loadReviewIndex which only honours v2.
      writeProjectReview(root, makeReview('src/foo.ts'), 'x\n', meta(['correction']), ['correction']);
      expect(loadReviewIndex(root).version).toBe(2);
    });
  });
});
