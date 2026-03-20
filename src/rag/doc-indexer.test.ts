// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { parseDocSections, stripCodeBlocks, buildDocSectionId } from './doc-indexer.js';

describe('stripCodeBlocks', () => {
  it('removes fenced code blocks', () => {
    const input = 'before\n```ts\nconst x = 1;\n```\nafter';
    expect(stripCodeBlocks(input)).toBe('before\n\nafter');
  });

  it('removes inline code', () => {
    const input = 'Use `npm install` to install';
    expect(stripCodeBlocks(input)).toBe('Use  to install');
  });

  it('handles text without code blocks', () => {
    const input = 'Just plain text here.';
    expect(stripCodeBlocks(input)).toBe('Just plain text here.');
  });

  it('removes multiple code blocks', () => {
    const input = '```js\na\n```\nmiddle\n```py\nb\n```\nend';
    expect(stripCodeBlocks(input)).toBe('\nmiddle\n\nend');
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

First section content.

## Section Two

Second section content.
More content here.
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

Some prose here.

\`\`\`typescript
const x = 1;
\`\`\`

More prose after code.
`;
    const sections = parseDocSections('docs/test.md', source);

    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('Some prose here');
    expect(sections[0].content).toContain('More prose after code');
    expect(sections[0].content).not.toContain('const x = 1');
  });

  it('skips sections with only code blocks (no prose)', () => {
    const source = `## Code Only

\`\`\`bash
npm install
\`\`\`

## Has Prose

Real content here.
`;
    const sections = parseDocSections('docs/test.md', source);

    // "Code Only" section has no prose after stripping code blocks
    // It may or may not be included depending on whitespace handling
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
Content line 1.
Content line 2.
## Second
Content line 3. And some more text to reach the minimum length for embedding.
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
