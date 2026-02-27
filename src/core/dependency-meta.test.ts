import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadDependencyMeta, extractFileDeps, extractRelevantReadmeSections, parseReadmeSections, scoreSection } from './dependency-meta.js';
import type { DependencyMeta } from './dependency-meta.js';

describe('loadDependencyMeta', () => {
  it('should load dependencies from a real package.json', () => {
    const meta = loadDependencyMeta(resolve('.'));
    expect(meta).toBeDefined();
    expect(meta!.dependencies.size).toBeGreaterThan(0);
    // The project itself uses commander
    expect(meta!.dependencies.has('commander')).toBe(true);
  });

  it('should return undefined for a missing package.json', () => {
    const meta = loadDependencyMeta('/nonexistent/path');
    expect(meta).toBeUndefined();
  });

  it('should merge dependencies and devDependencies', () => {
    const meta = loadDependencyMeta(resolve('.'));
    expect(meta).toBeDefined();
    // vitest is a devDependency
    expect(meta!.dependencies.has('vitest')).toBe(true);
    // commander is a dependency
    expect(meta!.dependencies.has('commander')).toBe(true);
  });
});

describe('extractFileDeps', () => {
  const meta: DependencyMeta = {
    dependencies: new Map([
      ['commander', '^14.0.3'],
      ['zod', '^3.22.0'],
      ['express', '^4.18.0'],
      ['@anthropic-ai/claude-agent-sdk', '^0.1.0'],
    ]),
    engines: { node: '>=20.19' },
  };

  it('should extract bare imports matching project dependencies', () => {
    const content = `import type { Command } from 'commander';
import { z } from 'zod';
export function foo() {}`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should handle scoped packages', () => {
    const content = `import { query } from '@anthropic-ai/claude-agent-sdk';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: '@anthropic-ai/claude-agent-sdk', version: '^0.1.0' },
    ]);
  });

  it('should handle subpath imports', () => {
    const content = `import { something } from 'zod/v4';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should filter out node: builtins', () => {
    const content = `import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should deduplicate multiple imports from the same package', () => {
    const content = `import type { Command } from 'commander';
import { Option } from 'commander';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
    ]);
  });

  it('should return empty deps when no npm imports found', () => {
    const content = `import { resolve } from 'node:path';
import { foo } from './local.js';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([]);
  });

  it('should skip imports not in project dependencies', () => {
    const content = `import { something } from 'unknown-pkg';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([]);
  });

  it('should include nodeEngine when available', () => {
    const content = `import { z } from 'zod';`;
    const result = extractFileDeps(content, meta);
    expect(result.nodeEngine).toBe('>=20.19');
  });

  it('should omit nodeEngine when not available', () => {
    const metaNoEngine: DependencyMeta = {
      dependencies: new Map([['zod', '^3.22.0']]),
    };
    const content = `import { z } from 'zod';`;
    const result = extractFileDeps(content, metaNoEngine);
    expect(result.nodeEngine).toBeUndefined();
  });

  it('should handle type-only imports', () => {
    const content = `import type { Command } from 'commander';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
    ]);
  });

  it('should handle export-from statements', () => {
    const content = `export { z } from 'zod';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });
});

describe('parseReadmeSections', () => {
  it('should split a multi-section markdown document', () => {
    const md = `# Title

Intro paragraph.

## Section A

Content A.

## Section B

Content B.

### Subsection B1

Sub-content.
`;
    const sections = parseReadmeSections(md);
    expect(sections).toHaveLength(4);
    expect(sections[0].heading).toBe('Title');
    expect(sections[0].level).toBe(1);
    expect(sections[1].heading).toBe('Section A');
    expect(sections[1].level).toBe(2);
    expect(sections[2].heading).toBe('Section B');
    expect(sections[3].heading).toBe('Subsection B1');
    expect(sections[3].level).toBe(3);
  });

  it('should return a single section for headingless content', () => {
    const md = `Just some text without headings.

More text here.`;
    const sections = parseReadmeSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('');
    expect(sections[0].content).toContain('Just some text');
  });

  it('should preserve startOffset for each section', () => {
    const md = `# First

Body.

## Second

Body 2.`;
    const sections = parseReadmeSections(md);
    expect(sections[0].startOffset).toBe(0);
    expect(sections[1].startOffset).toBeGreaterThan(0);
  });
});

describe('scoreSection', () => {
  it('should give heading matches higher weight than body matches', () => {
    const headingMatch = {
      heading: 'Error handling',
      level: 2,
      content: '## Error handling\n\nSome content.',
      startOffset: 0,
    };
    const bodyMatch = {
      heading: 'Introduction',
      level: 2,
      content: '## Introduction\n\nSomething about error handling.',
      startOffset: 0,
    };

    const headingScore = scoreSection(headingMatch, ['error']);
    const bodyScore = scoreSection(bodyMatch, ['error']);
    expect(headingScore).toBeGreaterThan(bodyScore);
  });

  it('should return 0 for sections with no keyword matches', () => {
    const section = {
      heading: 'Installation',
      level: 2,
      content: '## Installation\n\nnpm install foo',
      startOffset: 0,
    };
    expect(scoreSection(section, ['async', 'error'])).toBe(0);
  });

  it('should cap body occurrences at 3 per keyword', () => {
    const section = {
      heading: 'Details',
      level: 2,
      content: '## Details\n\nerror error error error error error error',
      startOffset: 0,
    };
    // 3 body matches capped, no heading match
    expect(scoreSection(section, ['error'])).toBe(3);
  });
});

describe('extractRelevantReadmeSections', () => {
  it('should return full content for small READMEs', () => {
    // zod's README is likely smaller than 12000 chars or large — use a known small package
    const result = extractRelevantReadmeSections(resolve('.'), 'commander', ['anything'], 200_000);
    // With 200K budget, should return the full content without extraction note
    if (result) {
      expect(result).not.toContain('[Sections extracted');
    }
  });

  it('should return null for missing packages', () => {
    const result = extractRelevantReadmeSections(resolve('.'), 'nonexistent-pkg-xyz', ['error']);
    expect(result).toBeNull();
  });

  it('should select relevant sections for large READMEs', () => {
    // Commander's README is ~43KB, well above 12K default
    const result = extractRelevantReadmeSections(
      resolve('.'),
      'commander',
      ['async', 'action', 'parseasync', 'error', 'handler'],
    );
    expect(result).not.toBeNull();
    expect(result).toContain('[Sections extracted');
    // Should include the Action handler section
    expect(result).toContain('Action handler');
    // Should include parseAsync info
    expect(result).toContain('parseAsync');
  });

  it('should always include the intro section', () => {
    const result = extractRelevantReadmeSections(
      resolve('.'),
      'commander',
      ['async', 'action'],
    );
    expect(result).not.toBeNull();
    // Commander's intro starts with the title
    expect(result).toContain('Commander');
  });
});
