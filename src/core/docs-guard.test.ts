// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeOutputPath } from './docs-guard.js';
import { scaffoldDocs } from './doc-scaffolder.js';

/**
 * Story 29.6: Guard Test — Anatoly Never Writes to docs/
 *
 * Tests enforce the invariant that Anatoly NEVER writes to the
 * project's docs/ directory. Only Ralph can do that.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'anatoly-guard-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('assertSafeOutputPath', () => {
  // --- AC: throws when path resolves to docs/ ---
  it('throws when path is inside docs/', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, 'docs', 'page.md'), tmpDir);
    }).toThrow(/INVARIANT VIOLATION/);
  });

  it('throws when path is the docs/ directory itself', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, 'docs'), tmpDir);
    }).toThrow(/INVARIANT VIOLATION/);
  });

  it('throws when path is a nested file inside docs/', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, 'docs', 'architecture', 'overview.md'), tmpDir);
    }).toThrow(/INVARIANT VIOLATION/);
  });

  // --- AC: clear error message explaining the invariant ---
  it('error message explains the invariant clearly', () => {
    try {
      assertSafeOutputPath(join(tmpDir, 'docs', 'test.md'), tmpDir);
      expect.fail('Should have thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('INVARIANT VIOLATION');
      expect(msg).toContain('Anatoly must NEVER write to docs/');
      expect(msg).toContain('Only Ralph can modify docs/');
    }
  });

  // --- Safe paths do NOT throw ---
  it('does NOT throw for .anatoly/docs/ paths', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, '.anatoly', 'docs', 'page.md'), tmpDir);
    }).not.toThrow();
  });

  it('does NOT throw for .anatoly/reviews/ paths', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, '.anatoly', 'reviews', 'file.json'), tmpDir);
    }).not.toThrow();
  });

  it('does NOT throw for src/ paths', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, 'src', 'core', 'scanner.ts'), tmpDir);
    }).not.toThrow();
  });

  it('does NOT throw for docs-related paths that are not docs/', () => {
    expect(() => {
      assertSafeOutputPath(join(tmpDir, 'docs-backup', 'file.md'), tmpDir);
    }).not.toThrow();
  });
});

describe('scaffolder docs/ invariant (integration)', () => {
  it('scaffoldDocs never creates files in docs/', () => {
    const docsDir = join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'existing.md'), '# Existing');

    // Record docs/ state before
    const filesBefore = readdirSync(docsDir);
    const contentBefore = readFileSync(join(docsDir, 'existing.md'), 'utf-8');

    // Run scaffolder with all project types
    const outputDir = join(tmpDir, '.anatoly', 'docs');
    scaffoldDocs(outputDir, ['Backend API', 'ORM', 'CLI', 'Frontend'], { name: 'test' });

    // docs/ must be identical
    const filesAfter = readdirSync(docsDir);
    const contentAfter = readFileSync(join(docsDir, 'existing.md'), 'utf-8');

    expect(filesAfter).toEqual(filesBefore);
    expect(contentAfter).toBe(contentBefore);
  });

  it('scaffoldDocs never creates a docs/ directory if none existed', () => {
    // No docs/ directory exists
    const outputDir = join(tmpDir, '.anatoly', 'docs');
    scaffoldDocs(outputDir, ['Library'], { name: 'test' });

    // docs/ must NOT have been created
    const docsDir = join(tmpDir, 'docs');
    const exists = readdirSync(tmpDir).includes('docs');
    expect(exists).toBe(false);
  });
});

describe('static analysis — no write to docs/ in pipeline files', () => {
  it('pipeline source files do not contain writeFile/writeFileSync targeting docs/', async () => {
    const srcDir = resolve(import.meta.dirname, '..');
    const pipelineFiles = findTsFiles(srcDir);

    for (const filePath of pipelineFiles) {
      // Skip test files — they may legitimately reference docs/ in assertions
      if (filePath.endsWith('.test.ts')) continue;
      // Skip the guard itself
      if (filePath.includes('docs-guard')) continue;

      const content = readFileSync(filePath, 'utf-8');

      // Check for writeFile/writeFileSync calls that reference docs/ literally
      // This catches obvious mistakes like writeFileSync('docs/...')
      const dangerousPatterns = [
        /writeFile(?:Sync)?\s*\(\s*['"`]docs\//g,
        /writeFile(?:Sync)?\s*\(\s*['"`]\.\/docs\//g,
      ];

      for (const pattern of dangerousPatterns) {
        const match = pattern.exec(content);
        expect(
          match,
          `${filePath} contains a write targeting docs/: ${match?.[0]}`,
        ).toBeNull();
      }
    }
  });
});

/** Recursively find all .ts files in a directory. */
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'standards') {
      results.push(...findTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}
