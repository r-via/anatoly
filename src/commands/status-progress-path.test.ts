// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 53.2 — Verify progress.json path in `anatoly status`.
 *
 * AC: The path used is `.anatoly/cache/progress.json` (not legacy `.anatoly/progress.json`).
 * AC: progress bar appears when cache/progress.json is populated.
 * AC: progress bar does NOT appear for legacy `.anatoly/progress.json` alone.
 * AC: ban grep ensures no legacy path references remain in src/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { ProgressManager } from '../core/progress-manager.js';

describe('status progress path (Story 53.2)', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-status-prog-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * Helper: create a populated progress.json at the given path.
   */
  function writeProgressJson(path: string): void {
    const progress = {
      version: 1,
      started_at: new Date().toISOString(),
      files: {
        'src/app.ts': {
          file: 'src/app.ts',
          hash: 'abc123',
          status: 'DONE',
          updated_at: new Date().toISOString(),
        },
        'src/util.ts': {
          file: 'src/util.ts',
          hash: 'def456',
          status: 'PENDING',
          updated_at: new Date().toISOString(),
        },
      },
    };
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(progress, null, 2));
  }

  it('reads progress from .anatoly/cache/progress.json (correct path)', () => {
    const projectRoot = join(base, 'project');
    const correctPath = join(projectRoot, '.anatoly', 'cache', 'progress.json');

    writeProgressJson(correctPath);
    expect(existsSync(correctPath)).toBe(true);

    // ProgressManager should find the file at the correct path

    const pm = new ProgressManager(projectRoot);
    const total = pm.totalFiles();
    expect(total).toBe(2);

    const summary = pm.getSummary();
    expect(summary.DONE).toBe(1);
    expect(summary.PENDING).toBe(1);
  });

  it('does NOT read progress from legacy .anatoly/progress.json', () => {
    const projectRoot = join(base, 'project-legacy');
    const legacyPath = join(projectRoot, '.anatoly', 'progress.json');

    writeProgressJson(legacyPath);
    expect(existsSync(legacyPath)).toBe(true);

    // Correct path does NOT exist
    const correctPath = join(projectRoot, '.anatoly', 'cache', 'progress.json');
    expect(existsSync(correctPath)).toBe(false);

    // ProgressManager should not find any progress at the legacy path

    const pm = new ProgressManager(projectRoot);
    const total = pm.totalFiles();
    expect(total).toBe(0);
  });

  it('progress percentage is (DONE + CACHED) / total * 100', () => {
    const projectRoot = join(base, 'project-pct');
    const progressPath = join(projectRoot, '.anatoly', 'cache', 'progress.json');

    const progress = {
      version: 1,
      started_at: new Date().toISOString(),
      files: {
        'src/a.ts': { file: 'src/a.ts', hash: 'h1', status: 'DONE', updated_at: new Date().toISOString() },
        'src/b.ts': { file: 'src/b.ts', hash: 'h2', status: 'CACHED', updated_at: new Date().toISOString() },
        'src/c.ts': { file: 'src/c.ts', hash: 'h3', status: 'PENDING', updated_at: new Date().toISOString() },
        'src/d.ts': { file: 'src/d.ts', hash: 'h4', status: 'IN_PROGRESS', updated_at: new Date().toISOString() },
      },
    };
    mkdirSync(join(progressPath, '..'), { recursive: true });
    writeFileSync(progressPath, JSON.stringify(progress, null, 2));


    const pm = new ProgressManager(projectRoot);
    const summary = pm.getSummary();
    const total = pm.totalFiles();
    const completed = summary.DONE + summary.CACHED;
    const pct = Math.round((completed / total) * 100);

    expect(total).toBe(4);
    expect(completed).toBe(2); // DONE + CACHED
    expect(pct).toBe(50);
  });
});

describe('ban grep: no legacy .anatoly/progress.json paths in src/ (Story 53.2)', () => {
  const SRC = join(process.cwd(), 'src');

  /**
   * Recursively collect all .ts files under a directory (excluding test files).
   */
  function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        results.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  it('no .anatoly/progress.json (without cache/) in application code', () => {
    const files = collectTsFiles(SRC);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match '.anatoly/progress.json' or ".anatoly/progress.json" but NOT '.anatoly/cache/progress.json'
        if (/\.anatoly\/progress\.json/.test(line) && !/\.anatoly\/cache\/progress\.json/.test(line)) {
          violations.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
