// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { renderDocReferenceSection, type DocReportStats } from './doc-report-section.js';

/**
 * Story 29.11: Documentation Reference Section in Report
 *
 * Tests validate that renderDocReferenceSection() produces the correct
 * Markdown section showing .anatoly/docs/ status and the delta with docs/.
 */

describe('renderDocReferenceSection', () => {
  // --- AC1: Page generation summary ---
  it('AC: shows page generation summary with new, refreshed, and cached counts', () => {
    const result = renderDocReferenceSection({
      totalPages: 28,
      newPages: [
        { page: '05-Modules/scanner.md', source: 'src/core/scanner.ts' },
        { page: '05-Modules/indexer.md', source: 'src/rag/indexer.ts' },
        { page: '05-Modules/cache.md', source: 'src/utils/cache.ts' },
      ],
      refreshedPages: [
        '05-Modules/evaluator.md',
        '02-Architecture/01-System-Overview.md',
        '04-API-Reference/01-Public-API.md',
        '01-Getting-Started/02-Installation.md',
        '05-Modules/reporter.md',
      ],
      cachedPages: Array.from({ length: 20 }, (_, i) => `page-${i}.md`),
      userDocsPageCount: 18,
    });

    expect(result).toContain('## Documentation Reference');
    expect(result).toContain('28 pages');
    expect(result).toContain('3 new');
    expect(result).toContain('5 refreshed');
    expect(result).toContain('20 cached');
  });

  // --- AC2: Coverage comparison ---
  it('AC: shows docs/ coverage percentage and sync gap', () => {
    const result = renderDocReferenceSection({
      totalPages: 28,
      newPages: [],
      refreshedPages: [],
      cachedPages: Array.from({ length: 28 }, (_, i) => `page-${i}.md`),
      userDocsPageCount: 18,
    });

    expect(result).toContain('Documentation coverage: 64% (18/28 pages)');
  });

  // --- AC3: New pages listing ---
  it('AC: lists each new page with its source file', () => {
    const result = renderDocReferenceSection({
      totalPages: 10,
      newPages: [
        { page: '05-Modules/doc-scaffolder.md', source: 'src/core/doc-scaffolder.ts' },
      ],
      refreshedPages: [],
      cachedPages: Array.from({ length: 9 }, (_, i) => `page-${i}.md`),
      userDocsPageCount: 5,
    });

    expect(result).toContain('New pages generated:');
    expect(result).toContain('+ .anatoly/docs/05-Modules/doc-scaffolder.md  (from src/core/doc-scaffolder.ts)');
  });

  // --- Edge cases ---
  it('omits new pages section when none were generated', () => {
    const result = renderDocReferenceSection({
      totalPages: 10,
      newPages: [],
      refreshedPages: [],
      cachedPages: Array.from({ length: 10 }, (_, i) => `page-${i}.md`),
      userDocsPageCount: 10,
    });

    expect(result).not.toContain('New pages generated');
  });

  it('shows 100% coverage when all pages exist in docs/', () => {
    const result = renderDocReferenceSection({
      totalPages: 5,
      newPages: [],
      refreshedPages: [],
      cachedPages: Array.from({ length: 5 }, (_, i) => `page-${i}.md`),
      userDocsPageCount: 5,
    });

    expect(result).toContain('Documentation coverage: 100% (5/5 pages)');
  });

  it('handles first run where all pages are new', () => {
    const result = renderDocReferenceSection({
      totalPages: 3,
      newPages: [
        { page: 'index.md', source: 'package.json' },
        { page: '01-Getting-Started/01-Overview.md', source: 'package.json' },
        { page: '02-Architecture/01-System-Overview.md', source: 'src/' },
      ],
      refreshedPages: [],
      cachedPages: [],
      userDocsPageCount: 0,
    });

    expect(result).toContain('3 pages');
    expect(result).toContain('3 new');
    expect(result).not.toContain('refreshed');
    expect(result).not.toContain('cached');
    expect(result).toContain('Documentation coverage: 0% (0/3 pages)');
  });

  // --- Story 29.20: Dual symbol coverage + sync by type ---
  describe('dual symbol coverage (Story 29.20)', () => {
    it('displays project and internal symbol coverage when provided', () => {
      const result = renderDocReferenceSection({
        totalPages: 28,
        newPages: [],
        refreshedPages: [],
        cachedPages: Array.from({ length: 28 }, (_, i) => `page-${i}.md`),
        userDocsPageCount: 18,
        symbolCoverage: {
          projectDocumented: 94,
          internalDocumented: 192,
          totalExports: 209,
        },
      });

      expect(result).toContain('Fully documented: 45% (94/209 symbols)');
      expect(result).toContain('At least partial: 92% (192/209 symbols)');
    });

    it('displays module coverage when provided', () => {
      const result = renderDocReferenceSection({
        totalPages: 28,
        newPages: [],
        refreshedPages: [],
        cachedPages: Array.from({ length: 28 }, (_, i) => `page-${i}.md`),
        userDocsPageCount: 18,
        symbolCoverage: {
          projectDocumented: 94,
          internalDocumented: 192,
          totalExports: 209,
          modulesDocumented: 6,
          totalModules: 8,
        },
      });

      expect(result).toContain('Modules: 75% (6/8 modules > 200 LOC in project docs)');
    });

    it('displays sync status by recommendation type', () => {
      const result = renderDocReferenceSection({
        totalPages: 28,
        newPages: [],
        refreshedPages: [],
        cachedPages: Array.from({ length: 28 }, (_, i) => `page-${i}.md`),
        userDocsPageCount: 18,
        syncByType: { toCreate: 5, outdated: 3 },
      });

      expect(result).toContain('5 pages to create');
      expect(result).toContain('3 pages outdated');
    });

    it('shows 100% for 0 exports (AC4)', () => {
      const result = renderDocReferenceSection({
        totalPages: 5,
        newPages: [],
        refreshedPages: [],
        cachedPages: Array.from({ length: 5 }, (_, i) => `page-${i}.md`),
        userDocsPageCount: 5,
        symbolCoverage: {
          projectDocumented: 0,
          internalDocumented: 0,
          totalExports: 0,
        },
      });

      expect(result).toContain('Fully documented: 100%');
      expect(result).toContain('At least partial: 100%');
    });

    it('caps coverage at 100% (AC5)', () => {
      const result = renderDocReferenceSection({
        totalPages: 5,
        newPages: [],
        refreshedPages: [],
        cachedPages: Array.from({ length: 5 }, (_, i) => `page-${i}.md`),
        userDocsPageCount: 5,
        symbolCoverage: {
          projectDocumented: 30,
          internalDocumented: 25,
          totalExports: 25,
        },
      });

      expect(result).toContain('Fully documented: 100%');
      // 120% should not appear — documented count capped to total
      expect(result).not.toContain('120%');
      expect(result).toContain('25/25 symbols');
    });
  });
});
