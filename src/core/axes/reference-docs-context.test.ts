// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { renderReferenceDocsContext } from './reference-docs-context.js';
import type { ReferenceDoc } from '../documentation/index.js';

describe('renderReferenceDocsContext', () => {
  it('returns empty string when referenceDocs is empty', () => {
    expect(renderReferenceDocsContext([])).toBe('');
  });

  it('returns empty string when referenceDocs is null/undefined', () => {
    expect(renderReferenceDocsContext(null as unknown as ReferenceDoc[])).toBe('');
    expect(renderReferenceDocsContext(undefined as unknown as ReferenceDoc[])).toBe('');
  });

  it('AC 54.5a: renders AUTHORITATIVE heading and instruction', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];
    const result = renderReferenceDocsContext(docs);
    expect(result).toContain('## REFERENCE DOCUMENTATION (AUTHORITATIVE');
    expect(result).toContain('human-authored');
    expect(result).toContain('ground truth');
    expect(result).toContain('doc_divergence');
  });

  it('AC 54.5a: renders each doc with source, path, and symbol', () => {
    const docs: ReferenceDoc[] = [
      { source: 'md', path: 'docs/guide.md', content: 'Guide content' },
      { source: 'comment', path: 'src/foo.ts', content: 'Cleaned doc comment', symbol: 'foo', lang: 'typescript' },
    ];
    const result = renderReferenceDocsContext(docs);
    expect(result).toContain('docs/guide.md');
    expect(result).toContain('source: md');
    expect(result).toContain('Guide content');
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('symbol: foo');
    expect(result).toContain('Cleaned doc comment');
  });

  it('AC 54.5d: REFERENCE block appears with authoritative marking', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: 'Function X must never return null.' },
    ];
    const result = renderReferenceDocsContext(docs);
    expect(result).toContain('AUTHORITATIVE');
    expect(result).toContain('Function X must never return null.');
  });
});
