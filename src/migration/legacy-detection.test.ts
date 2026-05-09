// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.6 — Legacy layout detection tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLegacyLayout } from './legacy-detection.js';

describe('detectLegacyLayout', () => {
  let root: string;
  let fakeHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacy-detect-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'legacy-home-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns detected: false when no legacy paths exist', () => {
    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(false);
    expect(result.paths).toEqual([]);
  });

  it('detects legacy pricing.json at root', () => {
    mkdirSync(join(root, '.anatoly'), { recursive: true });
    writeFileSync(join(root, '.anatoly', 'pricing.json'), '{}');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(root, '.anatoly', 'pricing.json'));
  });

  it('detects legacy grammars/ directory', () => {
    mkdirSync(join(root, '.anatoly', 'grammars'), { recursive: true });

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(root, '.anatoly', 'grammars'));
  });

  it('detects legacy refinement-cache.json', () => {
    mkdirSync(join(root, '.anatoly', 'cache'), { recursive: true });
    writeFileSync(join(root, '.anatoly', 'cache', 'refinement-cache.json'), '{}');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(root, '.anatoly', 'cache', 'refinement-cache.json'));
  });

  it('detects legacy sources/ directory', () => {
    mkdirSync(join(root, '.anatoly', 'sources'), { recursive: true });

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(root, '.anatoly', 'sources'));
  });

  it('detects legacy correction-memory.json', () => {
    mkdirSync(join(root, '.anatoly'), { recursive: true });
    writeFileSync(join(root, '.anatoly', 'correction-memory.json'), '{}');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(root, '.anatoly', 'correction-memory.json'));
  });

  it('returns multiple detected legacy paths', () => {
    mkdirSync(join(root, '.anatoly', 'sources'), { recursive: true });
    mkdirSync(join(root, '.anatoly', 'grammars'), { recursive: true });
    writeFileSync(join(root, '.anatoly', 'pricing.json'), '{}');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths.length).toBe(3);
  });

  it('generates migration instructions when legacy layout detected', () => {
    mkdirSync(join(root, '.anatoly'), { recursive: true });
    writeFileSync(join(root, '.anatoly', 'pricing.json'), '{}');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain('rm');
    expect(result.instructions).toContain(root);
  });

  it('does not generate instructions when no legacy layout detected', () => {
    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.instructions).toBeUndefined();
  });

  it('detects legacy GGUF models at ~/.anatoly/models/', () => {
    mkdirSync(join(fakeHome, '.anatoly', 'models'), { recursive: true });
    writeFileSync(join(fakeHome, '.anatoly', 'models', 'test.gguf'), 'data');

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(fakeHome, '.anatoly', 'models'));
    expect(result.instructions).toContain('mv ~/.anatoly/models/*.gguf ~/.anatoly/shared/models/gguf/');
  });

  it('detects legacy ~/.cache/anatoly/wasm/', () => {
    mkdirSync(join(fakeHome, '.cache', 'anatoly', 'wasm'), { recursive: true });

    const result = detectLegacyLayout(root, { home: fakeHome });
    expect(result.detected).toBe(true);
    expect(result.paths).toContain(join(fakeHome, '.cache', 'anatoly', 'wasm'));
  });
});
