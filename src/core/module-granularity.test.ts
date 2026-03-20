// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveModuleGranularity, type ModuleDir } from './module-granularity.js';

/**
 * Story 29.4: Module Granularity Resolution
 *
 * Tests validate that resolveModuleGranularity() applies the correct
 * granularity rules from the typescript-documentation standard to
 * decide whether to create file-level or directory-level doc pages.
 */

describe('resolveModuleGranularity', () => {
  // --- AC1: 3+ files > 200 LOC → directory-level ---
  it('AC: src/core/ with 8 files each > 200 LOC → directory-level (core.md)', () => {
    const modules: ModuleDir[] = [
      {
        name: 'core',
        files: Array.from({ length: 8 }, (_, i) => ({
          name: `file-${i}.ts`,
          loc: 250,
        })),
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('05-Modules/core.md');
    expect(pages[0].title).toBe('core');
  });

  // --- AC2: 1-2 files > 200 LOC → file-level ---
  it('AC: src/utils/ with 2 files > 200 LOC → file-level (logger.md, cache.md)', () => {
    const modules: ModuleDir[] = [
      {
        name: 'utils',
        files: [
          { name: 'logger.ts', loc: 300 },
          { name: 'cache.ts', loc: 250 },
        ],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(2);
    const paths = pages.map(p => p.path);
    expect(paths).toContain('05-Modules/logger.md');
    expect(paths).toContain('05-Modules/cache.md');
  });

  // --- AC3: file < 200 LOC → skip ---
  it('AC: src/helpers/format.ts with 80 LOC → no page (skipped)', () => {
    const modules: ModuleDir[] = [
      {
        name: 'helpers',
        files: [{ name: 'format.ts', loc: 80 }],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(0);
  });

  // --- AC4: single file > 500 LOC → file-level ---
  it('AC: src/rag/doc-indexer.ts with 500+ LOC → file-level (doc-indexer.md)', () => {
    const modules: ModuleDir[] = [
      {
        name: 'rag',
        files: [
          { name: 'doc-indexer.ts', loc: 550 },
          { name: 'types.ts', loc: 50 },
          { name: 'utils.ts', loc: 30 },
        ],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('05-Modules/doc-indexer.md');
  });

  // --- Mixed: directory with 3+ qualifying files → directory-level ---
  it('directory with exactly 3 files > 200 LOC → directory-level', () => {
    const modules: ModuleDir[] = [
      {
        name: 'services',
        files: [
          { name: 'auth.ts', loc: 250 },
          { name: 'users.ts', loc: 300 },
          { name: 'payments.ts', loc: 280 },
          { name: 'index.ts', loc: 10 },
        ],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('05-Modules/services.md');
  });

  // --- Mixed: 2 qualifying files plus small ones → file-level for qualifying only ---
  it('2 files > 200 LOC among many small files → file-level for qualifying only', () => {
    const modules: ModuleDir[] = [
      {
        name: 'utils',
        files: [
          { name: 'logger.ts', loc: 300 },
          { name: 'cache.ts', loc: 250 },
          { name: 'helpers.ts', loc: 50 },
          { name: 'constants.ts', loc: 20 },
        ],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(2);
    const paths = pages.map(p => p.path);
    expect(paths).toContain('05-Modules/logger.md');
    expect(paths).toContain('05-Modules/cache.md');
    // Small files don't get pages
    expect(paths).not.toContain('05-Modules/helpers.md');
  });

  // --- Naming: kebab-case ---
  it('file names are converted to kebab-case without extension', () => {
    const modules: ModuleDir[] = [
      {
        name: 'core',
        files: [{ name: 'FileEvaluator.ts', loc: 400 }],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('05-Modules/file-evaluator.md');
  });

  // --- Multiple directories ---
  it('handles multiple directories independently', () => {
    const modules: ModuleDir[] = [
      {
        name: 'core',
        files: Array.from({ length: 5 }, (_, i) => ({
          name: `mod-${i}.ts`,
          loc: 250,
        })),
      },
      {
        name: 'utils',
        files: [{ name: 'logger.ts', loc: 300 }],
      },
      {
        name: 'helpers',
        files: [{ name: 'tiny.ts', loc: 50 }],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    const paths = pages.map(p => p.path);
    expect(paths).toContain('05-Modules/core.md');      // directory-level
    expect(paths).toContain('05-Modules/logger.md');     // file-level
    expect(paths).not.toContain('05-Modules/helpers.md'); // skipped
    expect(paths).not.toContain('05-Modules/tiny.md');    // skipped
  });

  // --- Page metadata ---
  it('directory-level pages mention the directory in their description', () => {
    const modules: ModuleDir[] = [
      {
        name: 'rag',
        files: Array.from({ length: 4 }, (_, i) => ({
          name: `file-${i}.ts`,
          loc: 250,
        })),
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages[0].description).toContain('rag');
    expect(pages[0].section).toBe('Modules');
  });

  // --- Empty input ---
  it('returns empty array for empty input', () => {
    expect(resolveModuleGranularity([])).toEqual([]);
  });

  // --- Directory with all files < 200 LOC ---
  it('directory with no qualifying files → no pages', () => {
    const modules: ModuleDir[] = [
      {
        name: 'tiny',
        files: [
          { name: 'a.ts', loc: 50 },
          { name: 'b.ts', loc: 100 },
          { name: 'c.ts', loc: 150 },
        ],
      },
    ];

    const pages = resolveModuleGranularity(modules);

    expect(pages).toHaveLength(0);
  });
});
