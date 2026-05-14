// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTestConfig } from '../schemas/test-fixtures.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yamlParse } from 'yaml';
import { buildInternalDocsDigest, DigestOverflowError } from './internal-docs-digest.js';
import type { DigestResult } from './internal-docs-digest.js';
import type { Task } from '../schemas/task.js';
import type { ReferenceDoc } from './reference-docs-resolver.js';
import type { Config } from '../schemas/config.js';

/** Wrapper that fails the test when the digest is null. Used for the (vast)
 *  majority of cases where the fixture guarantees a non-empty digest. */
async function buildOrFail(
  root: string,
  tasks: Task[],
  refs: ReferenceDoc[],
  config: Config,
): Promise<DigestResult> {
  const r = await buildInternalDocsDigest(root, tasks, refs, config);
  expect(r).not.toBeNull();
  return r!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLiteConfig(maxTokens = 4000): Config {
  return parseTestConfig({
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: {
        mode: 'lite',
        lite: { max_tokens: maxTokens, refresh_on: ['code_change'], on_overflow: 'warn' },
      },
    },
  });
}

function makeLiteConfigWithOverflow(maxTokens: number, onOverflow: 'warn' | 'fail'): Config {
  return parseTestConfig({
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: {
        mode: 'lite',
        lite: { max_tokens: maxTokens, refresh_on: ['code_change'], on_overflow: onOverflow },
      },
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

    const result = await buildOrFail(root, tasks, referenceDocs, config);

    expect(result).toHaveProperty('tokens');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('fingerprint');
    expect(typeof result.tokens).toBe('number');
    expect(typeof result.content).toBe('string');
    expect(typeof result.fingerprint).toBe('string');
  });

  it('does NOT include a ## Modules section (covered by ctx.projectTree elsewhere)', async () => {
    const tasks = [
      makeTask({ file: 'src/utils/helper.ts' }),
      makeTask({ file: 'src/core/engine.ts', hash: 'def456', symbols: [{ name: 'Engine', kind: 'class', exported: true, line_start: 1, line_end: 50 }] }),
    ];
    const result = await buildOrFail(root, tasks, [], makeLiteConfig());

    expect(result.content).not.toContain('## Modules');
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
    const result = await buildOrFail(root, tasks, [], makeLiteConfig());

    expect(result.content).toContain('## Public surface');
    expect(result.content).toContain('helperFn');
    // Non-exported symbols should NOT appear in public surface
    expect(result.content).not.toMatch(/Public surface[\s\S]*internalFn/);
  });

  it('consolidates reference doc CONTENT (not just paths) under ## Reference content', async () => {
    const referenceDocs = [
      makeRefDoc({ path: 'docs/guide.md', content: 'Guide body that MUST appear in the digest.' }),
      makeRefDoc({ path: 'README.md', source: 'readme', content: 'Project readme body.' }),
    ];
    const result = await buildOrFail(root, [], referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Reference content');
    expect(result.content).toContain('docs/guide.md');
    expect(result.content).toContain('README.md');
    // Verbatim body must reach the digest (was the actual bug before this PR).
    expect(result.content).toContain('Guide body that MUST appear in the digest.');
    expect(result.content).toContain('Project readme body.');
    // README has higher source priority than `md` — its block should appear first.
    expect(result.content.indexOf('README.md')).toBeLessThan(result.content.indexOf('docs/guide.md'));
  });

  it('AC 54.6a: content contains ## Inline doc-comments section', async () => {
    const referenceDocs: ReferenceDoc[] = [
      { source: 'comment', path: 'src/foo.ts', content: 'Cleaned doc comment body', symbol: 'myFunc', lang: 'typescript' },
    ];
    const result = await buildOrFail(root, [makeTask()], referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Inline doc-comments');
    expect(result.content).toContain('myFunc');
    expect(result.content).toContain('Cleaned doc comment body');
  });

  // --- AC1: token bound ---

  it('AC 54.6a: tokens <= max_tokens from config', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig(4000);
    const result = await buildOrFail(root, tasks, [], config);

    expect(result.tokens).toBeLessThanOrEqual(4000);
  });

  // --- AC1: no LLM calls ---

  it('AC 54.6a: no LLM calls are made (provider mock is untouched)', async () => {
    // If an LLM call were made, it would fail because there is no router.
    // This test simply proves the function completes without any transport.
    const result = await buildOrFail(root, [makeTask()], [makeRefDoc()], makeLiteConfig());
    expect(result.content).toBeTruthy();
  });

  // --- AC1: fingerprint is SHA-256 ---

  it('AC 54.6a: fingerprint is a valid SHA-256 hex string', async () => {
    const result = await buildOrFail(root, [makeTask()], [], makeLiteConfig());
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  // --- AC2: cache / determinism ---

  it('AC 54.6b: same inputs produce identical fingerprint', async () => {
    const tasks = [makeTask()];
    const refs = [makeRefDoc()];
    const config = makeLiteConfig();

    const r1 = await buildOrFail(root, tasks, refs, config);
    const r2 = await buildOrFail(root, tasks, refs, config);

    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.content).toBe(r2.content);
  });

  it('AC 54.6b: second call serves from cache file (single YAML)', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig();

    const first = await buildOrFail(root, tasks, [], config);

    // Cache is a single YAML file with tokens + fingerprint + Markdown content.
    const cachePath = join(root, '.anatoly', 'cache', 'internal-digest.yaml');
    const raw = readFileSync(cachePath, 'utf-8');
    const cached = yamlParse(raw);
    expect(cached).toHaveProperty('fingerprint');
    expect(cached).toHaveProperty('content');
    expect(cached).toHaveProperty('tokens');
    expect(cached.content).toBe(first.content);
    // The Markdown content is rendered as a YAML block scalar (un-escaped, readable).
    expect(raw).toMatch(/^content: \|/m);

    // Second call reads from cache and returns the same result.
    const second = await buildOrFail(root, tasks, [], config);
    expect(second).toEqual(first);
  });

  // --- AC3: fingerprint invalidation on code change ---

  it('AC 54.6c: different task hash produces different fingerprint', async () => {
    const config = makeLiteConfig();
    const refs = [makeRefDoc()];

    const r1 = await buildOrFail(root, [makeTask({ hash: 'aaa' })], refs, config);
    const r2 = await buildOrFail(root, [makeTask({ hash: 'bbb' })], refs, config);

    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('AC 54.6c: different reference doc paths produce different fingerprint', async () => {
    const tasks = [makeTask()];
    const config = makeLiteConfig();

    const r1 = await buildOrFail(root, tasks, [makeRefDoc({ path: 'a.md' })], config);
    const r2 = await buildOrFail(root, tasks, [makeRefDoc({ path: 'b.md' })], config);

    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  // --- AC4: overflow handling (warn | fail) ---

  it('overflow with on_overflow=warn drops public-surface first and ships an INCOMPLETE marker', async () => {
    // Budget chosen so the small reference doc fits but the 50-task public surface forces overflow.
    const config = makeLiteConfigWithOverflow(600, 'warn');

    const tasks: Task[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(makeTask({
        file: `src/module${i}/file${i}.ts`,
        hash: `h${i}`,
        symbols: [{ name: `func${i}`, kind: 'function', exported: true, line_start: 1, line_end: 10 }],
      }));
    }
    const referenceDocs: ReferenceDoc[] = [
      { source: 'md', path: 'docs/guide.md', content: 'guide body' },
    ];

    const result = await buildOrFail(root, tasks, referenceDocs, config);

    expect(result.tokens).toBeLessThanOrEqual(600);
    expect(result.incomplete).toBe(true);
    expect(result.content).toContain('> INCOMPLETE');
    expect(result.content).toContain('max_tokens');
    // The reference content must survive — it's the highest priority slot.
    expect(result.content).toContain('## Reference content');
    expect(result.content).toContain('docs/guide.md');
  });

  it('overflow with on_overflow=fail throws DigestOverflowError listing what was dropped', async () => {
    const config = makeLiteConfigWithOverflow(300, 'fail');
    const tasks: Task[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(makeTask({
        file: `src/module${i}/file${i}.ts`,
        hash: `h${i}`,
        symbols: [{ name: `func${i}`, kind: 'function', exported: true, line_start: 1, line_end: 10 }],
      }));
    }
    await expect(
      buildInternalDocsDigest(root, tasks, [], config),
    ).rejects.toBeInstanceOf(DigestOverflowError);
  });

  it('does NOT set incomplete when content fits within max_tokens', async () => {
    const result = await buildOrFail(root, [makeTask()], [makeRefDoc({ content: 'short' })], makeLiteConfig());
    expect(result.incomplete).toBe(false);
    expect(result.content).not.toContain('> INCOMPLETE');
  });

  // --- Edge cases ---

  it('returns null when there is nothing authoritative to ship (no refs, no exports)', async () => {
    const result = await buildInternalDocsDigest(root, [], [], makeLiteConfig());
    // Empty digest => null. The caller (run.ts) sets ctx.internalDigest = null
    // and renderReferenceDocsContext skips injection — no empty "AUTHORITATIVE"
    // section in axis prompts.
    expect(result).toBeNull();
  });

  it('returns null when tasks have no exported symbols and no reference docs', async () => {
    const tasks = [makeTask({
      symbols: [
        { name: 'privateFn', kind: 'function', exported: false, line_start: 1, line_end: 10 },
      ],
    })];
    const result = await buildInternalDocsDigest(root, tasks, [], makeLiteConfig());
    expect(result).toBeNull();
  });

  // --- Regression: empty reference sections must not appear with placeholders ---

  it('omits empty sections entirely (no "_No X found._" placeholders ever)', async () => {
    const tasks = [
      makeTask({ file: 'src/a.ts' }),
      makeTask({ file: 'src/b.ts', hash: 'h2' }),
    ];
    const result = await buildOrFail(root, tasks, [], makeLiteConfig());

    expect(result.content).not.toContain('_No reference documents found._');
    expect(result.content).not.toContain('_No inline doc-comments found._');
    expect(result.content).not.toContain('## Reference content');
    expect(result.content).not.toContain('## Inline doc-comments');
    // Public surface (the only non-empty section here) IS kept.
    expect(result.content).toContain('## Public surface');
    expect(result.content).toContain('src/a.ts');
  });

  it('fingerprint invalidates when reference doc CONTENT changes (not only its path)', async () => {
    const r1 = await buildOrFail(root, [], [makeRefDoc({ content: 'first body' })], makeLiteConfig());
    const r2 = await buildOrFail(root, [], [makeRefDoc({ content: 'second body' })], makeLiteConfig());
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
    expect(r2.content).toContain('second body');
  });

  it('fingerprint is NOT affected by on_overflow when content fits within the budget', async () => {
    const refs = [makeRefDoc({ content: 'short body' })];
    const r1 = await buildOrFail(root, [makeTask()], refs, makeLiteConfigWithOverflow(4000, 'warn'));
    const r2 = await buildOrFail(root, [makeTask()], refs, makeLiteConfigWithOverflow(4000, 'fail'));
    // Same inputs + same budget => same content => same fingerprint, regardless
    // of on_overflow (which only governs behaviour during overflow).
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips nested YAML frontmatter from reference doc bodies before embedding', async () => {
    const refs = [
      makeRefDoc({
        path: 'docs/page.md',
        content: '---\ntitle: Page\nauthor: someone\n---\nActual prose body of the page.',
      }),
    ];
    const result = await buildOrFail(root, [], refs, makeLiteConfig());
    // The doc's own frontmatter (title/author) must NOT appear inside the digest
    // body — only the outer digest frontmatter is authoritative.
    expect(result.content).not.toContain('title: Page');
    expect(result.content).not.toContain('author: someone');
    expect(result.content).toContain('Actual prose body of the page.');
  });

  it('respects max_tokens even when many reference docs are dropped (marker stays bounded)', async () => {
    // Force overflow against a tight budget with 30 ref docs => the INCOMPLETE
    // marker would balloon if it listed every dropped path.
    const refs: ReferenceDoc[] = [];
    for (let i = 0; i < 30; i++) {
      refs.push(makeRefDoc({
        path: `docs/file${i}-with-a-relatively-long-name.md`,
        content: 'A '.repeat(200), // ~100 tokens per doc
      }));
    }
    const config = makeLiteConfigWithOverflow(1000, 'warn');
    const result = await buildOrFail(root, [], refs, config);

    expect(result.tokens).toBeLessThanOrEqual(1000);
    expect(result.incomplete).toBe(true);
    expect(result.content).toContain('> INCOMPLETE');
    // Marker enumerates at most 10 paths then summarises the tail.
    expect(result.content).toMatch(/(… and \d+ more|Dropped reference docs)/);
  });
});
