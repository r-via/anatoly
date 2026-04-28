// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { renderInternalDocsContext } from './internal-docs-context.js';

describe('renderInternalDocsContext', () => {
  it('returns empty string when relevantDocs is undefined', () => {
    expect(renderInternalDocsContext(undefined)).toBe('');
  });

  it('returns empty string when relevantDocs has no internal docs', () => {
    const result = renderInternalDocsContext([
      { path: 'docs/api.md', content: '# API', source: 'project' },
    ]);
    expect(result).toBe('');
  });

  it('renders the section heading and ground-truth instruction', () => {
    const result = renderInternalDocsContext([
      { path: '.anatoly/docs/01-Getting-Started/01-Overview.md', content: '# Overview\nRTP=95%', source: 'internal' },
    ]);
    expect(result).toContain('## Internal Reference Documentation (project-level ground truth)');
    expect(result).toContain('authoritative');
    expect(result).toContain('Cite the page path');
  });

  it('includes each internal doc verbatim under its path heading', () => {
    const result = renderInternalDocsContext([
      { path: '.anatoly/docs/01-Getting-Started/01-Overview.md', content: 'Overview body', source: 'internal' },
      { path: '.anatoly/docs/02-Architecture/01-System.md', content: 'Arch body', source: 'internal' },
    ]);
    expect(result).toContain('### `.anatoly/docs/01-Getting-Started/01-Overview.md`');
    expect(result).toContain('Overview body');
    expect(result).toContain('### `.anatoly/docs/02-Architecture/01-System.md`');
    expect(result).toContain('Arch body');
  });

  it('filters out project docs even when mixed with internal docs', () => {
    const result = renderInternalDocsContext([
      { path: 'docs/api.md', content: 'project doc', source: 'project' },
      { path: '.anatoly/docs/01-Overview.md', content: 'internal doc', source: 'internal' },
    ]);
    expect(result).not.toContain('project doc');
    expect(result).toContain('internal doc');
  });

  it('handles docs with missing source field as non-internal', () => {
    const result = renderInternalDocsContext([
      { path: 'docs/api.md', content: 'no source field' },
    ]);
    expect(result).toBe('');
  });
});
