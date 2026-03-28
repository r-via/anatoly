// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { needsBootstrap } from './doc-bootstrap.js';

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
});

