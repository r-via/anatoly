// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateDocReport, type DocReportInput } from './doc-report-aggregator.js';
import type { ReviewFile } from '../schemas/review.js';
import type { Task } from '../schemas/task.js';

function makeReview(file: string, symbols: ReviewFile['symbols'], docsCoverage?: ReviewFile['docs_coverage']): ReviewFile {
  return {
    version: 2,
    file,
    is_generated: false,
    verdict: 'CLEAN',
    symbols,
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    docs_coverage: docsCoverage,
  };
}

function makeTask(file: string, maxLine: number): Task {
  return {
    version: 1,
    file,
    hash: 'abc',
    symbols: [{ name: 'fn', kind: 'function' as const, exported: true, line_start: 1, line_end: maxLine }],
    scanned_at: '2026-03-20T00:00:00Z',
  };
}

describe('aggregateDocReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-report-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should produce a score and recommendations when no docs/ exists', () => {
    const input: DocReportInput = {
      projectRoot: tempDir,
      projectTypes: ['Library'],
      reviews: [
        makeReview('src/core/scanner.ts', [
          { name: 'scanProject', kind: 'function', exported: true, line_start: 1, line_end: 50, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'UNDOCUMENTED', confidence: 90, detail: 'No JSDoc documentation found for exported function.', duplicate_target: undefined },
        ]),
      ],
      tasks: [makeTask('src/core/scanner.ts', 250)],
      idealPageCount: 20,
    };

    const result = aggregateDocReport(input);

    expect(result.score.verdict).toBe('UNDOCUMENTED');
    expect(result.score.structural).toBe(0);
    expect(result.score.syncGap).toBe(20);
    expect(result.userDocPlan).toBeNull();
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.renderedSection).toContain('Documentation Reference');
  });

  it('should resolve user doc plan when docs/ exists', () => {
    const docsDir = join(tempDir, 'docs');
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(join(docsDir, 'architecture', 'overview.md'), '# Architecture Overview\n\n> System design');
    writeFileSync(join(docsDir, 'index.md'), '# Documentation\n');

    const input: DocReportInput = {
      projectRoot: tempDir,
      projectTypes: ['Library'],
      reviews: [],
      tasks: [],
      idealPageCount: 20,
    };

    const result = aggregateDocReport(input);

    expect(result.userDocPlan).not.toBeNull();
    expect(result.userDocPlan!.pages.length).toBe(2);
    expect(result.renderedSection).toContain('Documentation coverage');
  });

  it('should compute API coverage from review symbols', () => {
    const input: DocReportInput = {
      projectRoot: tempDir,
      projectTypes: ['Library'],
      reviews: [
        makeReview('src/index.ts', [
          { name: 'foo', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'DOCUMENTED', confidence: 90, detail: 'Well documented function with JSDoc.', duplicate_target: undefined },
          { name: 'bar', kind: 'function', exported: true, line_start: 11, line_end: 20, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'UNDOCUMENTED', confidence: 90, detail: 'No JSDoc documentation found for exported function.', duplicate_target: undefined },
        ]),
      ],
      tasks: [],
      idealPageCount: 20,
    };

    const result = aggregateDocReport(input);

    // 1 out of 2 exports documented = 50%
    expect(result.score.apiCoverage).toBe(50);
  });

  it('should generate gaps from docs_coverage concepts', () => {
    const input: DocReportInput = {
      projectRoot: tempDir,
      projectTypes: ['Backend API'],
      reviews: [
        makeReview('src/routes/api.ts', [], {
          concepts: [
            { name: 'Authentication', status: 'MISSING', doc_path: null, detail: 'No auth docs' },
            { name: 'Error Handling', status: 'OUTDATED', doc_path: 'docs/guides/errors.md', detail: 'Stale error docs' },
          ],
          score_pct: 30,
        }),
      ],
      tasks: [],
      idealPageCount: 20,
    };

    const result = aggregateDocReport(input);

    const missingRec = result.recommendations.find(r => r.rationale.includes('Authentication'));
    expect(missingRec).toBeDefined();
    expect(missingRec!.type).toBe('missing_page');

    const outdatedRec = result.recommendations.find(r => r.rationale.includes('Error Handling'));
    expect(outdatedRec).toBeDefined();
    expect(outdatedRec!.type).toBe('outdated_content');
  });

  it('should include cache stats in rendered section', () => {
    const input: DocReportInput = {
      projectRoot: tempDir,
      projectTypes: ['Library'],
      reviews: [],
      tasks: [],
      idealPageCount: 25,
      cacheResult: {
        stale: ['05-Modules/core.md'],
        fresh: ['01-Getting-Started/01-Overview.md', '02-Architecture/01-System-Overview.md'],
        added: ['05-Modules/new-module.md'],
        removed: [],
      },
      newPageSources: [
        { page: '05-Modules/new-module.md', source: 'src/core/new-module.ts' },
      ],
    };

    const result = aggregateDocReport(input);

    expect(result.renderedSection).toContain('25 pages');
    expect(result.renderedSection).toContain('1 new');
    expect(result.renderedSection).toContain('1 refreshed');
    expect(result.renderedSection).toContain('2 cached');
  });
});
