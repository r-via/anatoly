// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkDocCache,
  updateDocCacheEntry,
  removeDocCacheEntry,
  loadDocCache,
  saveDocCache,
  type DocCache,
} from './doc-cache.js';

/**
 * Story 29.9: Incremental Cache (SHA-256 per Page)
 *
 * Tests validate cache-based change detection so that only pages
 * whose source files changed are regenerated on subsequent runs.
 */

describe('checkDocCache', () => {
  // --- AC1: No changes → 100% cache hit ---
  describe('no changes (AC1)', () => {
    it('returns all pages as fresh when hashes match', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/scanner.md': { 'src/core/scanner.ts': 'hash1' },
          '05-Modules/indexer.md': { 'src/rag/indexer.ts': 'hash2' },
          '05-Modules/cache.md': { 'src/utils/cache.ts': 'hash3' },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/scanner.md', sourceFiles: ['src/core/scanner.ts'] },
        { pagePath: '05-Modules/indexer.md', sourceFiles: ['src/rag/indexer.ts'] },
        { pagePath: '05-Modules/cache.md', sourceFiles: ['src/utils/cache.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'hash1'],
        ['src/rag/indexer.ts', 'hash2'],
        ['src/utils/cache.ts', 'hash3'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.fresh).toHaveLength(3);
      expect(result.stale).toHaveLength(0);
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
    });
  });

  // --- AC2: Source file changed → only affected pages regenerated ---
  describe('source file changed (AC2)', () => {
    it('marks only affected pages as stale', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/scanner.md': { 'src/core/scanner.ts': 'hash1' },
          '05-Modules/indexer.md': { 'src/rag/indexer.ts': 'hash2' },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/scanner.md', sourceFiles: ['src/core/scanner.ts'] },
        { pagePath: '05-Modules/indexer.md', sourceFiles: ['src/rag/indexer.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'CHANGED_HASH'],
        ['src/rag/indexer.ts', 'hash2'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.stale).toEqual(['05-Modules/scanner.md']);
      expect(result.fresh).toEqual(['05-Modules/indexer.md']);
    });
  });

  // --- AC3: New file added → new page ---
  describe('new file added (AC3)', () => {
    it('marks new pages as added', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/scanner.md': { 'src/core/scanner.ts': 'hash1' },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/scanner.md', sourceFiles: ['src/core/scanner.ts'] },
        { pagePath: '05-Modules/new-module.md', sourceFiles: ['src/core/new-module.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'hash1'],
        ['src/core/new-module.ts', 'new_hash'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.added).toEqual(['05-Modules/new-module.md']);
      expect(result.fresh).toEqual(['05-Modules/scanner.md']);
    });
  });

  // --- AC4: File deleted → page removed ---
  describe('file deleted (AC4)', () => {
    it('marks orphaned pages as removed', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/scanner.md': { 'src/core/scanner.ts': 'hash1' },
          '05-Modules/old-helper.md': { 'src/utils/old-helper.ts': 'hash2' },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/scanner.md', sourceFiles: ['src/core/scanner.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'hash1'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.removed).toEqual(['05-Modules/old-helper.md']);
      expect(result.fresh).toEqual(['05-Modules/scanner.md']);
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('treats empty cache as all pages added', () => {
      const cache: DocCache = { version: 1, pages: {} };

      const currentPages = [
        { pagePath: '05-Modules/scanner.md', sourceFiles: ['src/core/scanner.ts'] },
      ];

      const currentHashes = new Map([['src/core/scanner.ts', 'hash1']]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.added).toEqual(['05-Modules/scanner.md']);
      expect(result.fresh).toHaveLength(0);
    });

    it('page with multiple source files is stale if any file changes', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/core.md': {
            'src/core/scanner.ts': 'hash1',
            'src/core/evaluator.ts': 'hash2',
          },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/core.md', sourceFiles: ['src/core/scanner.ts', 'src/core/evaluator.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'hash1'],
        ['src/core/evaluator.ts', 'CHANGED'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.stale).toEqual(['05-Modules/core.md']);
    });

    it('page is stale when source file list changes (new source added)', () => {
      const cache: DocCache = {
        version: 1,
        pages: {
          '05-Modules/core.md': { 'src/core/scanner.ts': 'hash1' },
        },
      };

      const currentPages = [
        { pagePath: '05-Modules/core.md', sourceFiles: ['src/core/scanner.ts', 'src/core/new-file.ts'] },
      ];

      const currentHashes = new Map([
        ['src/core/scanner.ts', 'hash1'],
        ['src/core/new-file.ts', 'new_hash'],
      ]);

      const result = checkDocCache(cache, currentPages, currentHashes);

      expect(result.stale).toEqual(['05-Modules/core.md']);
    });
  });
});

describe('updateDocCacheEntry', () => {
  it('adds a new page entry to the cache', () => {
    const cache: DocCache = { version: 1, pages: {} };

    const updated = updateDocCacheEntry(cache, '05-Modules/scanner.md', {
      'src/core/scanner.ts': 'hash1',
    });

    expect(updated.pages['05-Modules/scanner.md']).toEqual({
      'src/core/scanner.ts': 'hash1',
    });
  });

  it('overwrites an existing entry', () => {
    const cache: DocCache = {
      version: 1,
      pages: {
        '05-Modules/scanner.md': { 'src/core/scanner.ts': 'old_hash' },
      },
    };

    const updated = updateDocCacheEntry(cache, '05-Modules/scanner.md', {
      'src/core/scanner.ts': 'new_hash',
    });

    expect(updated.pages['05-Modules/scanner.md']['src/core/scanner.ts']).toBe('new_hash');
  });
});

describe('removeDocCacheEntry', () => {
  it('removes a page entry from the cache', () => {
    const cache: DocCache = {
      version: 1,
      pages: {
        '05-Modules/scanner.md': { 'src/core/scanner.ts': 'hash1' },
        '05-Modules/old.md': { 'src/utils/old.ts': 'hash2' },
      },
    };

    const updated = removeDocCacheEntry(cache, '05-Modules/old.md');

    expect(updated.pages['05-Modules/old.md']).toBeUndefined();
    expect(updated.pages['05-Modules/scanner.md']).toBeDefined();
  });
});

describe('loadDocCache / saveDocCache', () => {
  it('returns empty cache when file does not exist', () => {
    const nonexistent = join(tmpdir(), `doc-cache-test-${Date.now()}`, '.cache.json');

    const cache = loadDocCache(nonexistent);

    expect(cache).toEqual({ version: 1, pages: {} });
  });

  it('round-trips save and load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-cache-'));
    const cachePath = join(dir, '.cache.json');

    const cache: DocCache = {
      version: 1,
      pages: { '05-Modules/foo.md': { 'src/foo.ts': 'hash1' } },
    };

    saveDocCache(cachePath, cache);
    const loaded = loadDocCache(cachePath);

    expect(loaded).toEqual(cache);

    rmSync(dir, { recursive: true });
  });
});
