// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { parseTestConfig } from '../../../schemas/test-fixtures.js';
import { renderInternalDocsContext } from './internal-docs-context.js';
import type { Config } from '../../../schemas/config.js';

function makeConfig(mode: 'full' | 'lite' | 'off' = 'full'): Config {
  const base: Record<string, unknown> & { documentation: Record<string, unknown> } = {
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode },
    },
  };
  const doc = base.documentation as Record<string, Record<string, unknown>>;
  if (mode === 'full') doc.internal.full = { sync_to_repo: false };
  if (mode === 'lite') doc.internal.lite = { max_tokens: 4000, refresh_on: ['code_change'] };
  return parseTestConfig(base);
}

describe('renderInternalDocsContext', () => {
  it('returns empty string when relevantDocs is undefined', () => {
    expect(renderInternalDocsContext(undefined, makeConfig('full'))).toBe('');
  });

  it('returns empty string when relevantDocs has no internal docs', () => {
    const result = renderInternalDocsContext(
      [{ path: 'docs/api.md', content: '# API', source: 'project' }],
      makeConfig('full'),
    );
    expect(result).toBe('');
  });

  it('AC 54.5b: renders the DERIVED section heading (not authoritative)', () => {
    const result = renderInternalDocsContext(
      [{ path: '.anatoly/docs/overview.md', content: '# Overview', source: 'internal' }],
      makeConfig('full'),
    );
    expect(result).toContain('## INTERNAL DOCUMENTATION (DERIVED FROM CODE — context only, not ground truth)');
    expect(result).toContain('Do NOT use this section to flag code');
    expect(result).toContain('reference wins');
  });

  it('AC 54.5d: does NOT contain "authoritative" anywhere', () => {
    const result = renderInternalDocsContext(
      [{ path: '.anatoly/docs/overview.md', content: '# Overview', source: 'internal' }],
      makeConfig('full'),
    );
    expect(result.toLowerCase()).not.toContain('authoritative');
  });

  it('includes each internal doc verbatim under its path heading', () => {
    const result = renderInternalDocsContext(
      [
        { path: '.anatoly/docs/01-Overview.md', content: 'Overview body', source: 'internal' },
        { path: '.anatoly/docs/02-Arch.md', content: 'Arch body', source: 'internal' },
      ],
      makeConfig('full'),
    );
    expect(result).toContain('### `.anatoly/docs/01-Overview.md`');
    expect(result).toContain('Overview body');
    expect(result).toContain('### `.anatoly/docs/02-Arch.md`');
    expect(result).toContain('Arch body');
  });

  it('filters out project docs even when mixed with internal docs', () => {
    const result = renderInternalDocsContext(
      [
        { path: 'docs/api.md', content: 'project doc', source: 'project' },
        { path: '.anatoly/docs/01-Overview.md', content: 'internal doc', source: 'internal' },
      ],
      makeConfig('full'),
    );
    expect(result).not.toContain('project doc');
    expect(result).toContain('internal doc');
  });

  it('doc 23: includes the flow page (source flow) as weak context alongside internal docs', () => {
    const result = renderInternalDocsContext(
      [
        { path: 'docs/api.md', content: 'project doc', source: 'project' },
        { path: '.anatoly/state/internal-flows/user-flows.md', content: 'flow narration', source: 'flow' },
      ],
      makeConfig('full'),
    );
    expect(result).toContain('flow narration');
    expect(result).not.toContain('project doc');
    expect(result).toContain('### `.anatoly/state/internal-flows/user-flows.md`');
  });

  it('handles docs with missing source field as non-internal', () => {
    const result = renderInternalDocsContext(
      [{ path: 'docs/api.md', content: 'no source field' }],
      makeConfig('full'),
    );
    expect(result).toBe('');
  });

  it('AC 54.5b: returns empty when mode is lite', () => {
    const result = renderInternalDocsContext(
      [{ path: '.anatoly/docs/overview.md', content: '# Overview', source: 'internal' }],
      makeConfig('lite'),
    );
    expect(result).toBe('');
  });

  it('AC 54.5b: returns empty when mode is off', () => {
    const result = renderInternalDocsContext(
      [{ path: '.anatoly/docs/overview.md', content: '# Overview', source: 'internal' }],
      makeConfig('off'),
    );
    expect(result).toBe('');
  });
});
