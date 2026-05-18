// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import type { DocConflict, DocConflictsLock } from '../../../schemas/doc-conflict.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConflictEntry(overrides?: Partial<DocConflict>): DocConflict {
  return {
    id: 'conflict-abc123',
    detected_at: '2025-01-15T10:00:00.000Z',
    anchor: {
      file: 'src/core/foo.ts',
      symbol: 'computeBar',
      line_range: [10, 25] as [number, number],
      code_hash: 'sha256-abc',
    },
    reference_excerpt: {
      path: 'docs/architecture.md',
      line_range: [5, 10] as [number, number],
      text: 'computeBar must never return null',
    },
    code_summary: 'Returns undefined when input is empty',
    signals: {
      doc_last_touched: '2025-01-01T00:00:00.000Z',
      code_last_touched: '2025-01-14T00:00:00.000Z',
      test_covers_current_behavior: true,
      presumption: 'doc-stale' as const,
    },
    verdict: 'code-wins' as const,
    verdict_set_at: '2025-01-16T00:00:00.000Z',
    verdict_note: 'Docs outdated after refactor',
    status: 'applied' as const,
    ...overrides,
  };
}

function makeLock(entries: DocConflict[]): DocConflictsLock {
  return {
    version: 1 as const,
    generated_at: '2025-01-15T10:00:00.000Z',
    entries,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stale-ref-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeLock(lock: DocConflictsLock): void {
  const dir = join(tmpDir, '.anatoly', 'state', 'internal-docs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'doc-conflicts.yaml'), yamlStringify(lock), 'utf-8');
}

// ---------------------------------------------------------------------------
// AC1: DocStaleReferenceSchema exists with required fields
// ---------------------------------------------------------------------------

describe('Story 55.8 — AC1: DocStaleReferenceSchema', () => {
  it('schema exists in review.ts', async () => {
    const { DocStaleReferenceSchema } = await import('../../../schemas/review.js');
    expect(DocStaleReferenceSchema).toBeDefined();
  });

  it('accepts a valid doc_stale_reference finding', async () => {
    const { DocStaleReferenceSchema } = await import('../../../schemas/review.js');
    const valid = {
      kind: 'doc_stale_reference',
      reference_path: 'docs/architecture.md',
      reference_line_range: [5, 10],
      arbitrated_at: '2025-01-16T00:00:00.000Z',
      arbitration_note: 'Docs outdated after refactor',
    };
    const result = DocStaleReferenceSchema.parse(valid);
    expect(result.kind).toBe('doc_stale_reference');
    expect(result.reference_path).toBe('docs/architecture.md');
    expect(result.reference_line_range).toEqual([5, 10]);
    expect(result.arbitrated_at).toBe('2025-01-16T00:00:00.000Z');
    expect(result.arbitration_note).toBe('Docs outdated after refactor');
  });

  it('accepts without optional fields', async () => {
    const { DocStaleReferenceSchema } = await import('../../../schemas/review.js');
    const minimal = {
      kind: 'doc_stale_reference',
      reference_path: 'docs/api.md',
      arbitrated_at: '2025-01-16T00:00:00.000Z',
    };
    const result = DocStaleReferenceSchema.parse(minimal);
    expect(result.reference_line_range).toBeUndefined();
    expect(result.arbitration_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC1: ReviewFileSchema includes doc_stale_references field
// ---------------------------------------------------------------------------

describe('Story 55.8 — AC1: ReviewFileSchema field', () => {
  it('ReviewFileSchema accepts doc_stale_references array', async () => {
    const reviewSrc = readFileSync(
      join(process.cwd(), 'src', 'schemas', 'review.ts'),
      'utf-8',
    );
    expect(reviewSrc).toContain('doc_stale_references');
  });
});

// ---------------------------------------------------------------------------
// AC2: loadCodeWinsAsStaleReferences extracts code-wins entries
// ---------------------------------------------------------------------------

describe('Story 55.8 — AC2: loadCodeWinsAsStaleReferences', () => {
  it('extracts code-wins, applied entries from doc-conflicts.yaml', async () => {
    const { loadCodeWinsAsStaleReferences } = await import('./doc-stale-reference.js');

    const entries = [
      makeConflictEntry({ id: 'c1', verdict: 'code-wins', status: 'applied' }),
      makeConflictEntry({ id: 'c2', verdict: 'doc-wins', status: 'applied' }),
      makeConflictEntry({ id: 'c3', verdict: 'code-wins', status: 'active' }),
      makeConflictEntry({ id: 'c4', verdict: 'pending', status: 'active' }),
    ];
    writeLock(makeLock(entries));

    const result = loadCodeWinsAsStaleReferences(tmpDir);
    // Only c1 matches: code-wins + applied
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('doc_stale_reference');
    expect(result[0].reference_path).toBe('docs/architecture.md');
    expect(result[0].reference_line_range).toEqual([5, 10]);
    expect(result[0].arbitrated_at).toBe('2025-01-16T00:00:00.000Z');
    expect(result[0].arbitration_note).toBe('Docs outdated after refactor');
  });

  it('returns empty array when no doc-conflicts.yaml', async () => {
    const { loadCodeWinsAsStaleReferences } = await import('./doc-stale-reference.js');
    const result = loadCodeWinsAsStaleReferences(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns empty array on malformed YAML (no crash)', async () => {
    const { loadCodeWinsAsStaleReferences } = await import('./doc-stale-reference.js');
    const dir = join(tmpDir, '.anatoly', 'state', 'internal-docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'doc-conflicts.yaml'), '{{invalid', 'utf-8');
    const result = loadCodeWinsAsStaleReferences(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3: aggregation and rendering in reporter
// ---------------------------------------------------------------------------

describe('Story 55.8 — AC3: aggregateStaleReferences + renderStaleReferenceSection', () => {
  it('aggregateStaleReferences collects from review files', async () => {
    const { aggregateStaleReferences } = await import('../../reporting/index.js');
    const reviews = [
      { doc_stale_references: [{ kind: 'doc_stale_reference' as const, reference_path: 'a.md', arbitrated_at: '2025-01-01' }] },
      { doc_stale_references: [{ kind: 'doc_stale_reference' as const, reference_path: 'b.md', arbitrated_at: '2025-01-02' }] },
      {},
    ] as Parameters<typeof aggregateStaleReferences>[0];
    const result = aggregateStaleReferences(reviews);
    expect(result).toHaveLength(2);
  });

  it('renderStaleReferenceSection returns markdown', async () => {
    const { renderStaleReferenceSection } = await import('../../reporting/index.js');
    const refs = [
      { kind: 'doc_stale_reference' as const, reference_path: 'docs/arch.md', arbitrated_at: '2025-01-16', arbitration_note: 'outdated' },
    ];
    const result = renderStaleReferenceSection(refs);
    expect(result).toContain('docs/arch.md');
    expect(result).toContain('outdated');
    expect(result).toContain('stale');
  });

  it('renderStaleReferenceSection returns empty string for empty array', async () => {
    const { renderStaleReferenceSection } = await import('../../reporting/index.js');
    expect(renderStaleReferenceSection([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Structural: wiring tests
// ---------------------------------------------------------------------------

describe('Story 55.8 — structural', () => {
  it('reporter.ts uses loadCodeWinsAsStaleReferences and renderStaleReferenceSection', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'core', 'reporting', 'reporter.ts'), 'utf-8');
    expect(src).toContain('loadCodeWinsAsStaleReferences');
    expect(src).toContain('renderStaleReferenceSection');
  });

  it('review.ts declares DocStaleReferenceSchema and doc_stale_references field', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'schemas', 'review.ts'), 'utf-8');
    expect(src).toContain('DocStaleReferenceSchema');
    expect(src).toContain('doc_stale_references');
  });
});
