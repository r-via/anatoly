// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerCacheCommand } from './cache.js';
import { pkgVersion } from '../utils/version.js';

// Reseed integration test: scaffolds a runs/<id>/reviews/ from a known
// payload, runs `cache reseed`, and asserts the project-global cache now
// contains an entry for the file with the right axis coverage.
//
// We do NOT mock writeProjectReview — the goal is to verify the wiring
// produces a real, schema-valid cache layout consumable by the existing
// review-phase reader.

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function makeReviewFixture(file: string): string {
  // Minimal but valid v2 ReviewFile with all axes carrying non-`-` verdicts,
  // so computeCoveredAxes returns the full set.
  return JSON.stringify({
    version: 2,
    file,
    is_generated: false,
    verdict: 'CLEAN',
    symbols: [{
      name: 'doWork',
      kind: 'function',
      exported: true,
      line_start: 1,
      line_end: 10,
      correction: 'OK',
      overengineering: 'LEAN',
      utility: 'USED',
      duplication: 'UNIQUE',
      tests: 'GOOD',
      documentation: 'DOCUMENTED',
      confidence: 90,
      detail: '[OK] no bug | [USED] imported 3x | [LEAN] simple',
    }],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    best_practices: {
      score: 9,
      rules: [],
      suggestions: [],
    },
  });
}

let testDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let exitCodeBefore: typeof process.exitCode;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'anatoly-cache-reseed-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Minimal config so loadConfig() doesn't blow up. We don't drive routing,
  // we just need a valid config that resolves models for the enabled axes.
  writeFile(join(testDir, '.anatoly.yml'), `
project:
  name: reseed-test
providers:
  anthropic:
    mode: subscription
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
  code_summary: anthropic/claude-haiku-4-5-20251001
documentation:
  enabled: true
  reference:
    paths: [README.md]
    inline_comments:
      enabled: false
  internal:
    mode: lite
`);
});

afterEach(() => {
  cwdSpy.mockRestore();
  consoleSpy.mockRestore();
  process.exitCode = exitCodeBefore;
  rmSync(testDir, { recursive: true, force: true });
});

async function runReseedCmd(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCacheCommand(program);
  await program.parseAsync(['cache', 'reseed', ...args], { from: 'user' });
}

