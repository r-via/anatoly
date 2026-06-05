// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { selectPagesToCreate, buildCreatePageMessage } from './docs.js';

function domain(over: Partial<{ domain: string; classification: string; functionsMissing: Array<{ name: string; file: string; docSummary: string }> }> = {}) {
  return {
    domain: over.domain ?? 'payments',
    classification: over.classification ?? 'NOT_FOUND',
    functionsMissing: over.functionsMissing ?? [{ name: 'charge', file: 'src/payments.ts', docSummary: 'charges a card' }],
  };
}

describe('selectPagesToCreate', () => {
  it('pairs each NOT_FOUND domain with its scheduled create path and functions', () => {
    const gapReport = {
      domains: [domain({ domain: 'payments' })],
      pagesToCreate: ['05-Modules/payments.md'],
    };
    const work = selectPagesToCreate(gapReport);
    expect(work).toHaveLength(1);
    expect(work[0].path).toBe('05-Modules/payments.md');
    expect(work[0].domain).toBe('payments');
    expect(work[0].functions).toHaveLength(1);
    expect(work[0].functions[0].name).toBe('charge');
  });

  it('skips COVERED / LOW_RELEVANCE domains (only NOT_FOUND get new pages)', () => {
    const gapReport = {
      domains: [
        domain({ domain: 'covered', classification: 'COVERED' }),
        domain({ domain: 'lowrel', classification: 'LOW_RELEVANCE' }),
      ],
      pagesToCreate: ['05-Modules/covered.md', '05-Modules/lowrel.md'],
    };
    expect(selectPagesToCreate(gapReport)).toHaveLength(0);
  });

  it('skips a NOT_FOUND domain that has no functions to document', () => {
    const gapReport = {
      domains: [domain({ domain: 'empty', functionsMissing: [] })],
      pagesToCreate: ['05-Modules/empty.md'],
    };
    expect(selectPagesToCreate(gapReport)).toHaveLength(0);
  });

  it('skips a domain the gap detector did not schedule for creation (no matching path)', () => {
    const gapReport = {
      domains: [domain({ domain: 'payments' })],
      pagesToCreate: ['05-Modules/other.md'],
    };
    expect(selectPagesToCreate(gapReport)).toHaveLength(0);
  });

  it('matches a root-level (no directory) create path too', () => {
    const gapReport = {
      domains: [domain({ domain: 'payments' })],
      pagesToCreate: ['payments.md'],
    };
    expect(selectPagesToCreate(gapReport)[0]?.path).toBe('payments.md');
  });
});

describe('buildCreatePageMessage', () => {
  it('lists every function with its file and summary', () => {
    const msg = buildCreatePageMessage('payments', [
      { name: 'charge', file: 'src/payments.ts', docSummary: 'charges a card' },
      { name: 'refund', file: 'src/payments.ts', docSummary: '' },
    ]);
    expect(msg).toContain('New page for module: payments');
    expect(msg).toContain('- charge (src/payments.ts)');
    expect(msg).toContain('Summary: charges a card');
    // Empty summary falls back to a placeholder rather than an empty line.
    expect(msg).toContain('- refund (src/payments.ts)');
    expect(msg).toContain('Summary: no summary available');
  });
});
