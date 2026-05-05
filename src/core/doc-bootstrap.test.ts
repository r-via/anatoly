// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { needsBootstrap, readScaffoldStatus, shouldSkipDoublePass, writeScaffoldStatus } from './doc-bootstrap.js';

/**
 * Story 29.21: Decouplage doc interne, RAG systematique, et pipeline post-review
 *
 * Tests for bootstrap detection helpers.
 */

describe('needsBootstrap', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-bootstrap-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true when .anatoly/docs/ does not exist', () => {
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns false when .anatoly/docs/ exists with index.md and .cache.json', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'index.md'), '# Index\n');
    writeFileSync(join(docsDir, '.cache.json'), JSON.stringify({ version: 1, pages: { 'index.md': {} } }));
    expect(needsBootstrap(tempDir)).toBe(false);
  });

  it('returns true when .anatoly/docs/ exists but .cache.json is missing', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'index.md'), '# Index\n');
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns true when .anatoly/docs/ exists but index.md is missing', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, '.cache.json'), JSON.stringify({ version: 1, pages: {} }));
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns true when .anatoly/ exists but docs/ subdirectory does not', () => {
    mkdirSync(join(tempDir, '.anatoly'), { recursive: true });
    expect(needsBootstrap(tempDir)).toBe(true);
  });

  it('returns false when the scaffold-status tag is present (canonical signal)', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, '.scaffold-status.json'),
      JSON.stringify({ schemaVersion: 1, scaffoldedAt: '2026-05-05T10:00:00Z', lastMode: 'bootstrap' }),
    );
    // Tag alone is enough — index.md / .cache.json don't have to exist.
    expect(needsBootstrap(tempDir)).toBe(false);
  });

  it('falls back to legacy markers when the tag is corrupt', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, '.scaffold-status.json'), 'not json');
    // No legacy markers either → still needs bootstrap.
    expect(needsBootstrap(tempDir)).toBe(true);
    // Add legacy markers → recognises them and skips bootstrap.
    writeFileSync(join(docsDir, 'index.md'), '# Index\n');
    writeFileSync(join(docsDir, '.cache.json'), JSON.stringify({ version: 1, pages: {} }));
    expect(needsBootstrap(tempDir)).toBe(false);
  });

  it('rejects an unrecognised schemaVersion (forward-compat guard)', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, '.scaffold-status.json'),
      JSON.stringify({ schemaVersion: 99, scaffoldedAt: 'whenever', lastMode: 'bootstrap' }),
    );
    // Unknown version + no legacy markers → bootstrap to be safe.
    expect(needsBootstrap(tempDir)).toBe(true);
  });
});

describe('writeScaffoldStatus / readScaffoldStatus', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'doc-scaffold-status-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('writes a valid v1 tag when .anatoly/docs/ exists', () => {
    const docsDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeScaffoldStatus(tempDir, { mode: 'bootstrap', runId: '2026-05-05_120000' });
    const tagPath = join(docsDir, '.scaffold-status.json');
    expect(existsSync(tagPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(tagPath, 'utf-8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.lastMode).toBe('bootstrap');
    expect(parsed.lastRunId).toBe('2026-05-05_120000');
    expect(typeof parsed.scaffoldedAt).toBe('string');
  });

  it('does nothing when .anatoly/docs/ does not exist (no-op safe)', () => {
    writeScaffoldStatus(tempDir, { mode: 'bootstrap' });
    expect(existsSync(join(tempDir, '.anatoly', 'docs', '.scaffold-status.json'))).toBe(false);
  });

  it('readScaffoldStatus round-trips the written tag', () => {
    mkdirSync(join(tempDir, '.anatoly', 'docs'), { recursive: true });
    writeScaffoldStatus(tempDir, { mode: 'update' });
    const status = readScaffoldStatus(tempDir);
    expect(status?.lastMode).toBe('update');
    expect(status?.schemaVersion).toBe(1);
  });

  it('readScaffoldStatus returns null for missing/corrupt tags', () => {
    expect(readScaffoldStatus(tempDir)).toBeNull();
    mkdirSync(join(tempDir, '.anatoly', 'docs'), { recursive: true });
    writeFileSync(join(tempDir, '.anatoly', 'docs', '.scaffold-status.json'), 'garbage');
    expect(readScaffoldStatus(tempDir)).toBeNull();
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
