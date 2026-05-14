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
import type { ReferenceDoc } from './reference-docs-resolver.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLiteConfig(maxTokens = 12000): Config {
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

function makeRefDoc(overrides: Partial<ReferenceDoc> = {}): ReferenceDoc {
  return {
    source: overrides.source ?? 'md',
    path: overrides.path ?? 'docs/guide.md',
    content: overrides.content ?? 'Guide content here.',
    symbol: overrides.symbol,
    lang: overrides.lang,
  };
}

/** Wrapper that fails the test when the digest is null. */
async function buildOrFail(
  root: string,
  refs: ReferenceDoc[],
  config: Config,
): Promise<DigestResult> {
  const r = await buildInternalDocsDigest(root, refs, config);
  expect(r).not.toBeNull();
  return r!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildInternalDocsDigest', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'digest-test-'));
    mkdirSync(join(root, '.anatoly', 'cache'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- Shape ---

  it('returns a DigestResult with tokens, content, fingerprint, and incomplete', async () => {
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(typeof result.tokens).toBe('number');
    expect(typeof result.content).toBe('string');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof result.incomplete).toBe('boolean');
  });

  it('prepends `status: evaluated` frontmatter so the renderer treats it as authoritative', async () => {
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(result.content).toMatch(/^---\nstatus: evaluated\n/);
  });

  // --- Removed sections ---

  it('does NOT include a ## Modules section (covered by ctx.projectTree elsewhere)', async () => {
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(result.content).not.toContain('## Modules');
  });

  it('does NOT include a ## Public surface section (covered by reference docs / RAG elsewhere)', async () => {
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(result.content).not.toContain('## Public surface');
  });

  // --- Reference content section ---

  it('consolidates reference doc CONTENT (not just paths) under ## Reference content', async () => {
    const referenceDocs = [
      makeRefDoc({ path: 'docs/guide.md', content: 'Guide body that MUST appear in the digest.' }),
      makeRefDoc({ path: 'README.md', source: 'readme', content: 'Project readme body.' }),
    ];
    const result = await buildOrFail(root, referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Reference content');
    expect(result.content).toContain('docs/guide.md');
    expect(result.content).toContain('README.md');
    expect(result.content).toContain('Guide body that MUST appear in the digest.');
    expect(result.content).toContain('Project readme body.');
    // README has higher source priority than `md` — its block should appear first.
    expect(result.content.indexOf('README.md')).toBeLessThan(result.content.indexOf('docs/guide.md'));
  });

  it('contains ## Inline doc-comments when comments are present', async () => {
    const referenceDocs: ReferenceDoc[] = [
      { source: 'comment', path: 'src/foo.ts', content: 'Cleaned doc comment body', symbol: 'myFunc', lang: 'typescript' },
    ];
    const result = await buildOrFail(root, referenceDocs, makeLiteConfig());

    expect(result.content).toContain('## Inline doc-comments');
    expect(result.content).toContain('myFunc');
    expect(result.content).toContain('Cleaned doc comment body');
  });

  it('strips nested YAML frontmatter from reference doc bodies before embedding', async () => {
    const refs = [
      makeRefDoc({
        path: 'docs/page.md',
        content: '---\ntitle: Page\nauthor: someone\n---\nActual prose body of the page.',
      }),
    ];
    const result = await buildOrFail(root, refs, makeLiteConfig());
    expect(result.content).not.toContain('title: Page');
    expect(result.content).not.toContain('author: someone');
    expect(result.content).toContain('Actual prose body of the page.');
  });

  // --- Budget ---

  it('tokens <= max_tokens from config', async () => {
    const result = await buildOrFail(root, [makeRefDoc({ content: 'small body' })], makeLiteConfig(4000));
    expect(result.tokens).toBeLessThanOrEqual(4000);
  });

  it('makes no LLM calls (provider mock is untouched)', async () => {
    // If an LLM call were made, it would fail because there is no router.
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(result.content).toBeTruthy();
  });

  // --- Cache / determinism ---

  it('same inputs produce identical fingerprint and content', async () => {
    const refs = [makeRefDoc()];
    const r1 = await buildOrFail(root, refs, makeLiteConfig());
    const r2 = await buildOrFail(root, refs, makeLiteConfig());
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.content).toBe(r2.content);
  });

  it('second call serves from cache file (single YAML)', async () => {
    const first = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());

    const cachePath = join(root, '.anatoly', 'cache', 'internal-digest.yaml');
    const raw = readFileSync(cachePath, 'utf-8');
    const cached = yamlParse(raw);
    expect(cached).toHaveProperty('fingerprint');
    expect(cached).toHaveProperty('content');
    expect(cached).toHaveProperty('tokens');
    expect(cached).toHaveProperty('incomplete');
    expect(cached.content).toBe(first.content);
    expect(raw).toMatch(/^content: \|/m);

    const second = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(second).toEqual(first);
  });

  it('fingerprint invalidates when reference doc CONTENT changes', async () => {
    const r1 = await buildOrFail(root, [makeRefDoc({ content: 'first body' })], makeLiteConfig());
    const r2 = await buildOrFail(root, [makeRefDoc({ content: 'second body' })], makeLiteConfig());
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
    expect(r2.content).toContain('second body');
  });

  it('fingerprint invalidates when reference doc PATH changes', async () => {
    const r1 = await buildOrFail(root, [makeRefDoc({ path: 'a.md' })], makeLiteConfig());
    const r2 = await buildOrFail(root, [makeRefDoc({ path: 'b.md' })], makeLiteConfig());
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('fingerprint invalidates when max_tokens changes', async () => {
    const refs = [makeRefDoc()];
    const r1 = await buildOrFail(root, refs, makeLiteConfig(4000));
    const r2 = await buildOrFail(root, refs, makeLiteConfig(8000));
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('fingerprint is NOT affected by on_overflow when content fits within the budget', async () => {
    const refs = [makeRefDoc({ content: 'short body' })];
    const r1 = await buildOrFail(root, refs, makeLiteConfigWithOverflow(4000, 'warn'));
    const r2 = await buildOrFail(root, refs, makeLiteConfigWithOverflow(4000, 'fail'));
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  // --- Empty input ---

  it('returns null when there are no reference docs', async () => {
    const result = await buildInternalDocsDigest(root, [], makeLiteConfig());
    expect(result).toBeNull();
  });

  it('omits empty sections entirely (no "_No X found._" placeholders ever)', async () => {
    // Only md ref docs => no inline doc-comments. The inline section must be absent.
    const result = await buildOrFail(root, [makeRefDoc()], makeLiteConfig());
    expect(result.content).not.toContain('_No reference documents found._');
    expect(result.content).not.toContain('_No inline doc-comments found._');
    expect(result.content).not.toContain('## Inline doc-comments');
    expect(result.content).toContain('## Reference content');
  });

  // --- Overflow ---

  it('does NOT set incomplete when content fits within max_tokens', async () => {
    const result = await buildOrFail(root, [makeRefDoc({ content: 'short' })], makeLiteConfig());
    expect(result.incomplete).toBe(false);
    expect(result.content).not.toContain('> INCOMPLETE');
  });

  it('overflow with on_overflow=warn drops inline doc-comments first and ships an INCOMPLETE marker', async () => {
    // Budget chosen so reference content fits but doc-comments push us over.
    const config = makeLiteConfigWithOverflow(600, 'warn');
    const refs: ReferenceDoc[] = [
      { source: 'md', path: 'docs/guide.md', content: 'small body' },
    ];
    for (let i = 0; i < 30; i++) {
      refs.push({
        source: 'comment',
        path: `src/file${i}.ts`,
        content: 'A '.repeat(40),
        symbol: `sym${i}`,
        lang: 'typescript',
      });
    }
    const result = await buildOrFail(root, refs, config);

    expect(result.tokens).toBeLessThanOrEqual(600);
    expect(result.incomplete).toBe(true);
    expect(result.content).toContain('> INCOMPLETE');
    expect(result.content).toContain('max_tokens');
    expect(result.content).toContain('## Reference content');
    expect(result.content).toContain('docs/guide.md');
  });

  it('overflow with on_overflow=fail throws DigestOverflowError listing what was dropped', async () => {
    const config = makeLiteConfigWithOverflow(300, 'fail');
    const refs: ReferenceDoc[] = [];
    for (let i = 0; i < 20; i++) {
      refs.push(makeRefDoc({ path: `docs/file${i}.md`, content: 'A '.repeat(100) }));
    }
    await expect(buildInternalDocsDigest(root, refs, config)).rejects.toBeInstanceOf(DigestOverflowError);
  });

  it('respects max_tokens even when many reference docs are dropped (marker stays bounded)', async () => {
    const refs: ReferenceDoc[] = [];
    for (let i = 0; i < 30; i++) {
      refs.push(makeRefDoc({
        path: `docs/file${i}-with-a-relatively-long-name.md`,
        content: 'A '.repeat(200),
      }));
    }
    const config = makeLiteConfigWithOverflow(1000, 'warn');
    const result = await buildOrFail(root, refs, config);

    expect(result.tokens).toBeLessThanOrEqual(1000);
    expect(result.incomplete).toBe(true);
    expect(result.content).toContain('> INCOMPLETE');
    expect(result.content).toMatch(/(… and \d+ more|Dropped reference docs)/);
  });
});
