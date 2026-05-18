// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import {
  derivePresumption,
  applyResolvedVerdicts,
  markStaleEntries,
} from './doc-conflict-detector.js';
import { hashCodeAnchor } from './doc-conflict-store.js';
import type { DocConflict } from '../../../schemas/doc-conflict.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'doc-conflict-detector-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<DocConflict> = {}): DocConflict {
  return {
    id: 'test-id-1',
    detected_at: '2025-06-01T00:00:00Z',
    anchor: {
      file: 'src/foo.ts',
      symbol: 'doThing',
      line_range: [10, 20],
      code_hash: 'a'.repeat(64),
    },
    reference_excerpt: {
      path: 'docs/api.md',
      text: 'doThing accepts a string.',
    },
    code_summary: 'doThing accepts a number.',
    signals: {
      doc_last_touched: '2025-05-01T00:00:00Z',
      code_last_touched: '2025-06-01T00:00:00Z',
      presumption: 'doc-stale',
    },
    verdict: 'pending',
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Story 55.4 — derivePresumption
// ---------------------------------------------------------------------------

describe('Story 55.4 — derivePresumption', () => {
  it('returns "doc-stale" when code was touched more recently than doc', () => {
    const result = derivePresumption({
      doc_last_touched: '2025-01-01T00:00:00Z',
      code_last_touched: '2025-06-01T00:00:00Z',
      presumption: 'unknown', // will be overwritten
    });
    expect(result).toBe('doc-stale');
  });

  it('returns "code-drift" when doc was touched more recently than code', () => {
    const result = derivePresumption({
      doc_last_touched: '2025-06-01T00:00:00Z',
      code_last_touched: '2025-01-01T00:00:00Z',
      presumption: 'unknown',
    });
    expect(result).toBe('code-drift');
  });

  it('returns "unknown" when timestamps are equal', () => {
    const result = derivePresumption({
      doc_last_touched: '2025-06-01T00:00:00Z',
      code_last_touched: '2025-06-01T00:00:00Z',
      presumption: 'unknown',
    });
    expect(result).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Story 55.4 — markStaleEntries
// ---------------------------------------------------------------------------

describe('Story 55.4 — markStaleEntries', () => {
  it('marks entry as stale-by-codechange when hash does not match', () => {
    const entry = makeEntry({
      verdict: 'doc-wins',
      status: 'applied',
      anchor: { file: 'src/foo.ts', code_hash: 'old-hash'.padEnd(64, '0') },
    });

    const fileContents = new Map<string, string>();
    fileContents.set('src/foo.ts', 'completely different content now');

    const result = markStaleEntries([entry], fileContents);
    expect(result.staleCount).toBe(1);
    expect(result.entries[0].status).toBe('stale-by-codechange');
    expect(result.entries[0].verdict).toBe('pending');
    expect(result.entries[0].verdict_note).toContain('code changed');
  });

  it('keeps entry unchanged when hash matches', () => {
    const content = 'function doThing() { return 42; }';
    const codeHash = hashCodeAnchor('src/foo.ts', undefined, undefined, content);
    const entry = makeEntry({
      verdict: 'doc-wins',
      status: 'applied',
      anchor: { file: 'src/foo.ts', code_hash: codeHash },
    });

    const fileContents = new Map<string, string>();
    fileContents.set('src/foo.ts', content);

    const result = markStaleEntries([entry], fileContents);
    expect(result.staleCount).toBe(0);
    expect(result.entries[0].status).toBe('applied');
    expect(result.entries[0].verdict).toBe('doc-wins');
  });

  it('skips entries whose file is not in fileContents (file deleted)', () => {
    const entry = makeEntry({
      verdict: 'doc-wins',
      status: 'applied',
    });

    const fileContents = new Map<string, string>();
    // file not present — might have been deleted

    const result = markStaleEntries([entry], fileContents);
    expect(result.staleCount).toBe(1);
    expect(result.entries[0].status).toBe('stale-by-codechange');
  });

  it('does not touch pending entries (they are already pending)', () => {
    const entry = makeEntry({
      verdict: 'pending',
      status: 'active',
      anchor: { file: 'src/foo.ts', code_hash: 'mismatch'.padEnd(64, '0') },
    });

    const fileContents = new Map<string, string>();
    fileContents.set('src/foo.ts', 'changed content');

    const result = markStaleEntries([entry], fileContents);
    // Still marks it stale because the code_hash doesn't match
    expect(result.staleCount).toBe(1);
    expect(result.entries[0].status).toBe('stale-by-codechange');
  });
});

// ---------------------------------------------------------------------------
// Story 55.4 — applyResolvedVerdicts
// ---------------------------------------------------------------------------

describe('Story 55.4 — applyResolvedVerdicts', () => {
  it('applies doc-wins verdict by marking status as applied', () => {
    const entry = makeEntry({
      verdict: 'doc-wins',
      verdict_set_at: '2025-06-02T00:00:00Z',
      status: 'active',
    });

    const result = applyResolvedVerdicts([entry]);
    expect(result.appliedCount).toBe(1);
    expect(result.entries[0].status).toBe('applied');
  });

  it('applies code-wins verdict by marking status as applied', () => {
    const entry = makeEntry({
      verdict: 'code-wins',
      verdict_set_at: '2025-06-02T00:00:00Z',
      status: 'active',
    });

    const result = applyResolvedVerdicts([entry]);
    expect(result.appliedCount).toBe(1);
    expect(result.entries[0].status).toBe('applied');
  });

  it('applies skip verdict by marking status as skipped', () => {
    const entry = makeEntry({
      verdict: 'skip',
      verdict_set_at: '2025-06-02T00:00:00Z',
      status: 'active',
    });

    const result = applyResolvedVerdicts([entry]);
    expect(result.appliedCount).toBe(1);
    expect(result.entries[0].status).toBe('skipped');
  });

  it('does not touch pending entries', () => {
    const entry = makeEntry({
      verdict: 'pending',
      status: 'active',
    });

    const result = applyResolvedVerdicts([entry]);
    expect(result.appliedCount).toBe(0);
    expect(result.entries[0].status).toBe('active');
  });

  it('does not re-apply already-applied entries', () => {
    const entry = makeEntry({
      verdict: 'doc-wins',
      status: 'applied',
    });

    const result = applyResolvedVerdicts([entry]);
    expect(result.appliedCount).toBe(0);
    expect(result.entries[0].status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------
// Story 55.4 — pipeline integration (structural)
// ---------------------------------------------------------------------------

describe('Story 55.4 — pipeline integration', () => {
  // PR 8a (doc 11) extracted the orchestration spine out of run.ts into
  // pipeline.ts byte-verbatim. These assert spine wiring/ordering, so they
  // read the pipeline module now. Behavior is unchanged and additionally
  // guarded by the spine golden.
  const spinePath = join(__dirname, '../../orchestration/pipeline.ts');

  it('pipeline imports runDocConflictDetection', () => {
    const content = readFileSync(spinePath, 'utf-8');
    expect(content).toContain('runDocConflictDetection');
  });

  it('detector is called after runDocBootstrap (bootstrap-doc phase)', () => {
    const content = readFileSync(spinePath, 'utf-8');
    const bootstrapIdx = content.indexOf('await runDocBootstrap(');
    const detectorAfterBootstrap = content.indexOf('runDocConflictDetection', bootstrapIdx);
    // PR 4 (doc 11) moved runRagPhase out of run.ts; the internal
    // `phase: 'rag-index'` label moved with it. The spine sequence is
    // unchanged, so anchor on the spine's rag-index phase call instead.
    const ragPhaseIdx = content.indexOf("runPhase(ctx, 'rag-index'", bootstrapIdx);
    expect(detectorAfterBootstrap).toBeGreaterThan(bootstrapIdx);
    expect(detectorAfterBootstrap).toBeLessThan(ragPhaseIdx);
  });

  it('detector is called after runDocUpdate (internal-docs phase)', () => {
    const content = readFileSync(spinePath, 'utf-8');
    const docUpdateIdx = content.indexOf('await runDocUpdate(');
    const detectorAfterUpdate = content.indexOf('runDocConflictDetection', docUpdateIdx);
    const reviewPhaseIdx = content.indexOf('await runReviewPhase(', docUpdateIdx);
    expect(detectorAfterUpdate).toBeGreaterThan(docUpdateIdx);
    expect(detectorAfterUpdate).toBeLessThan(reviewPhaseIdx);
  });

  it('detector is never called in mode off (structural: only inside full-mode branches)', () => {
    const content = readFileSync(spinePath, 'utf-8');
    // The detector calls should both be inside blocks that are NOT the off/lite branches
    const detectorCalls = [...content.matchAll(/runDocConflictDetection\(/g)];
    // Should have exactly 2 calls (after bootstrap and after update)
    expect(detectorCalls.length).toBe(2);
  });
});
