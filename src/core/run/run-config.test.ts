// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDocMode, buildRunConfig, writeRunConfig, readRunConfig } from './run-config.js';
import { parseTestConfig } from '../../schemas/test-fixtures.js';
import { ConfigSchema, type Config } from '../../schemas/config.js';

describe('resolveDocMode', () => {
  it('returns "off" when documentation.internal.mode is "off"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(resolveDocMode(config)).toBe('off');
  });

  it('returns "lite" when documentation.internal.mode is "lite"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: {
          mode: 'lite',
          lite: { max_tokens: 4000, refresh_on: ['code_change'] },
        },
      },
    });
    expect(resolveDocMode(config)).toBe('lite');
  });

  it('returns "full" when documentation.internal.mode is "full"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: {
          mode: 'full',
          full: { sync_to_repo: false },
        },
      },
    });
    expect(resolveDocMode(config)).toBe('full');
  });

  it('returns a strict union type (no undefined, no generic string)', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    const result = resolveDocMode(config);
    // The result must be one of the three valid values — never undefined
    expect(['off', 'lite', 'full']).toContain(result);
    expect(result).toBeDefined();
  });

  it('throws Zod error when documentation.internal.mode is absent', () => {
    expect(() => {
      ConfigSchema.parse({
        documentation: {
          reference: { paths: ['README.md'], inline_comments: { enabled: false } },
          internal: {},
        },
      });
    }).toThrow();
  });

  it('throws Zod error when documentation section is absent', () => {
    expect(() => {
      ConfigSchema.parse({});
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildRunConfig / readRunConfig — cache flag persistence
// ---------------------------------------------------------------------------
//
// Regression guards for the --cache-refresh feature: the new flag must be
// persisted in run-config.json so a re-render or downstream consumer
// (anatoly-bench, audit comparison tooling) can tell that this run's
// findings were the result of a forced refresh, not a cache replay.

describe('cache flags in RunConfig', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), `anatoly-rcfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const baseConfig: Config = parseTestConfig({
    documentation: {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' },
    },
  });

  const baseInput = {
    runId: 'r1',
    projectRoot: '/p',
    concurrency: 4,
    ragMode: 'auto' as const,
    enableRag: true,
    deliberation: false,
    dryRun: false,
    badge: { enabled: false, verdict: false },
    config: baseConfig,
  };

  it('records noCache=false and cacheRefresh=undefined for a default run', () => {
    const cfg = buildRunConfig({ ...baseInput, noCache: false });
    expect(cfg.noCache).toBe(false);
    expect(cfg.cacheRefresh).toBeUndefined();
  });

  it('records noCache=true for a --no-cache run', () => {
    const cfg = buildRunConfig({ ...baseInput, noCache: true });
    expect(cfg.noCache).toBe(true);
    expect(cfg.cacheRefresh).toBeUndefined();
  });

  it('records cacheRefresh=true for a --cache-refresh run', () => {
    const cfg = buildRunConfig({ ...baseInput, noCache: false, cacheRefresh: true });
    expect(cfg.noCache).toBe(false);
    expect(cfg.cacheRefresh).toBe(true);
  });

  it('round-trips cacheRefresh through write + read', () => {
    mkdirSync(join(testDir, '.anatoly'), { recursive: true });
    const cfg = buildRunConfig({ ...baseInput, noCache: false, cacheRefresh: true });
    writeRunConfig(testDir, cfg);
    const loaded = readRunConfig(testDir);
    expect(loaded?.cacheRefresh).toBe(true);
    expect(loaded?.noCache).toBe(false);
  });
});
