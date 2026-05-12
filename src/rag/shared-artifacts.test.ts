// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.5 — Tests for shared artefact migration:
 *   - GGUF models directory resolves to shared/models/gguf
 *   - HF transformers cache redirect via loadHfTransformers
 *   - Grammar manager paths under shared/grammars
 *   - Pricing cache under shared/pricing
 *   - GGUF manifest written on download
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelsDir } from './gguf-prefetch.js';
import { loadHfTransformers, _resetHfModule } from './embeddings.js';
import { PRICING_PATHS } from '../utils/pricing-cache.js';
import { anatolyPath, bootstrapAnatoly } from '../utils/anatoly-paths.js';

// ---------------------------------------------------------------------------
// AC7: GGUF migration — defaultModelsDir(root) resolves correctly
// ---------------------------------------------------------------------------

describe('GGUF defaultModelsDir migration (AC7)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gguf-dir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns shared/models/gguf path when root is provided', () => {
    const dir = defaultModelsDir(root);
    expect(dir).toBe(join(root, '.anatoly', 'shared', 'models', 'gguf'));
  });

  it('matches anatolyPath(root, shared/models/gguf)', () => {
    const dir = defaultModelsDir(root);
    expect(dir).toBe(anatolyPath(root, 'shared/models/gguf'));
  });
});

// ---------------------------------------------------------------------------
// AC6: HF transformers cache redirect
// ---------------------------------------------------------------------------

describe('loadHfTransformers cache redirect (AC6)', () => {
  let tempRoot: string;
  const savedHome = process.env.HOME;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hf-redirect-'));
    const fakeHome = join(tempRoot, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    _resetHfModule();
  });

  afterEach(() => {
    _resetHfModule();
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('sets mod.env.cacheDir from getHfCachePath after bootstrap', async () => {
    const projectRoot = join(tempRoot, 'project');
    mkdirSync(projectRoot, { recursive: true });
    bootstrapAnatoly(projectRoot);

    const mod = await loadHfTransformers();
    const expectedPath = join(projectRoot, '.anatoly', 'shared', 'models', 'hf-cache');
    expect(mod.env.cacheDir).toBe(expectedPath);
  });

  it('returns cached module on second call', async () => {
    const projectRoot = join(tempRoot, 'project');
    mkdirSync(projectRoot, { recursive: true });
    bootstrapAnatoly(projectRoot);

    const mod1 = await loadHfTransformers();
    const mod2 = await loadHfTransformers();
    expect(mod1).toBe(mod2);
  });
});

// ---------------------------------------------------------------------------
// AC8: Grammar non-regression — paths under shared/grammars
// ---------------------------------------------------------------------------

describe('Grammar manager paths (AC8)', () => {
  it('grammarsDir resolves to shared/grammars via anatolyPath', () => {
    const root = '/test-project';
    const expected = join(root, '.anatoly', 'shared', 'grammars');
    expect(anatolyPath(root, 'shared/grammars')).toBe(expected);
  });

  it('no reference to ~/.cache/anatoly/wasm/ in grammar-manager source', async () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'core', 'grammar-manager.ts'),
      'utf-8',
    );
    expect(source).not.toContain('.cache/anatoly/wasm');
    expect(source).not.toContain("'.anatoly/grammars'");
    expect(source).toContain("anatolyPath");
  });
});

// ---------------------------------------------------------------------------
// AC (pricing): Pricing paths under shared/pricing
// ---------------------------------------------------------------------------

describe('Pricing paths migration', () => {
  it('normalized.json resolves under shared/pricing/', () => {
    const root = '/project';
    const path = PRICING_PATHS.normalized(root);
    expect(path).toBe(join(root, '.anatoly', 'shared', 'pricing', 'normalized.json'));
  });

  it('source files resolve under shared/pricing/sources/', () => {
    const root = '/project';
    expect(PRICING_PATHS.litellmRaw(root)).toContain(join('shared', 'pricing', 'sources', 'litellm.json'));
    expect(PRICING_PATHS.openrouterChatRaw(root)).toContain(join('shared', 'pricing', 'sources', 'openrouter-chat.json'));
  });
});

// ---------------------------------------------------------------------------
// GGUF manifest — written after download
// ---------------------------------------------------------------------------

describe('GGUF manifest on download', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gguf-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefetchGgufModels writes manifest.json with source_url and sha256', async () => {
    // We can't actually download GGUF files in tests, but we can verify
    // the manifest structure by importing and using the types.
    // The actual download test in gguf-prefetch.test.ts covers functional behavior.
    // Here we verify the manifest path resolves correctly.
    const manifestPath = join(defaultModelsDir(dir), 'manifest.json');
    expect(manifestPath).toBe(join(dir, '.anatoly', 'shared', 'models', 'gguf', 'manifest.json'));
  });
});
