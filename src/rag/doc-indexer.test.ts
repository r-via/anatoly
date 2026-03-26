// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocSections, stripCodeBlocks, buildDocSectionId, splitIntoBatches, MAX_BATCH_CHARS, areDocTreesIdentical, remapDocPath } from './doc-indexer.js';
import type { DocSection } from './doc-indexer.js';

describe('stripCodeBlocks', () => {
  it('removes fenced code blocks', () => {
    const input = 'before\n```ts\nconst x = 1;\n```\nafter';
    expect(stripCodeBlocks(input)).toBe('before\n\nafter');
  });

  it('keeps inline code content but removes backticks', () => {
    const input = 'Use `npm install` to install';
    expect(stripCodeBlocks(input)).toBe('Use npm install to install');
  });

  it('handles text without code blocks', () => {
    const input = 'Just plain text here.';
    expect(stripCodeBlocks(input)).toBe('Just plain text here.');
  });

  it('removes multiple code blocks', () => {
    const input = '```js\na\n```\nmiddle\n```py\nb\n```\nend';
    expect(stripCodeBlocks(input)).toBe('middle\n\nend');
  });
});

describe('buildDocSectionId', () => {
  it('returns a deterministic 16-char hex string', () => {
    const id = buildDocSectionId('docs/01-Getting-Started/00-Vision.md', 'Mission');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(buildDocSectionId('docs/01-Getting-Started/00-Vision.md', 'Mission')).toBe(id);
  });

  it('returns different IDs for different inputs', () => {
    const id1 = buildDocSectionId('docs/a.md', 'Section A');
    const id2 = buildDocSectionId('docs/b.md', 'Section A');
    const id3 = buildDocSectionId('docs/a.md', 'Section B');
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe('parseDocSections', () => {
  it('parses H2 sections from markdown', () => {
    const source = `# Title

Some intro text.

## Section One

First section content that is long enough to pass the fifty character minimum threshold for inclusion.

## Section Two

Second section content with additional words to ensure it also passes the minimum prose length filter.
`;
    const sections = parseDocSections('docs/test.md', source);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Section One');
    expect(sections[0].content).toContain('First section content');
    expect(sections[0].filePath).toBe('docs/test.md');
    expect(sections[1].heading).toBe('Section Two');
    expect(sections[1].content).toContain('Second section content');
  });

  it('strips code blocks from section content', () => {
    const source = `## My Section

Some prose here that is long enough to pass the minimum character threshold for section inclusion in the index.

\`\`\`typescript
const x = 1;
\`\`\`

More prose after code to add even more length to this section content.
`;
    const sections = parseDocSections('docs/test.md', source);

    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('Some prose here');
    expect(sections[0].content).toContain('More prose after code');
  });

  it('skips sections with only code blocks (no prose)', () => {
    const source = `## Code Only

\`\`\`bash
npm install
\`\`\`

## Has Prose

Real content here that is long enough to pass the fifty character minimum threshold for section inclusion in the index.
`;
    const sections = parseDocSections('docs/test.md', source);

    // "Code Only" section has no prose after stripping code blocks — should be filtered out
    const proseSections = sections.filter((s) => s.content.length > 0);
    expect(proseSections).toHaveLength(1);
    expect(proseSections[0].heading).toBe('Has Prose');
  });

  it('returns empty for files without H2 headings', () => {
    const source = `# Title

Just a title and some text, no H2 sections.
`;
    const sections = parseDocSections('docs/test.md', source);
    expect(sections).toHaveLength(0);
  });

  it('records headings for sections', () => {
    const source = `# Title
## First
Content line 1 with enough text to pass the fifty character minimum threshold for inclusion.
Content line 2 with more text to be absolutely sure.
## Second
Content line 3 with enough text to also pass the fifty character minimum threshold for inclusion.
`;
    const sections = parseDocSections('docs/test.md', source);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('First');
    expect(sections[1].heading).toBe('Second');
  });

  it('handles H3+ headings within H2 sections', () => {
    const source = `## Main Section

### Subsection

Content under subsection.

#### Deep nested

More content.
`;
    const sections = parseDocSections('docs/test.md', source);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Main Section');
    expect(sections[0].content).toContain('Subsection');
    expect(sections[0].content).toContain('Content under subsection');
  });
});

// ---------------------------------------------------------------------------
// splitIntoBatches
// ---------------------------------------------------------------------------

function makeEntry(prose: string, originalIndex: number): { section: DocSection; prose: string; originalIndex: number } {
  return {
    section: { filePath: 'test.md', heading: `H${originalIndex}`, embedText: prose, content: prose },
    prose,
    originalIndex,
  };
}

describe('splitIntoBatches', () => {
  it('returns a single batch when total prose is under limit', () => {
    const entries = [
      makeEntry('a'.repeat(1000), 0),
      makeEntry('b'.repeat(1000), 1),
      makeEntry('c'.repeat(1000), 2),
    ];
    const batches = splitIntoBatches(entries);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('splits into multiple batches when total prose exceeds limit', () => {
    const entries = [
      makeEntry('a'.repeat(20_000), 0),
      makeEntry('b'.repeat(20_000), 1),
      makeEntry('c'.repeat(20_000), 2),
    ];
    const batches = splitIntoBatches(entries);
    // 20k + 20k = 40k > 30k, so second entry starts a new batch
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // All entries accounted for
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(3);
  });

  it('keeps a single oversized section in its own batch', () => {
    const entries = [
      makeEntry('x'.repeat(MAX_BATCH_CHARS + 5000), 0),
      makeEntry('y'.repeat(1000), 1),
    ];
    const batches = splitIntoBatches(entries);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].originalIndex).toBe(0);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0].originalIndex).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(splitIntoBatches([])).toHaveLength(0);
  });

  it('preserves original indices across batches', () => {
    const entries = [
      makeEntry('a'.repeat(16_000), 2),
      makeEntry('b'.repeat(16_000), 5),
      makeEntry('c'.repeat(16_000), 8),
    ];
    const batches = splitIntoBatches(entries);
    const allIndices = batches.flatMap(b => b.map(e => e.originalIndex));
    expect(allIndices).toEqual([2, 5, 8]);
  });
});

// ---------------------------------------------------------------------------
// areDocTreesIdentical
// ---------------------------------------------------------------------------

describe('areDocTreesIdentical', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `anatoly-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createFile(dir: string, relPath: string, content: string) {
    const fullDir = join(dir, relPath, '..');
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(join(dir, relPath), content, 'utf-8');
  }

  it('returns true when both dirs do not exist', () => {
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(true);
  });

  it('returns false when only project docs exist', () => {
    mkdirSync(join(tmpRoot, 'docs'), { recursive: true });
    createFile(tmpRoot, 'docs/readme.md', '# Hello');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });

  it('returns false when only internal docs exist', () => {
    mkdirSync(join(tmpRoot, '.anatoly/docs'), { recursive: true });
    createFile(tmpRoot, '.anatoly/docs/readme.md', '# Hello');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });

  it('returns true when both dirs exist but have no .md files', () => {
    mkdirSync(join(tmpRoot, 'docs'), { recursive: true });
    mkdirSync(join(tmpRoot, '.anatoly/docs'), { recursive: true });
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(true);
  });

  it('returns true when identical trees with single file', () => {
    const content = '# Architecture\n\nSome content here.';
    createFile(tmpRoot, 'docs/arch.md', content);
    createFile(tmpRoot, '.anatoly/docs/arch.md', content);
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(true);
  });

  it('returns true when identical trees with nested structure', () => {
    const files = {
      '01-Getting-Started/intro.md': '# Intro\nWelcome.',
      '02-Architecture/overview.md': '# Overview\nArchitecture docs.',
      '02-Architecture/details.md': '# Details\nMore info.',
    };
    for (const [path, content] of Object.entries(files)) {
      createFile(tmpRoot, `docs/${path}`, content);
      createFile(tmpRoot, `.anatoly/docs/${path}`, content);
    }
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(true);
  });

  it('returns false when one file differs in content', () => {
    createFile(tmpRoot, 'docs/readme.md', '# Version 1');
    createFile(tmpRoot, '.anatoly/docs/readme.md', '# Version 2');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });

  it('returns false when extra file in project docs', () => {
    const content = '# Same';
    createFile(tmpRoot, 'docs/shared.md', content);
    createFile(tmpRoot, '.anatoly/docs/shared.md', content);
    createFile(tmpRoot, 'docs/extra.md', '# Extra');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });

  it('returns false when extra file in internal docs', () => {
    const content = '# Same';
    createFile(tmpRoot, 'docs/shared.md', content);
    createFile(tmpRoot, '.anatoly/docs/shared.md', content);
    createFile(tmpRoot, '.anatoly/docs/extra.md', '# Extra');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });

  it('returns false for files with same name but different sizes', () => {
    createFile(tmpRoot, 'docs/readme.md', 'short');
    createFile(tmpRoot, '.anatoly/docs/readme.md', 'a much longer content string that differs in size');
    expect(areDocTreesIdentical(tmpRoot, 'docs', '.anatoly/docs')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// remapDocPath
// ---------------------------------------------------------------------------

describe('remapDocPath', () => {
  it('remaps from internal to project path', () => {
    expect(remapDocPath('.anatoly/docs/02-Arch/foo.md', '.anatoly/docs', 'docs')).toBe('docs/02-Arch/foo.md');
  });

  it('handles trailing slashes on prefixes', () => {
    expect(remapDocPath('.anatoly/docs/bar.md', '.anatoly/docs/', 'docs/')).toBe('docs/bar.md');
  });

  it('returns original path if prefix does not match', () => {
    expect(remapDocPath('other/path.md', '.anatoly/docs', 'docs')).toBe('other/path.md');
  });

  it('handles exact prefix match (no subpath)', () => {
    expect(remapDocPath('.anatoly/docs', '.anatoly/docs', 'docs')).toBe('docs');
  });

  it('remaps from project to internal path', () => {
    expect(remapDocPath('docs/modules/rag.md', 'docs', '.anatoly/docs')).toBe('.anatoly/docs/modules/rag.md');
  });
});
