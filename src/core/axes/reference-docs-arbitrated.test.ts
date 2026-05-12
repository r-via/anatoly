// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReferenceDocsContext } from './reference-docs-context.js';
import type { ReferenceDoc } from '../reference-docs-resolver.js';
import type { ArbitratedFragment } from './reference-docs-context.js';

// ---------------------------------------------------------------------------
// Story 55.7 — AC1: renderReferenceDocsContext injects arbitrated fragments
// ---------------------------------------------------------------------------

describe('Story 55.7 — renderReferenceDocsContext with arbitrated fragments', () => {
  const baseDocs: ReferenceDoc[] = [
    { source: 'readme', path: 'README.md', content: '# Project overview' },
  ];

  it('renders arbitrated fragments in a distinct section', () => {
    const fragments: ArbitratedFragment[] = [
      {
        referencePath: 'docs/architecture.md',
        text: 'computeBar must never return null',
        arbitratedAt: '2025-01-15T10:00:00.000Z',
        note: 'Confirmed by team lead',
      },
    ];

    const result = renderReferenceDocsContext(baseDocs, null, fragments);
    // Must contain the distinct section header
    expect(result).toContain('ARBITRATED INTERNAL DOCS (human-validated)');
    // Must contain the fragment text
    expect(result).toContain('computeBar must never return null');
    // Must contain the reference path
    expect(result).toContain('docs/architecture.md');
    // Must contain the note
    expect(result).toContain('Confirmed by team lead');
    // Must still contain the base reference docs section
    expect(result).toContain('REFERENCE DOCUMENTATION');
    expect(result).toContain('# Project overview');
  });

  it('renders multiple arbitrated fragments', () => {
    const fragments: ArbitratedFragment[] = [
      {
        referencePath: 'docs/api.md',
        text: 'All endpoints return JSON',
        arbitratedAt: '2025-01-15T10:00:00.000Z',
      },
      {
        referencePath: 'docs/security.md',
        text: 'Never expose tokens in logs',
        arbitratedAt: '2025-01-16T10:00:00.000Z',
        note: 'Critical security requirement',
      },
    ];

    const result = renderReferenceDocsContext(baseDocs, null, fragments);
    expect(result).toContain('All endpoints return JSON');
    expect(result).toContain('Never expose tokens in logs');
    expect(result).toContain('docs/api.md');
    expect(result).toContain('docs/security.md');
  });

  it('does not render arbitrated section when fragments array is empty', () => {
    const result = renderReferenceDocsContext(baseDocs, null, []);
    expect(result).not.toContain('ARBITRATED');
  });

  it('does not render arbitrated section when fragments is undefined', () => {
    const result = renderReferenceDocsContext(baseDocs, null, undefined);
    expect(result).not.toContain('ARBITRATED');
  });

  it('renders fragment without note when note is undefined', () => {
    const fragments: ArbitratedFragment[] = [
      {
        referencePath: 'docs/api.md',
        text: 'All endpoints return JSON',
        arbitratedAt: '2025-01-15T10:00:00.000Z',
      },
    ];

    const result = renderReferenceDocsContext(baseDocs, null, fragments);
    expect(result).toContain('All endpoints return JSON');
    // Should not contain 'Note:' label when no note
    expect(result).not.toContain('Note:');
  });
});

// ---------------------------------------------------------------------------
// Story 55.7 — AC2: unevaluated fragments stay in renderInternalDocsContext
// ---------------------------------------------------------------------------

describe('Story 55.7 — AC2: unevaluated docs unaffected', () => {
  it('renderInternalDocsContext remains the path for unevaluated docs (structural)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'axes', 'internal-docs-context.ts'),
      'utf-8',
    );
    // Internal docs context still uses 'INTERNAL DOCUMENTATION' heading
    expect(src).toContain('INTERNAL DOCUMENTATION');
    // And still checks for resolveDocMode
    expect(src).toContain('resolveDocMode');
  });
});

// ---------------------------------------------------------------------------
// Story 55.7 — AC3: both sections coexist without collision
// ---------------------------------------------------------------------------

describe('Story 55.7 — AC3: reference + arbitrated + internal coexist', () => {
  it('all three sections appear with distinct headings', () => {
    const docs: ReferenceDoc[] = [
      { source: 'readme', path: 'README.md', content: '# Project' },
    ];
    const fragments: ArbitratedFragment[] = [
      {
        referencePath: 'docs/arch.md',
        text: 'Must use dependency injection',
        arbitratedAt: '2025-01-15T10:00:00.000Z',
      },
    ];
    const digest = {
      tokens: 100,
      content: '---\nstatus: evaluated\nsource: reference-digest\n---\n## Modules\n...',
      fingerprint: 'abc123',
    };

    const result = renderReferenceDocsContext(docs, digest, fragments);

    // All three sections present
    expect(result).toContain('REFERENCE DOCUMENTATION (AUTHORITATIVE');
    expect(result).toContain('ARBITRATED INTERNAL DOCS (human-validated)');
    expect(result).toContain('Internal Reference Digest (source: reference-digest)');

    // Content from each section present
    expect(result).toContain('# Project');
    expect(result).toContain('Must use dependency injection');
    expect(result).toContain('## Modules');
  });
});

// ---------------------------------------------------------------------------
// Story 55.7 — Structural: 3 axis callers pass arbitratedFragments
// ---------------------------------------------------------------------------

describe('Story 55.7 — structural: axes pass arbitratedFragments', () => {
  it('correction.ts passes ctx.arbitratedFragments to renderReferenceDocsContext', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'axes', 'correction.ts'),
      'utf-8',
    );
    expect(src).toContain('ctx.arbitratedFragments');
  });

  it('best-practices.ts passes ctx.arbitratedFragments to renderReferenceDocsContext', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'axes', 'best-practices.ts'),
      'utf-8',
    );
    expect(src).toContain('ctx.arbitratedFragments');
  });

  it('overengineering.ts passes ctx.arbitratedFragments to renderReferenceDocsContext', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'axes', 'overengineering.ts'),
      'utf-8',
    );
    expect(src).toContain('ctx.arbitratedFragments');
  });
});

// ---------------------------------------------------------------------------
// Story 55.7 — Structural: AxisContext has arbitratedFragments field
// ---------------------------------------------------------------------------

describe('Story 55.7 — structural: AxisContext has arbitratedFragments', () => {
  it('axis-evaluator.ts declares arbitratedFragments on AxisContext', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'axis-evaluator.ts'),
      'utf-8',
    );
    expect(src).toContain('arbitratedFragments');
  });

  it('file-evaluator.ts declares arbitratedFragments on FileEvaluatorOptions', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'core', 'file-evaluator.ts'),
      'utf-8',
    );
    expect(src).toContain('arbitratedFragments');
  });
});
