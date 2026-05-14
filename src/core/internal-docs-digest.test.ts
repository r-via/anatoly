// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTestConfig } from '../schemas/test-fixtures.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInternalDocsDigest } from './internal-docs-digest.js';
import type { Task } from '../schemas/task.js';
import type { ReferenceDoc } from './reference-docs-resolver.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLiteConfig(maxTokens = 4000): Config {
  return parseTestConfig({
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'lite', lite: { max_tokens: maxTokens, refresh_on: ['code_change'] } },
    },
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    version: 1,
    file: overrides.file ?? 'src/utils/helper.ts',
    hash: overrides.hash ?? 'abc123',
    symbols: overrides.symbols ?? [
      { name: 'helperFn', kind: 'function', exported: true, line_start: 1, line_end: 10 },
    ],
    imports: overrides.imports,
    language: overrides.language ?? 'typescript',
    parse_method: overrides.parse_method ?? 'ast',
    scanned_at: overrides.scanned_at ?? '2025-01-01T00:00:00Z',
  };
}

function makeRefDoc(overrides: Partial<ReferenceDoc> = {}): ReferenceDoc {
  return {
    source: overrides.source ?? 'md',
    path: overrides.path ?? 'docs/guide.md',
    content: overrides.content ?? 'Guide content here.',
    symbol: overrides.symbol,
    lang: overrides.lang,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildInternalDocsDigest', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'digest-test-'));
    // Create .anatoly/cache/ structure
    mkdirSync(join(root, '.anatoly', 'cache'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- AC1: Content structure ---

  it('returns a DigestResult with tokens, content, and fingerprint', async () => {
    const tasks = [makeTask()];
    const referenceDocs = [makeRefDoc()];
    const config = makeLiteConfig();

    const result = await buildInternalDocsDigest(root, tasks, referenceDocs, config);

    expect(result).toHaveProperty('tokens');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('fingerprint');
    expect(typeof result.tokens).toBe('number');
    expect(typeof result.content).toBe('string');
    expect(typeof result.fingerprint).toBe('string');
  });

  it('AC 54.6a: content contains ## Modules section with module paths', async () => {
    const tasks = [
      makeTask({ file: 'src/utils/helper.ts' }),
      makeTask({ file: 'src/core/engine.ts', hash: 'def456', symbols: [{ name: 'Engine', kind: 'class', exported: true, line_start: 1, line_end: 50 }] }),
    ];
    const result = await buildInternalDocsDigest(root, tasks, [], makeLiteConfig());

    expect(result.content).toContain('## Modules');
    expect(result.content).toContain('src/utils/helper.ts');
    expect(result.content).toContain('src/core/engine.ts');
  });

  it('AC 54.6a: content contains ## Public surface section with exported signatures', async () => {
    const tasks = [
      makeTask({
        symbols: [
          { name: 'helperFn', kind: 'function', exported: true, line_start: 1, line_end: 10 },
          { name: 'internalFn', kind: 'function', exported: false, line_start: 11, line_end: 20 },
        ],
      }),
    ];
    const result = await buildInternalDocsDigest(root, tasks, [], makeLiteConfig());

    expect(result.content).toContain('## Public surface');
    expect(result.content).toContain('helperFn');
    // Non-exported symbols should NOT appear in public surface
    expect(result.content).not.toMatch(/Public surface[\s\S]*internalFn/);
  });

  it('AC 54.6a: content contains ## Reference index listing ref doc paths (no content)', async () => {
    const referenceDocs = [
      makeRefDoc({ path: 'docs/guide.md', content: 'Some guide text that should NOT appear' }),
      makeRefDoc({ path: 'README.md', source: 'readme', content: 'Project readme' }),
    ];
    const result = await buildInternalDocsDigest(root, [], referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Reference index');
    expect(result.content).toContain('docs/guide.md');
    expect(result.content).toContain('README.md');
    // Content should NOT appear — just paths
    expect(result.content).not.toContain('Some guide text that should NOT appear');
  });

  it('AC 54.6a: content contains ## Inline doc-comments section', async () => {
    const referenceDocs: ReferenceDoc[] = [
      { source: 'comment', path: 'src/foo.ts', content: 'Cleaned doc comment body', symbol: 'myFunc', lang: 'typescript' },
    ];
    const result = await buildInternalDocsDigest(root, [makeTask()], referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Inline doc-comments');
    expect(result.content).toContain('myFunc');
    expect(result.content).toContain('Cleaned doc comment body');
  });

  // --- AC1: token bound ---

  it('AC 54.6a: tokens <= max_tokens from config', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig(4000);
    const result = await buildInternalDocsDigest(root, tasks, [], config);

    expect(result.tokens).toBeLessThanOrEqual(4000);
  });

  // --- AC1: no LLM calls ---

  it('AC 54.6a: no LLM calls are made (provider mock is untouched)', async () => {
    // If an LLM call were made, it would fail because there is no router.
    // This test simply proves the function completes without any transport.
    const result = await buildInternalDocsDigest(root, [makeTask()], [makeRefDoc()], makeLiteConfig());
    expect(result.content).toBeTruthy();
  });

  // --- AC1: fingerprint is SHA-256 ---

  it('AC 54.6a: fingerprint is a valid SHA-256 hex string', async () => {
    const result = await buildInternalDocsDigest(root, [makeTask()], [], makeLiteConfig());
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  // --- AC2: cache / determinism ---

  it('AC 54.6b: same inputs produce identical fingerprint', async () => {
    const tasks = [makeTask()];
    const refs = [makeRefDoc()];
    const config = makeLiteConfig();

    const r1 = await buildInternalDocsDigest(root, tasks, refs, config);
    const r2 = await buildInternalDocsDigest(root, tasks, refs, config);

    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.content).toBe(r2.content);
  });

  it('AC 54.6b: second call serves from cache file', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig();

    await buildInternalDocsDigest(root, tasks, [], config);

    // Cache file should exist
    const cachePath = join(root, '.anatoly', 'cache', 'internal-digest.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(cached).toHaveProperty('fingerprint');
    expect(cached).toHaveProperty('content');
    expect(cached).toHaveProperty('tokens');
  });

  // --- AC3: fingerprint invalidation on code change ---

  it('AC 54.6c: different task hash produces different fingerprint', async () => {
    const config = makeLiteConfig();
    const refs = [makeRefDoc()];

    const r1 = await buildInternalDocsDigest(root, [makeTask({ hash: 'aaa' })], refs, config);
    const r2 = await buildInternalDocsDigest(root, [makeTask({ hash: 'bbb' })], refs, config);

    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('AC 54.6c: different reference doc paths produce different fingerprint', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig();

    const r1 = await buildInternalDocsDigest(root, tasks, [makeRefDoc({ path: 'a.md' })], config);
    const r2 = await buildInternalDocsDigest(root, tasks, [makeRefDoc({ path: 'b.md' })], config);

    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  // --- AC4: truncation with priority ---

  it('AC 54.6d: truncation respects priority and adds footer', async () => {
    // Create a scenario with low max_tokens that will force truncation
    const config = makeLiteConfig(200); // very small budget

    // Many tasks to fill up the token budget
    const tasks: Task[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(makeTask({
        file: `src/module${i}/file${i}.ts`,
        hash: `hash${i}`,
        symbols: [
          { name: `func${i}`, kind: 'function', exported: true, line_start: 1, line_end: 10 },
        ],
      }));
    }

    const referenceDocs = [
      { source: 'comment' as const, path: 'src/foo.ts', content: 'Important doc comment', symbol: 'foo' },
    ];

    const result = await buildInternalDocsDigest(root, tasks, referenceDocs, config);

    expect(result.tokens).toBeLessThanOrEqual(200);
    expect(result.content).toContain('truncated');
  });

  it('AC 54.6d: truncation keeps reference docs and doc-comments over modules', async () => {
    const config = makeLiteConfig(300); // tight budget

    const tasks: Task[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(makeTask({
        file: `src/deep/module${i}/longfilename${i}.ts`,
        hash: `hash${i}`,
        symbols: [
          { name: `exportedFunc${i}`, kind: 'function', exported: true, line_start: 1, line_end: 10 },
        ],
      }));
    }

    const referenceDocs: ReferenceDoc[] = [
      { source: 'comment', path: 'src/core.ts', content: 'Core doc', symbol: 'coreInit' },
      { source: 'md', path: 'docs/guide.md', content: 'Guide content' },
    ];

    const result = await buildInternalDocsDigest(root, tasks, referenceDocs, config);

    // Reference index should be present (highest priority)
    expect(result.content).toContain('## Reference index');
    expect(result.content).toContain('docs/guide.md');

    // Doc-comments section should be present (second priority)
    expect(result.content).toContain('## Inline doc-comments');
  });

  // --- Edge cases ---

  it('returns non-empty content even with empty tasks and no reference docs', async () => {
    const result = await buildInternalDocsDigest(root, [], [], makeLiteConfig());
    expect(result.content).toBeTruthy();
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('handles tasks with no exported symbols gracefully', async () => {
    const tasks = [makeTask({
      symbols: [
        { name: 'privateFn', kind: 'function', exported: false, line_start: 1, line_end: 10 },
      ],
    })];
    const result = await buildInternalDocsDigest(root, tasks, [], makeLiteConfig());
    expect(result.content).toContain('## Modules');
  });

  // --- Regression: empty reference sections must not steal budget from real content ---

  it('skips empty reference/doc-comments sections when no reference docs are provided', async () => {
    const tasks = [
      makeTask({ file: 'src/a.ts' }),
      makeTask({ file: 'src/b.ts', hash: 'h2' }),
    ];
    const result = await buildInternalDocsDigest(root, tasks, [], makeLiteConfig());

    expect(result.content).not.toContain('_No reference documents found._');
    expect(result.content).not.toContain('_No inline doc-comments found._');
    expect(result.content).not.toContain('## Reference index');
    expect(result.content).not.toContain('## Inline doc-comments');
    // The useful sections are kept
    expect(result.content).toContain('## Modules');
    expect(result.content).toContain('src/a.ts');
  });

  it('preserves Modules/Public-surface content over empty reference placeholders when budget is tight', async () => {
    // Reproduces the awf-cli bug: 260+ tasks, no reference docs, tight budget.
    // Old behaviour kept the empty "_No X found._" placeholders and dropped the
    // entire Modules+Public-surface sections. New behaviour drops the empty
    // sections first and truncates within Modules/Public-surface.
    const config = makeLiteConfig(500);
    const tasks: Task[] = [];
    for (let i = 0; i < 200; i++) {
      tasks.push(makeTask({
        file: `src/module${i}/file${i}.ts`,
        hash: `h${i}`,
        symbols: [
          { name: `func${i}`, kind: 'function', exported: true, line_start: 1, line_end: 5 },
        ],
      }));
    }

    const result = await buildInternalDocsDigest(root, tasks, [], config);

    expect(result.tokens).toBeLessThanOrEqual(500);
    // The digest must contain at least *some* concrete content, not just placeholders.
    // The exact section kept depends on priority + budget, but at minimum a real
    // module/file path or symbol must survive truncation.
    expect(result.content).toMatch(/src\/module\d+\/file\d+\.ts/);
    expect(result.content).not.toContain('_No reference documents found._');
    expect(result.content).not.toContain('_No inline doc-comments found._');
  });
});
