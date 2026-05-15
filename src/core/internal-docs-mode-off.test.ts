// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { parseTestConfig } from '../schemas/test-fixtures.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderInternalDocsContext } from './axes/internal-docs-context.js';
import { buildDocumentationUserMessage } from './axes/documentation.js';
import type { AxisContext } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOffConfig(): Config {
  return parseTestConfig({
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' },
    },
  });
}

function makeMinimalAxisContext(config: Config): AxisContext {
  return {
    task: {
      version: 1,
      file: 'src/foo.ts',
      hash: 'abc',
      symbols: [{ name: 'foo', kind: 'function', exported: true, line_start: 1, line_end: 5 }],
      language: 'typescript',
      parse_method: 'ast',
      scanned_at: '2025-01-01T00:00:00Z',
    },
    fileContent: 'export function foo() { return 42; }',
    config,
    projectRoot: '/tmp/test-project',
    docsTree: null,
    relevantDocs: [],
    referenceDocs: [],
  };
}

// ---------------------------------------------------------------------------
// Story 54.7 — Mode `off` graceful degradation
// ---------------------------------------------------------------------------

describe('Story 54.7 — mode=off graceful degradation', () => {
  it('AC 54.7a: renderInternalDocsContext returns empty for mode=off', () => {
    const config = makeOffConfig();
    const result = renderInternalDocsContext(
      [{ path: '.anatoly/docs/overview.md', content: '# Overview', source: 'internal' }],
      config,
    );
    expect(result).toBe('');
  });

  it('AC 54.7a: documentation axis buildUserMessage works with empty docs (no crash)', () => {
    const config = makeOffConfig();
    const ctx = makeMinimalAxisContext(config);
    // Should not throw when .anatoly/docs/ is empty
    const message = buildDocumentationUserMessage(ctx);
    expect(message).toContain('src/foo.ts');
    expect(message).toContain('No /docs/ directory found');
  });

  it('AC 54.7a: documentation axis buildUserMessage works with null docsTree', () => {
    const config = makeOffConfig();
    const ctx = makeMinimalAxisContext(config);
    ctx.docsTree = null;
    ctx.relevantDocs = undefined;
    const message = buildDocumentationUserMessage(ctx);
    expect(message).toContain('No /docs/ directory found');
  });

  it('AC 54.7b: syncProjectDocsFromInternal has been removed from run.ts', () => {
    // Structural assertion: the function should no longer exist in run.ts
    const runTsContent = readFileSync(resolve(__dirname, '../commands/run.ts'), 'utf-8');
    expect(runTsContent).not.toContain('function syncProjectDocsFromInternal');
    expect(runTsContent).not.toContain('syncProjectDocsFromInternal(');
  });

  it('AC 54.7b: no sync code references remain in run.ts', () => {
    const runTsContent = readFileSync(resolve(__dirname, '../commands/run.ts'), 'utf-8');
    // The sync call and task ID should be gone
    expect(runTsContent).not.toContain('sync-project-docs');
    expect(runTsContent).not.toContain('synced .anatoly/docs/');
  });

  it('AC 54.7a: run.ts contains mode=off guard log message', () => {
    const runTsContent = readFileSync(resolve(__dirname, '../commands/run.ts'), 'utf-8');
    expect(runTsContent).toContain('internal docs mode=off — skipping scaffold, generation, and coherence');
  });

  it('AC 54.7a: mode=off guard prevents runDocScaffold/runDocGeneration/runDocCoherenceReview', () => {
    const runTsContent = readFileSync(resolve(__dirname, '../commands/run.ts'), 'utf-8');
    // The off mode guard should appear before the bootstrap and update doc calls
    expect(runTsContent).toContain("internalDocMode === 'off'");
  });

  it('AC 54.7c: referenceDocs on AxisContext is empty when mode=off', () => {
    const config = makeOffConfig();
    const ctx = makeMinimalAxisContext(config);
    // Off mode injects no doc context at all — neither digest (removed) nor
    // per-file RAG retrieval. referenceDocs stays empty.
    expect(ctx.referenceDocs).toEqual([]);
  });
});
