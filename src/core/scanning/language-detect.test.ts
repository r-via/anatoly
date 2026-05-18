// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Unit tests for the parts of `language-detect` that remain pure after the
 * Linguist delegation: `classifyFile` (sync extension/filename lookup) and
 * the two formatters. Language distribution and framework detection are
 * exercised end-to-end via `scanner.test.ts` and `estimator.test.ts` — those
 * paths use real temp directories with actual files on disk, which is the
 * only sensible way to test code that delegates to a filesystem-walking
 * library like linguist-js.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyFile,
  formatLanguageLine,
  formatFrameworkLine,
  EXTENSION_MAP,
  FILENAME_MAP,
  type FrameworkInfo,
  type LanguageInfo,
} from './language-detect.js';

describe('classifyFile', () => {
  it.each([
    ['src/index.ts', 'TypeScript'],
    ['src/App.tsx', 'TypeScript'],
    ['src/index.js', 'JavaScript'],
    ['src/App.jsx', 'JavaScript'],
    ['config.mjs', 'JavaScript'],
    ['config.cjs', 'JavaScript'],
    ['scripts/setup.sh', 'Shell'],
    ['scripts/deploy.bash', 'Shell'],
    ['scripts/migrate.py', 'Python'],
    ['src/main.rs', 'Rust'],
    ['cmd/main.go', 'Go'],
    ['src/Main.java', 'Java'],
    ['src/Program.cs', 'C#'],
    ['db/schema.sql', 'SQL'],
    ['.github/workflows/ci.yml', 'YAML'],
    ['package.json', 'JSON'],
  ])('classifies %s as %s via EXTENSION_MAP', (path, expected) => {
    expect(classifyFile(path)).toBe(expected);
  });

  it('classifies Dockerfile via FILENAME_MAP', () => {
    expect(classifyFile('Dockerfile')).toBe('Docker');
  });

  it('classifies nested Dockerfile', () => {
    expect(classifyFile('docker/build/Dockerfile')).toBe('Docker');
  });

  it('classifies Makefile via FILENAME_MAP', () => {
    expect(classifyFile('Makefile')).toBe('Makefile');
  });

  it('returns null for unknown extensions', () => {
    expect(classifyFile('src/data.xyz')).toBeNull();
  });

  it('returns null for extensionless files not in FILENAME_MAP', () => {
    expect(classifyFile('LICENSE')).toBeNull();
  });
});

describe('EXTENSION_MAP / FILENAME_MAP shape', () => {
  it('EXTENSION_MAP entries all start with a dot', () => {
    for (const ext of Object.keys(EXTENSION_MAP)) {
      expect(ext.startsWith('.')).toBe(true);
    }
  });

  it('FILENAME_MAP entries are bare filenames (no extension prefix, no path)', () => {
    for (const name of Object.keys(FILENAME_MAP)) {
      expect(name).not.toContain('/');
      expect(name.startsWith('.')).toBe(false);
    }
  });
});

describe('formatLanguageLine', () => {
  it('formats a single-language distribution', () => {
    const langs: LanguageInfo[] = [{ name: 'TypeScript', percentage: 100, fileCount: 13 }];
    expect(formatLanguageLine(langs)).toBe('TypeScript 100%');
  });

  it('formats a multi-language distribution with the · separator', () => {
    const langs: LanguageInfo[] = [
      { name: 'TypeScript', percentage: 85, fileCount: 17 },
      { name: 'Shell', percentage: 10, fileCount: 2 },
      { name: 'YAML', percentage: 5, fileCount: 1 },
    ];
    expect(formatLanguageLine(langs)).toBe('TypeScript 85% · Shell 10% · YAML 5%');
  });

  it('returns the empty string for an empty distribution', () => {
    expect(formatLanguageLine([])).toBe('');
  });
});

describe('formatFrameworkLine', () => {
  it('formats a single framework', () => {
    const fws: FrameworkInfo[] = [{ id: 'nextjs', name: 'Next.js', language: 'TypeScript', category: 'frontend' }];
    expect(formatFrameworkLine(fws)).toBe('Next.js');
  });

  it('formats multiple frameworks with the · separator', () => {
    const fws: FrameworkInfo[] = [
      { id: 'nextjs', name: 'Next.js', language: 'TypeScript', category: 'frontend' },
      { id: 'prisma', name: 'Prisma', language: 'TypeScript', category: 'orm' },
    ];
    expect(formatFrameworkLine(fws)).toBe('Next.js · Prisma');
  });

  it('returns the empty string for no frameworks', () => {
    expect(formatFrameworkLine([])).toBe('');
  });
});
