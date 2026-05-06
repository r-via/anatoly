// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoDetectScanGlobs } from './scan-autodetect.js';
import { collectFiles } from './scanner.js';
import { ConfigSchema, type Config } from '../schemas/config.js';
import type { ProjectProfile } from './language-detect.js';

function buildProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    languages: { languages: [], totalFiles: 0 },
    frameworks: [],
    types: [],
    capabilities: [],
    primaryLanguage: null,
    ...overrides,
  };
}

function loadCfg(scan: Partial<Config['scan']>): Config {
  return ConfigSchema.parse({
    scan: { include: ['**/*'], exclude: [], ...scan },
    providers: { anthropic: { mode: 'subscription', concurrency: 24 } },
  });
}

describe('autoDetectScanGlobs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autodetect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a permissive default when no languages are detected', () => {
    const result = autoDetectScanGlobs(dir, buildProfile());
    expect(result.include).toEqual(['src/**/*']);
    expect(result.exclude).toContain('node_modules/**');
  });

  it('emits TypeScript globs rooted at src/ when src exists and TS is dominant', () => {
    mkdirSync(join(dir, 'src'));
    const profile = buildProfile({
      languages: {
        languages: [{ name: 'TypeScript', percentage: 100, fileCount: 10 }],
        totalFiles: 10,
      },
      primaryLanguage: 'TypeScript',
    });
    const result = autoDetectScanGlobs(dir, profile);
    expect(result.include).toContain('src/**/*.{ts,tsx}');
    expect(result.exclude).toContain('node_modules/**');
    expect(result.exclude).toContain('dist/**');
  });

  it('falls back to project-root globs when no conventional layout is present', () => {
    const profile = buildProfile({
      languages: {
        languages: [{ name: 'Python', percentage: 100, fileCount: 5 }],
        totalFiles: 5,
      },
      primaryLanguage: 'Python',
    });
    const result = autoDetectScanGlobs(dir, profile);
    expect(result.include).toContain('**/*.py');
    expect(result.exclude).toContain('venv/**');
    expect(result.exclude).toContain('__pycache__/**');
  });

  it('expands monorepo workspaces from package.json into root entries', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    const profile = buildProfile({
      languages: {
        languages: [{ name: 'TypeScript', percentage: 100, fileCount: 10 }],
        totalFiles: 10,
      },
    });
    const result = autoDetectScanGlobs(dir, profile);
    expect(result.include).toContain('packages/*/src/**/*.{ts,tsx}');
  });

  it('only adds test-file excludes when a testing framework is detected', () => {
    const profile = buildProfile({
      languages: {
        languages: [{ name: 'TypeScript', percentage: 100, fileCount: 10 }],
        totalFiles: 10,
      },
      frameworks: [{ id: 'vitest', name: 'Vitest', language: 'typescript', category: 'testing' }],
    });
    const result = autoDetectScanGlobs(dir, profile);
    expect(result.exclude).toContain('**/*.test.ts');
    expect(result.exclude).toContain('**/*.spec.ts');
  });

  it('drops languages below the 5% noise threshold', () => {
    const profile = buildProfile({
      languages: {
        languages: [
          { name: 'TypeScript', percentage: 96, fileCount: 96 },
          { name: 'Shell', percentage: 4, fileCount: 4 },
        ],
        totalFiles: 100,
      },
    });
    const result = autoDetectScanGlobs(dir, profile);
    // Shell extension should not appear in any include glob
    expect(result.include.every((g) => !g.includes('.sh'))).toBe(true);
  });
});

describe('collectFiles + scan.respect_gitignore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gitignore-scan-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'ignored.ts'), 'export const y = 2;');
    execFileSync('git', ['add', 'tracked.ts', '.gitignore'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters out gitignored files when respect_gitignore is true (default)', async () => {
    const cfg = loadCfg({ include: ['**/*.ts'], respect_gitignore: true });
    const files = await collectFiles(dir, cfg);
    expect(files).toContain('tracked.ts');
    expect(files).not.toContain('ignored.ts');
  });

  it('keeps gitignored files in scope when respect_gitignore is false', async () => {
    const cfg = loadCfg({ include: ['**/*.ts'], respect_gitignore: false });
    const files = await collectFiles(dir, cfg);
    expect(files).toContain('tracked.ts');
    expect(files).toContain('ignored.ts');
  });
});