describe('anatoly cache reseed', () => {
  it('reseeds a review from a prior run into the project cache', async () => {
    // Source code that will be cache-keyed
    writeFile(join(testDir, 'src/foo.ts'), 'export function doWork() { return 1; }\n');
    // Pretend a prior run produced a full review
    const runDir = join(testDir, '.anatoly', 'runs', '2026-01-01_000000');
    writeFile(join(runDir, 'reviews', 'src-foo.rev.json'), makeReviewFixture('src/foo.ts'));
    writeFile(join(runDir, 'run-config.json'), JSON.stringify({
      runId: '2026-01-01_000000',
      timestamp: '2026-01-01T00:00:00.000Z',
      anatolyVersion: pkgVersion,
      anatolyCommit: 'test',
      projectRoot: testDir,
      concurrency: 1,
      ragMode: 'auto',
      enableRag: false,
      noCache: false,
      deliberation: false,
      dryRun: false,
      axesFilter: null,
      fileFilter: null,
      badge: { enabled: false, verdict: false },
      config: {},
    }));
    // Make `latest` point at this run
    writeFile(join(testDir, '.anatoly', 'runs', 'latest'), '2026-01-01_000000');

    await runReseedCmd([]);

    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const indexPath = join(testDir, '.anatoly', 'cache', 'review-index.json');
    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(index.files['src/foo.ts']).toBeDefined();
    const entry = index.files['src/foo.ts'];
    expect(entry.status).toBe('DONE');
    // All 7 axes covered (correction, overengineering, utility, duplication,
    // tests, documentation, best_practices)
    expect(entry.axes.sort()).toEqual([
      'best_practices', 'correction', 'documentation', 'duplication',
      'overengineering', 'tests', 'utility',
    ].sort());
  });

  it('skips reviews whose source file no longer exists', async () => {
    // Do NOT create src/foo.ts
    const runDir = join(testDir, '.anatoly', 'runs', '2026-01-01_000000');
    writeFile(join(runDir, 'reviews', 'src-foo.rev.json'), makeReviewFixture('src/foo.ts'));
    writeFile(join(runDir, 'run-config.json'), JSON.stringify({
      runId: '2026-01-01_000000',
      timestamp: '2026-01-01T00:00:00.000Z',
      anatolyVersion: pkgVersion,
      anatolyCommit: 'test',
      projectRoot: testDir,
      concurrency: 1,
      ragMode: 'auto',
      enableRag: false,
      noCache: false,
      deliberation: false,
      dryRun: false,
      axesFilter: null,
      fileFilter: null,
      badge: { enabled: false, verdict: false },
      config: {},
    }));
    writeFile(join(testDir, '.anatoly', 'runs', 'latest'), '2026-01-01_000000');

    await runReseedCmd([]);

    const indexPath = join(testDir, '.anatoly', 'cache', 'review-index.json');
    // Either no index written (zero reseeded) or an empty files map
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      expect(index.files['src/foo.ts']).toBeUndefined();
    }
  });

  it('refuses to proceed when the source run is from a different anatoly version (unless --force)', async () => {
    writeFile(join(testDir, 'src/foo.ts'), 'export function doWork() { return 1; }\n');
    const runDir = join(testDir, '.anatoly', 'runs', '2026-01-01_000000');
    writeFile(join(runDir, 'reviews', 'src-foo.rev.json'), makeReviewFixture('src/foo.ts'));
    writeFile(join(runDir, 'run-config.json'), JSON.stringify({
      runId: '2026-01-01_000000',
      timestamp: '2026-01-01T00:00:00.000Z',
      anatolyVersion: '0.0.0-ancient',  // mismatch
      anatolyCommit: 'old',
      projectRoot: testDir,
      concurrency: 1,
      ragMode: 'auto',
      enableRag: false,
      noCache: false,
      deliberation: false,
      dryRun: false,
      axesFilter: null,
      fileFilter: null,
      badge: { enabled: false, verdict: false },
      config: {},
    }));
    writeFile(join(testDir, '.anatoly', 'runs', 'latest'), '2026-01-01_000000');

    await runReseedCmd([]);

    expect(process.exitCode).toBe(2);
    const indexPath = join(testDir, '.anatoly', 'cache', 'review-index.json');
    expect(existsSync(indexPath)).toBe(false);

    // --force bypasses the guard
    process.exitCode = undefined;
    await runReseedCmd(['--force']);
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    expect(existsSync(indexPath)).toBe(true);
  });

  it('fails clearly when no run matches the supplied id', async () => {
    await runReseedCmd(['nonexistent_run_id']);
    expect(process.exitCode).toBe(2);
  });

  it('writes review blobs to the content-addressable cache directory', async () => {
    writeFile(join(testDir, 'src/foo.ts'), 'export function doWork() { return 1; }\n');
    const runDir = join(testDir, '.anatoly', 'runs', '2026-01-01_000000');
    writeFile(join(runDir, 'reviews', 'src-foo.rev.json'), makeReviewFixture('src/foo.ts'));
    writeFile(join(runDir, 'run-config.json'), JSON.stringify({
      runId: '2026-01-01_000000',
      timestamp: '2026-01-01T00:00:00.000Z',
      anatolyVersion: pkgVersion,
      anatolyCommit: 'test',
      projectRoot: testDir,
      concurrency: 1,
      ragMode: 'auto',
      enableRag: false,
      noCache: false,
      deliberation: false,
      dryRun: false,
      axesFilter: null,
      fileFilter: null,
      badge: { enabled: false, verdict: false },
      config: {},
    }));
    writeFile(join(testDir, '.anatoly', 'runs', 'latest'), '2026-01-01_000000');

    await runReseedCmd([]);

    const cacheReviewsDir = join(testDir, '.anatoly', 'cache', 'reviews');
    expect(existsSync(cacheReviewsDir)).toBe(true);
    // At least one shard subdirectory exists
    const shards = readdirSync(cacheReviewsDir);
    expect(shards.length).toBeGreaterThan(0);
  });
});
