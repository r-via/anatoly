// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { syncDocs, type SyncResult } from './doc-sync.js';
import type { DocRecommendation } from './doc-recommendations.js';

/** Helper: creates an in-memory filesystem for testing */
function memFs(files: Record<string, string> = {}) {
  const store = { ...files };
  return {
    store,
    readFile: (path: string): string | null => store[path] ?? null,
    writeFile: (path: string, content: string) => {
      store[path] = content;
    },
  };
}

describe('syncDocs', () => {
  it('returns empty report for empty recommendations', () => {
    const fs = memFs();
    const report = syncDocs([], fs);

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  // --- missing_page ---

  it('creates new file from content_ref for missing_page', () => {
    const fs = memFs({
      '.anatoly/docs/05-Modules/rag.md': '# RAG Engine\n\n> Retrieval-augmented generation\n',
    });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/05-Modules/rag.md',
        path_user: 'docs/architecture/rag.md',
        content_ref: '.anatoly/docs/05-Modules/rag.md',
        rationale: 'Module src/rag/ has no documentation page',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0].path).toBe('docs/architecture/rag.md');
    expect(report.applied[0].action).toBe('created');
    expect(report.applied[0].before).toBeNull();
    expect(fs.store['docs/architecture/rag.md']).toContain('# RAG Engine');
  });

  it('adapts .anatoly/docs/ links to docs/ links in created pages', () => {
    const content = [
      '# Overview',
      '',
      'See [Architecture](.anatoly/docs/02-Architecture/01-System-Overview.md).',
      'Also [RAG](.anatoly/docs/05-Modules/rag.md).',
    ].join('\n');
    const fs = memFs({ '.anatoly/docs/01-Getting-Started/01-Overview.md': content });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/01-Getting-Started/01-Overview.md',
        path_user: 'docs/start/overview.md',
        content_ref: '.anatoly/docs/01-Getting-Started/01-Overview.md',
        rationale: 'Missing overview',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs);

    const written = fs.store['docs/start/overview.md'];
    expect(written).toContain('docs/02-Architecture/01-System-Overview.md');
    expect(written).toContain('docs/05-Modules/rag.md');
    expect(written).not.toContain('.anatoly/docs/');
  });

  it('skips missing_page when content_ref is unreadable', () => {
    const fs = memFs(); // no files at all
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/05-Modules/rag.md',
        path_user: 'docs/rag.md',
        content_ref: '.anatoly/docs/05-Modules/rag.md',
        rationale: 'Missing',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
  });

  // --- missing_section ---

  it('appends missing section to existing page', () => {
    const existingContent = '# Quick Start\n\n> Get up and running\n\n## Installation\n\nnpm install anatoly\n';
    const idealContent = '# Quick Start\n\n> Tutorial\n\n## Installation\n\nnpm install anatoly\n\n## First Run\n\nnpx anatoly\n';
    const fs = memFs({
      'docs/guides/getting-started.md': existingContent,
      '.anatoly/docs/01-Getting-Started/04-Quick-Start.md': idealContent,
    });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_section',
        path_ideal: '.anatoly/docs/01-Getting-Started/04-Quick-Start.md',
        path_user: 'docs/guides/getting-started.md',
        content_ref: '.anatoly/docs/01-Getting-Started/04-Quick-Start.md',
        rationale: 'Missing First Run section',
        priority: 'medium',
        section: '## First Run',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0].action).toBe('updated');
    expect(report.applied[0].before).toBe(existingContent);

    const updated = fs.store['docs/guides/getting-started.md'];
    // Existing content preserved
    expect(updated).toContain('## Installation');
    expect(updated).toContain('npm install anatoly');
    // New section appended
    expect(updated).toContain('## First Run');
    expect(updated).toContain('npx anatoly');
  });

  it('preserves all existing content when appending section', () => {
    const existingContent = '# My Page\n\nCustom intro by user.\n\n## Setup\n\nUser wrote this.\n';
    const idealContent = '# My Page\n\n> Summary\n\n## Setup\n\nGenerated setup.\n\n## Advanced\n\nAdvanced content.\n';
    const fs = memFs({
      'docs/guide.md': existingContent,
      '.anatoly/docs/03-Guides/02-Advanced-Configuration.md': idealContent,
    });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_section',
        path_ideal: '.anatoly/docs/03-Guides/02-Advanced-Configuration.md',
        path_user: 'docs/guide.md',
        content_ref: '.anatoly/docs/03-Guides/02-Advanced-Configuration.md',
        rationale: 'Missing Advanced section',
        priority: 'medium',
        section: '## Advanced',
      },
    ];

    const report = syncDocs(recs, fs);

    const updated = fs.store['docs/guide.md'];
    // Original content untouched
    expect(updated).toContain('Custom intro by user.');
    expect(updated).toContain('User wrote this.');
    // New section appended
    expect(updated).toContain('## Advanced');
    expect(updated).toContain('Advanced content.');
  });

  // --- outdated_content ---

  it('updates outdated section and adds clean loop comment', () => {
    const existingContent = '# Pipeline\n\n## Overview\n\nOld overview.\n\n## Data Flow\n\nOld flow diagram.\n';
    const idealContent = '# Data Flow\n\n## Overview\n\nNew overview.\n\n## Data Flow\n\nNew flow with mermaid.\n';
    const fs = memFs({
      'docs/architecture/pipeline.md': existingContent,
      '.anatoly/docs/02-Architecture/03-Data-Flow.md': idealContent,
    });
    const recs: DocRecommendation[] = [
      {
        type: 'outdated_content',
        path_ideal: '.anatoly/docs/02-Architecture/03-Data-Flow.md',
        path_user: 'docs/architecture/pipeline.md',
        content_ref: '.anatoly/docs/02-Architecture/03-Data-Flow.md',
        rationale: 'Data flow diagram references removed module',
        priority: 'medium',
        section: '## Data Flow',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0].action).toBe('updated');

    const updated = fs.store['docs/architecture/pipeline.md'];
    // Original overview preserved
    expect(updated).toContain('Old overview.');
    // Outdated section replaced
    expect(updated).toContain('New flow with mermaid.');
    expect(updated).not.toContain('Old flow diagram.');
    // Clean loop comment added
    expect(updated).toContain('<!-- Updated by clean loop: section refreshed to match current code -->');
  });

  // --- non-actionable types ---

  it('skips non-actionable recommendation types', () => {
    const fs = memFs();
    const recs: DocRecommendation[] = [
      { type: 'broken_link', path_ideal: 'x', path_user: 'y', content_ref: 'x', rationale: 'r', priority: 'low' },
      { type: 'missing_jsdoc', path_ideal: 'x', path_user: 'y', content_ref: 'x', rationale: 'r', priority: 'medium' },
      { type: 'incomplete_jsdoc', path_ideal: 'x', path_user: 'y', content_ref: 'x', rationale: 'r', priority: 'low' },
      { type: 'missing_index_entry', path_ideal: 'x', path_user: 'y', content_ref: 'x', rationale: 'r', priority: 'low' },
      { type: 'empty_page', path_ideal: 'x', path_user: 'y', content_ref: 'x', rationale: 'r', priority: 'medium' },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(0);
    expect(report.skipped).toHaveLength(5);
  });

  // --- before/after in results ---

  it('records before and after content in sync results', () => {
    const idealContent = '# New Page\n\nContent here.\n';
    const fs = memFs({
      '.anatoly/docs/05-Modules/cache.md': idealContent,
    });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/05-Modules/cache.md',
        path_user: 'docs/cache.md',
        content_ref: '.anatoly/docs/05-Modules/cache.md',
        rationale: 'Missing cache docs',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs);

    const result = report.applied[0] as SyncResult;
    expect(result.before).toBeNull();
    expect(result.after).toBe(idealContent);
  });

  // --- mixed recommendations ---

  it('processes mixed recommendations correctly', () => {
    const fs = memFs({
      '.anatoly/docs/05-Modules/scanner.md': '# Scanner\n\nScans files.\n',
      '.anatoly/docs/01-Getting-Started/04-Quick-Start.md': '# Quick Start\n\n## Intro\n\nHello.\n\n## Run\n\nnpx anatoly\n',
      'docs/guides/quick.md': '# Quick Start\n\n## Intro\n\nHello.\n',
    });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/05-Modules/scanner.md',
        path_user: 'docs/modules/scanner.md',
        content_ref: '.anatoly/docs/05-Modules/scanner.md',
        rationale: 'r1',
        priority: 'high',
      },
      {
        type: 'missing_section',
        path_ideal: '.anatoly/docs/01-Getting-Started/04-Quick-Start.md',
        path_user: 'docs/guides/quick.md',
        content_ref: '.anatoly/docs/01-Getting-Started/04-Quick-Start.md',
        rationale: 'r2',
        priority: 'medium',
        section: '## Run',
      },
      {
        type: 'broken_link',
        path_ideal: '.anatoly/docs/index.md',
        path_user: 'docs/index.md',
        content_ref: '.anatoly/docs/index.md',
        rationale: 'r3',
        priority: 'low',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(report.applied).toHaveLength(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.applied[0].path).toBe('docs/modules/scanner.md');
    expect(report.applied[1].path).toBe('docs/guides/quick.md');
  });

  // --- Story 29.19: configurable docs_path ---

  it('adapts .anatoly/docs/ links to custom docsPath', () => {
    const content = [
      '# Overview',
      '',
      'See [Architecture](.anatoly/docs/02-Architecture/01-System-Overview.md).',
    ].join('\n');
    const fs = memFs({ '.anatoly/docs/01-Getting-Started/01-Overview.md': content });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/01-Getting-Started/01-Overview.md',
        path_user: 'documentation/start/overview.md',
        content_ref: '.anatoly/docs/01-Getting-Started/01-Overview.md',
        rationale: 'Missing overview',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs, { docsPath: 'documentation' });

    const written = fs.store['documentation/start/overview.md'];
    expect(written).toContain('documentation/02-Architecture/01-System-Overview.md');
    expect(written).not.toContain('.anatoly/docs/');
    expect(written).not.toContain('docs/');
  });

  it('defaults link adaptation to docs/ when no docsPath specified', () => {
    const content = 'See [link](.anatoly/docs/05-Modules/rag.md).\n';
    const fs = memFs({ '.anatoly/docs/page.md': content });
    const recs: DocRecommendation[] = [
      {
        type: 'missing_page',
        path_ideal: '.anatoly/docs/page.md',
        path_user: 'docs/page.md',
        content_ref: '.anatoly/docs/page.md',
        rationale: 'r',
        priority: 'high',
      },
    ];

    const report = syncDocs(recs, fs);

    expect(fs.store['docs/page.md']).toContain('docs/05-Modules/rag.md');
  });
});
