// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInternalDocsDigest } from './internal-docs-digest.js';
import { renderReferenceDocsContext } from './axes/reference-docs-context.js';
import { parseTestConfig } from '../schemas/test-fixtures.js';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import type { ReferenceDoc } from './reference-docs-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'digest-eval-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    version: 1,
    file: 'src/foo.ts',
    hash: 'abc123',
    symbols: [{ name: 'doThing', kind: 'function', exported: true, line_start: 1, line_end: 10 }],
    language: 'typescript',
    parse_method: 'ast',
    scanned_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRefDoc(overrides: Partial<ReferenceDoc> = {}): ReferenceDoc {
  return {
    source: 'readme',
    path: 'README.md',
    content: '# Project\nThis is the main project.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Story 55.5 — AC1: digest frontmatter
// ---------------------------------------------------------------------------

describe('Story 55.5 — AC1: lite digest has evaluated frontmatter', () => {
  it('digest content includes status: evaluated frontmatter', async () => {
    const result = await buildInternalDocsDigest(tmpDir, [makeRefDoc()], makeLiteConfig());
    expect(result).not.toBeNull();
    expect(result!.content).toContain('status: evaluated');
  });

  it('digest content includes source: reference-digest frontmatter', async () => {
    const result = await buildInternalDocsDigest(tmpDir, [makeRefDoc()], makeLiteConfig());
    expect(result).not.toBeNull();
    expect(result!.content).toContain('source: reference-digest');
  });

  it('frontmatter is at the beginning of the content', async () => {
    const result = await buildInternalDocsDigest(tmpDir, [makeRefDoc()], makeLiteConfig());
    expect(result).not.toBeNull();
    expect(result!.content).toMatch(/^---\n/);
    expect(result!.content).toMatch(/\n---\n/);
  });
});

// ---------------------------------------------------------------------------
// Story 55.5 — AC2: renderReferenceDocsContext recognizes evaluated digest
// ---------------------------------------------------------------------------

describe('Story 55.5 — AC2: renderReferenceDocsContext injects evaluated digest', () => {
  it('renders digest in reference section when status is evaluated', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];
    const digest = {
      tokens: 100,
      content: '---\nstatus: evaluated\nsource: reference-digest\n---\n## Modules\n- src/foo.ts',
      fingerprint: 'abc',
    };

    const result = renderReferenceDocsContext(docs, digest);
    expect(result).toContain('REFERENCE DOCUMENTATION');
    expect(result).toContain('## Modules');
    expect(result).toContain('reference-digest');
  });

  it('does NOT render digest when internalDigest is null', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];

    const result = renderReferenceDocsContext(docs, null);
    expect(result).toContain('REFERENCE DOCUMENTATION');
    expect(result).not.toContain('reference-digest');
  });

  it('does NOT render digest without evaluated frontmatter', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];
    const digest = {
      tokens: 100,
      content: '## Modules\n- src/foo.ts',
      fingerprint: 'abc',
    };

    const result = renderReferenceDocsContext(docs, digest);
    expect(result).not.toContain('LITE-MODE REFERENCE DIGEST');
  });

  it('backward compatible: works without digest parameter', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];

    const result = renderReferenceDocsContext(docs);
    expect(result).toContain('REFERENCE DOCUMENTATION');
    expect(result).toContain('# Project');
  });
});
