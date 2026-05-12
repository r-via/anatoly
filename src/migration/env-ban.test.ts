// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.6 — Ban tests:
 *   AC5: No process.env.{HF_HOME,TRANSFORMERS_CACHE,XDG_*} reads outside anatoly-paths.ts
 *   AC6: No .cache/anatoly or .cache/huggingface references in application code
 *
 * These tests scan the source tree to enforce path discipline.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * Recursively collect all .ts files under a directory,
 * optionally excluding test files.
 */
function collectTsFiles(dir: string, excludeTests: boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectTsFiles(full, excludeTests));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      if (excludeTests && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.bench.ts'))) {
        continue;
      }
      results.push(full);
    }
  }
  return results;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * Search for a pattern in source files. Returns matching lines with metadata.
 */
function grepSrc(pattern: RegExp, excludeTests = true): GrepMatch[] {
  const files = collectTsFiles(SRC, excludeTests);
  const matches: GrepMatch[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        matches.push({
          file: relative(SRC, file),
          line: i + 1,
          content: lines[i].trim(),
        });
      }
    }
  }
  return matches;
}

describe('AC5: ban env var reads outside anatoly-paths.ts', () => {
  it('no process.env.HF_HOME reads outside anatoly-paths.ts', () => {
    const matches = grepSrc(/process\.env\.HF_HOME/)
      .filter((m) => !m.file.includes('anatoly-paths.ts'));

    expect(matches).toEqual([]);
  });

  it('no process.env.TRANSFORMERS_CACHE reads outside anatoly-paths.ts', () => {
    const matches = grepSrc(/process\.env\.TRANSFORMERS_CACHE/)
      .filter((m) => !m.file.includes('anatoly-paths.ts'));

    expect(matches).toEqual([]);
  });

  it('no process.env.XDG_* reads in application code', () => {
    const matches = grepSrc(/process\.env\.XDG_/);
    expect(matches).toEqual([]);
  });
});

describe('AC6: ban ~/.cache/ references in application code', () => {
  it('no .cache/anatoly references in code (migration module OK)', () => {
    const matches = grepSrc(/\.cache\/anatoly/)
      // Allow references in migration detection module
      .filter((m) => !m.file.includes('legacy-detection.ts'));

    expect(matches).toEqual([]);
  });

  it('no .cache/huggingface references in code (comments OK)', () => {
    const matches = grepSrc(/\.cache\/huggingface/)
      // Allow comment lines (docstrings / inline comments)
      .filter((m) => {
        const trimmed = m.content.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//');
      });

    expect(matches).toEqual([]);
  });
});
