// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeSharedReview,
  loadSharedReview,
  sharedReviewPath,
  reviewIndexPath,
  loadReviewIndex,
} from './shared-review-cache.js';
import { computeContentHash } from '../utils/cache.js';
import type { ReviewFile } from '../schemas/review.js';

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'anatoly-shared-review-'));
  // Create required directory structure
  mkdirSync(join(root, '.anatoly', 'shared', 'reviews'), { recursive: true });
  mkdirSync(join(root, '.anatoly', 'cache'), { recursive: true });
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

describe('shared-review-cache', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('sharedReviewPath', () => {
    it('should use 2-hex-char sharding prefix', () => {
      const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const path = sharedReviewPath(root, hash);
      expect(path).toContain(join('shared', 'reviews', 'ab', hash + '.rev.json'));
    });
  });

  describe('writeSharedReview', () => {
    it('should write review to shared store with _meta header', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';
      const hash = computeContentHash(content);

      writeSharedReview(root, review, content, 'sha256:prompt123', 'claude-3.5-sonnet', ['correction', 'utility']);

      const sharedPath = sharedReviewPath(root, hash);
      expect(existsSync(sharedPath)).toBe(true);

      const raw = JSON.parse(readFileSync(sharedPath, 'utf-8'));
      expect(raw._meta).toBeDefined();
      expect(raw._meta.schema).toBe(1);
      expect(raw._meta.prompt_hash).toBe('sha256:prompt123');
      expect(raw._meta.model_id).toBe('claude-3.5-sonnet');
      expect(raw.data.file).toBe('src/foo.ts');
    });

    it('should update the review index', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';
      const hash = computeContentHash(content);

      writeSharedReview(root, review, content, 'sha256:prompt123', 'claude-3.5-sonnet', ['correction', 'utility']);

      const index = loadReviewIndex(root);
      expect(index.files['src/foo.ts']).toBeDefined();
      expect(index.files['src/foo.ts'].hash).toBe(hash);
      expect(index.files['src/foo.ts'].status).toBe('DONE');
      expect(index.files['src/foo.ts'].axes).toEqual(['correction', 'utility']);
    });

    it('should create sharded subdirectories', () => {
      const review = makeReview('src/bar.ts');
      const content = 'export function bar() {}';
      const hash = computeContentHash(content);
      const shardDir = join(root, '.anatoly', 'shared', 'reviews', hash.slice(0, 2));

      writeSharedReview(root, review, content, 'sha256:p', 'model', ['correction']);

      expect(existsSync(shardDir)).toBe(true);
    });
  });

  describe('loadSharedReview', () => {
    it('should return review on cache hit', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';

      writeSharedReview(root, review, content, 'sha256:prompt123', 'claude-3.5-sonnet', ['correction', 'utility']);

      const loaded = loadSharedReview(root, 'src/foo.ts', content, 'sha256:prompt123', ['correction', 'utility']);
      expect(loaded).not.toBeNull();
      expect(loaded!.file).toBe('src/foo.ts');
    });

    it('should return null when file not in index', () => {
      const result = loadSharedReview(root, 'src/missing.ts', 'content', 'sha256:p', ['correction']);
      expect(result).toBeNull();
    });

    it('should return null when content hash changed (file modified)', () => {
      const review = makeReview('src/foo.ts');
      const oldContent = 'const x = 42;\n';
      const newContent = 'const x = 99;\n';

      writeSharedReview(root, review, oldContent, 'sha256:p', 'model', ['correction']);

      const loaded = loadSharedReview(root, 'src/foo.ts', newContent, 'sha256:p', ['correction']);
      expect(loaded).toBeNull();
    });

    it('should return null when prompt hash changed (prompt invalidation)', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';

      writeSharedReview(root, review, content, 'sha256:old-prompt', 'model', ['correction']);

      const loaded = loadSharedReview(root, 'src/foo.ts', content, 'sha256:new-prompt', ['correction']);
      expect(loaded).toBeNull();
    });

    it('should return null when axes not fully covered', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';

      writeSharedReview(root, review, content, 'sha256:p', 'model', ['correction']);

      // Now asking for correction + utility but only correction was cached
      const loaded = loadSharedReview(root, 'src/foo.ts', content, 'sha256:p', ['correction', 'utility']);
      expect(loaded).toBeNull();
    });

    it('should hit cache when cached axes are superset of requested', () => {
      const review = makeReview('src/foo.ts');
      const content = 'const x = 42;\n';

      writeSharedReview(root, review, content, 'sha256:p', 'model', ['correction', 'utility', 'duplication']);

      // Requesting fewer axes than what's cached — should hit
      const loaded = loadSharedReview(root, 'src/foo.ts', content, 'sha256:p', ['correction', 'utility']);
      expect(loaded).not.toBeNull();
    });

    it('should support cross-platform CRLF/LF content matching', () => {
      const review = makeReview('src/foo.ts');
      const contentLF = 'line1\nline2\n';
      const contentCRLF = 'line1\r\nline2\r\n';

      // Written from a Unix system
      writeSharedReview(root, review, contentLF, 'sha256:p', 'model', ['correction']);

      // Read from a Windows system (CRLF file)
      const loaded = loadSharedReview(root, 'src/foo.ts', contentCRLF, 'sha256:p', ['correction']);
      expect(loaded).not.toBeNull();
    });
  });

  describe('sharding distribution', () => {
    it('should distribute files across 2-hex-char prefix directories', () => {
      // Write reviews with content that produces various hash prefixes
      const seenPrefixes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const content = `unique-content-${i}-${Math.random()}`;
        const hash = computeContentHash(content);
        seenPrefixes.add(hash.slice(0, 2));

        const review = makeReview(`src/file-${i}.ts`);
        writeSharedReview(root, review, content, 'sha256:p', 'model', ['correction']);

        const sharedPath = sharedReviewPath(root, hash);
        expect(existsSync(sharedPath)).toBe(true);
      }

      // With 100 random contents, we should see at least a few different prefixes
      expect(seenPrefixes.size).toBeGreaterThan(10);
    });
  });
});
