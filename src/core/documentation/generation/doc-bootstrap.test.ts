// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  needsBootstrap,
  readScaffoldStatus,
  writeScaffoldStatus,
  writeCoherenceStatus,
  readCoherenceStatus,
  computeDocSetSignature,
  coherenceUpToDate,
  shouldSkipDoublePass,
} from './doc-bootstrap.js';
import { docManifestPath } from '../resolution/doc-cache.js';

/**
 * Story 29.21 + flag unification: every doc-pipeline flag lives in the one
 * ledger `.anatoly/cache/doc-build/manifest.json`. These tests pin that
 * single-source-of-truth behaviour.
 */

function mkDocsDir(root: string): string {
  const d = join(root, '.anatoly', 'state', 'internal-docs');
  mkdirSync(d, { recursive: true });
  return d;
}
function readManifest(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(docManifestPath(root), 'utf-8'));
}

describe('needsBootstrap', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'doc-bootstrap-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns true when internal-docs/ does not exist', () => {
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns true when internal-docs/ exists but no manifest scaffold flag', () => {
    mkDocsDir(tempDir);
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns true when the manifest has pages but no scaffold flag', () => {
    mkDocsDir(tempDir);
    mkdirSync(join(tempDir, '.anatoly', 'cache', 'doc-build'), { recursive: true });
    writeFileSync(
      docManifestPath(tempDir),
      JSON.stringify({ version: 3, pages: { 'index.md': {} } }),
    );
    // Pages alone never mean the pipeline finished — coherence may be pending.
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns false once writeScaffoldStatus recorded a completed pipeline', () => {
    mkDocsDir(tempDir);
    writeScaffoldStatus(tempDir, { mode: 'bootstrap', runId: 'r1' });
    expect(needsBootstrap(tempDir)).toBe(false);
  });

  it('returns true for a discarded legacy v1/v2 manifest (one clean regen)', () => {
    mkDocsDir(tempDir);
    mkdirSync(join(tempDir, '.anatoly', 'cache', 'doc-build'), { recursive: true });
    writeFileSync(
      docManifestPath(tempDir),
      JSON.stringify({ version: 1, pages: {}, scaffold: { scaffoldedAt: 'x', lastMode: 'bootstrap' } }),
    );
    // v1 is dropped on load → no scaffold flag → bootstrap.
    expect(needsBootstrap(tempDir)).toBe(true);
  });
});

describe('writeScaffoldStatus / readScaffoldStatus', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'doc-scaffold-status-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('writes scaffold into the unified manifest (not a separate file)', () => {
    mkDocsDir(tempDir);
    writeScaffoldStatus(tempDir, { mode: 'bootstrap', runId: '2026-05-05_120000' });

    const m = readManifest(tempDir);
    expect(m.version).toBe(3);
    const scaffold = m.scaffold as Record<string, unknown>;
    expect(scaffold.lastMode).toBe('bootstrap');
    expect(scaffold.lastRunId).toBe('2026-05-05_120000');
    expect(typeof scaffold.scaffoldedAt).toBe('string');
  });

  it('does nothing when internal-docs/ does not exist (no-op safe)', () => {
    writeScaffoldStatus(tempDir, { mode: 'bootstrap' });
    expect(readScaffoldStatus(tempDir)).toBeNull();
  });

  it('preserves existing per-page flags when writing scaffold', () => {
    mkDocsDir(tempDir);
    mkdirSync(join(tempDir, '.anatoly', 'cache', 'doc-build'), { recursive: true });
    writeFileSync(
      docManifestPath(tempDir),
      JSON.stringify({ version: 3, pages: { 'a.md': { 'src/a.ts': 'h' } } }),
    );
    writeScaffoldStatus(tempDir, { mode: 'update' });

    const m = readManifest(tempDir);
    expect((m.pages as Record<string, unknown>)['a.md']).toEqual({ 'src/a.ts': 'h' });
    expect((m.scaffold as Record<string, unknown>).lastMode).toBe('update');
  });

  it('readScaffoldStatus round-trips; returns null when absent/corrupt', () => {
    expect(readScaffoldStatus(tempDir)).toBeNull();
    mkDocsDir(tempDir);
    writeScaffoldStatus(tempDir, { mode: 'update' });
    const status = readScaffoldStatus(tempDir);
    expect(status?.lastMode).toBe('update');
    expect(typeof status?.scaffoldedAt).toBe('string');
  });
});

describe('coherence flag', () => {
  let tempDir: string;
  let docsDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-coherence-'));
    docsDir = mkDocsDir(tempDir);
    writeFileSync(join(docsDir, 'index.md'), '# Index\n');
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('round-trips and is keyed to the doc-set signature', () => {
    expect(readCoherenceStatus(tempDir)).toBeNull();
    const sig = computeDocSetSignature(docsDir);
    writeCoherenceStatus(tempDir, sig);

    const flag = readCoherenceStatus(tempDir);
    expect(flag?.key).toBe(sig);
    expect(typeof flag?.at).toBe('string');
    expect(coherenceUpToDate(tempDir, docsDir)).toBe(true);
  });

  it('is invalidated when any doc page changes', () => {
    writeCoherenceStatus(tempDir, computeDocSetSignature(docsDir));
    expect(coherenceUpToDate(tempDir, docsDir)).toBe(true);

    writeFileSync(join(docsDir, 'index.md'), '# Index\n\nchanged\n');
    expect(coherenceUpToDate(tempDir, docsDir)).toBe(false);
  });

  it('preserves pages + scaffold when writing the coherence flag', () => {
    mkdirSync(join(tempDir, '.anatoly', 'cache', 'doc-build'), { recursive: true });
    writeFileSync(
      docManifestPath(tempDir),
      JSON.stringify({ version: 3, pages: { 'a.md': { 'src/a.ts': 'h' } }, scaffold: { scaffoldedAt: 't', lastMode: 'bootstrap' } }),
    );
    writeCoherenceStatus(tempDir, 'sig-1');

    const m = readManifest(tempDir);
    expect((m.pages as Record<string, unknown>)['a.md']).toEqual({ 'src/a.ts': 'h' });
    expect((m.scaffold as Record<string, unknown>).lastMode).toBe('bootstrap');
    expect((m.coherence as Record<string, unknown>).key).toBe('sig-1');
  });
});

describe('shouldSkipDoublePass', () => {
  it('returns false when 0 pages failed', () => {
    expect(shouldSkipDoublePass(0, 10)).toBe(false);
  });
  it('returns false when less than 50% of pages failed', () => {
    expect(shouldSkipDoublePass(4, 10)).toBe(false);
  });
  it('returns true when exactly 50% of pages failed', () => {
    expect(shouldSkipDoublePass(5, 10)).toBe(true);
  });
  it('returns true when more than 50% of pages failed', () => {
    expect(shouldSkipDoublePass(6, 10)).toBe(true);
  });
  it('returns false when totalPages is 0', () => {
    expect(shouldSkipDoublePass(0, 0)).toBe(false);
  });
  it('returns true when all pages failed', () => {
    expect(shouldSkipDoublePass(24, 24)).toBe(true);
  });
});
