// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  DocConflictSchema,
  DocConflictsLockSchema,
  DocConflictVerdictSchema,
  DocConflictStatusSchema,
  PresumptionSchema,
} from './doc-conflict.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'abc123',
    detected_at: '2025-06-01T00:00:00Z',
    anchor: {
      file: 'src/core/foo.ts',
      symbol: 'doThing',
      line_range: [10, 20],
      code_hash: 'a'.repeat(64),
    },
    reference_excerpt: {
      path: 'docs/api.md',
      line_range: [5, 8],
      text: 'doThing accepts a string and returns a number.',
    },
    code_summary: 'doThing accepts a number and returns a boolean.',
    signals: {
      doc_last_touched: '2025-05-01T00:00:00Z',
      code_last_touched: '2025-06-01T00:00:00Z',
      test_covers_current_behavior: true,
      presumption: 'doc-stale',
    },
    verdict: 'pending',
    status: 'active',
    ...overrides,
  };
}

function makeValidLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generated_at: '2025-06-01T12:00:00Z',
    entries: [makeValidEntry()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Story 55.3 — DocConflictSchema validation
// ---------------------------------------------------------------------------

describe('Story 55.3 — DocConflictSchema', () => {
  it('accepts a valid entry with all fields', () => {
    const result = DocConflictSchema.safeParse(makeValidEntry());
    expect(result.success).toBe(true);
  });

  it('accepts entry without optional fields (symbol, line_range, verdict_set_at, verdict_note, test_covers)', () => {
    const entry = makeValidEntry({
      anchor: { file: 'src/foo.ts', code_hash: 'b'.repeat(64) },
      reference_excerpt: { path: 'README.md', text: 'does stuff' },
      signals: {
        doc_last_touched: '2025-01-01T00:00:00Z',
        code_last_touched: '2025-01-01T00:00:00Z',
        presumption: 'unknown',
      },
    });
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts entry with verdict_set_at and verdict_note', () => {
    const entry = makeValidEntry({
      verdict: 'doc-wins',
      verdict_set_at: '2025-06-02T00:00:00Z',
      verdict_note: 'The documentation is correct, code needs updating.',
      status: 'applied',
    });
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects entry missing required id', () => {
    const entry = makeValidEntry();
    delete (entry as Record<string, unknown>).id;
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects entry with invalid verdict', () => {
    const entry = makeValidEntry({ verdict: 'invalid-verdict' });
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects entry with invalid status', () => {
    const entry = makeValidEntry({ status: 'resolved' });
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects entry with invalid presumption', () => {
    const entry = makeValidEntry();
    (entry.signals as Record<string, unknown>).presumption = 'maybe';
    const result = DocConflictSchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

describe('Story 55.3 — DocConflictsLockSchema', () => {
  it('accepts a valid lock with entries', () => {
    const result = DocConflictsLockSchema.safeParse(makeValidLock());
    expect(result.success).toBe(true);
  });

  it('accepts a lock with empty entries array', () => {
    const result = DocConflictsLockSchema.safeParse(makeValidLock({ entries: [] }));
    expect(result.success).toBe(true);
  });

  it('rejects lock with version: 2 (unsupported)', () => {
    const result = DocConflictsLockSchema.safeParse(makeValidLock({ version: 2 }));
    expect(result.success).toBe(false);
  });

  it('rejects lock without version field', () => {
    const lock = makeValidLock();
    delete (lock as Record<string, unknown>).version;
    const result = DocConflictsLockSchema.safeParse(lock);
    expect(result.success).toBe(false);
  });

  it('rejects lock with malformed entry', () => {
    const result = DocConflictsLockSchema.safeParse(makeValidLock({ entries: [{ bad: true }] }));
    expect(result.success).toBe(false);
  });
});

describe('Story 55.3 — enum schemas', () => {
  it('DocConflictVerdictSchema accepts all verdicts', () => {
    for (const v of ['pending', 'doc-wins', 'code-wins', 'skip', 'dismiss']) {
      expect(DocConflictVerdictSchema.safeParse(v).success).toBe(true);
    }
  });

  it('DocConflictStatusSchema accepts all statuses', () => {
    for (const s of ['active', 'stale-by-codechange', 'applied', 'skipped', 'auto-resolved']) {
      expect(DocConflictStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('PresumptionSchema accepts all 3 presumptions', () => {
    for (const p of ['doc-stale', 'code-drift', 'unknown']) {
      expect(PresumptionSchema.safeParse(p).success).toBe(true);
    }
  });
});
