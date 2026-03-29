// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 43.8 — Validation tests for the multi-provider migration.
 *
 * These tests verify the migration invariants are satisfied:
 * - @google/genai is removed
 * - v1 configs trigger migration warning
 * - v2 configs do not trigger warning
 * - migrateConfigV1toV2 produces valid v2 configs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isV1Config, migrateConfigV1toV2 } from './config-loader.js';
import { ConfigSchema } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// AC: @google/genai removed from package.json
// ---------------------------------------------------------------------------

describe('@google/genai removal', () => {
  it('is not listed in package.json dependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.dependencies?.['@google/genai']).toBeUndefined();
  });

  it('is not listed in package.json devDependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.devDependencies?.['@google/genai']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC: v1 config (bare model names) triggers migration detection
// ---------------------------------------------------------------------------

describe('v1 config detection', () => {
  it('detects v1 config with bare claude model name', () => {
    const raw = { models: { quality: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' } };
    expect(isV1Config(raw)).toBe(true);
  });

  it('detects v1 config with bare gemini model name', () => {
    const raw = { models: { quality: 'gemini-2.5-flash', fast: 'gemini-2.5-flash-lite' } };
    expect(isV1Config(raw)).toBe(true);
  });

  it('detects v1 config with bare axis model name alongside models', () => {
    const raw = {
      models: { quality: 'anthropic/claude-sonnet-4-6' },
      axes: { utility: { model: 'gemini-2.5-flash' } },
    };
    expect(isV1Config(raw)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC: v2 config (prefixed names) does NOT trigger migration
// ---------------------------------------------------------------------------

describe('v2 config detection', () => {
  it('does not flag v2 config with prefixed model names', () => {
    const raw = {
      models: { quality: 'anthropic/claude-sonnet-4-6', fast: 'google/gemini-2.5-flash-lite' },
      axes: { utility: { model: 'google/gemini-2.5-flash' } },
    };
    expect(isV1Config(raw)).toBe(false);
  });

  it('does not flag empty config as v1', () => {
    expect(isV1Config({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC: migrateConfigV1toV2 produces valid v2 config
// ---------------------------------------------------------------------------

describe('migrateConfigV1toV2 produces parseable v2 config', () => {
  it('migrated project config parses with ConfigSchema', () => {
    const v1 = {
      providers: {
        anthropic: { concurrency: 24 },
        google: { mode: 'subscription', concurrency: 10 },
      },
      models: {
        quality: 'gemini-3-flash-preview',
        fast: 'gemini-2.5-flash-lite',
        deliberation: 'claude-opus-4-6',
        code_summary: 'gemini-2.5-flash-lite',
      },
      axes: {
        utility: { enabled: true, model: 'gemini-2.5-flash' },
        duplication: { enabled: true, model: 'gemini-2.5-flash' },
        overengineering: { enabled: true, model: 'gemini-2.5-flash' },
      },
    };

    const v2 = migrateConfigV1toV2(v1);

    // Models should be prefixed
    expect(v2.models.quality).toBe('google/gemini-3-flash-preview');
    expect(v2.models.fast).toBe('google/gemini-2.5-flash-lite');
    expect(v2.models.deliberation).toBe('anthropic/claude-opus-4-6');

    // Axes should be prefixed
    expect(v2.axes.utility.model).toBe('google/gemini-2.5-flash');

    // Should parse without errors
    expect(() => ConfigSchema.parse(v2)).not.toThrow();
  });

  it('already-prefixed names are not double-prefixed', () => {
    const v2Input = {
      models: { quality: 'anthropic/claude-sonnet-4-6' },
    };
    const result = migrateConfigV1toV2(v2Input);
    expect(result.models.quality).toBe('anthropic/claude-sonnet-4-6');
  });
});
