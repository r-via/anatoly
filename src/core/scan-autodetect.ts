// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * First-run scan auto-detection.
 *
 * Generates concrete `scan.include` / `scan.exclude` glob lists for the
 * `.anatoly.yml` template the wizard writes. Run *once* at write time only —
 * the result is baked into the yaml so the user can read and edit it. There
 * is no runtime auto-augmentation (cf. the removed `auto_detect` flag).
 *
 * Strategy:
 * - Detect the project profile (languages + frameworks) via `detectProjectProfile`.
 * - Pick a small set of source roots from manifest signals (package.json,
 *   tsconfig.json, Cargo.toml, pyproject.toml, go.mod) and directory presence.
 * - For each language ≥5%, cross-product (root × extensions) → include globs.
 * - Build exclude list from standard vendor/build dirs per detected language.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectProfile } from './language-detect.js';

export interface ScanAutoDetectResult {
  include: string[];
  exclude: string[];
}

/** Extensions per canonical language name from `detectLanguages`. */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  TypeScript: ['ts', 'tsx'],
  JavaScript: ['js', 'jsx', 'mjs', 'cjs'],
  Python: ['py'],
  Rust: ['rs'],
  Go: ['go'],
  Java: ['java'],
  'C#': ['cs'],
  Shell: ['sh', 'bash'],
  SQL: ['sql'],
};

/** Vendor/build dirs to exclude per detected language. */
const LANGUAGE_VENDOR_EXCLUDES: Record<string, string[]> = {
  TypeScript: ['node_modules/**', 'dist/**', 'build/**', '.next/**', 'coverage/**'],
  JavaScript: ['node_modules/**', 'dist/**', 'build/**', '.next/**', 'coverage/**'],
  Python: ['venv/**', '.venv/**', '__pycache__/**', '**/__pycache__/**', '*.egg-info/**', '.tox/**'],
  Rust: ['target/**'],
  Go: ['vendor/**', 'bin/**'],
  Java: ['target/**', 'build/**', '.gradle/**'],
  'C#': ['bin/**', 'obj/**'],
};

/** Always-applied excludes regardless of language. */
const BASE_EXCLUDES = ['.git/**', '.anatoly/**'];

/**
 * Build include/exclude glob lists for the project at `projectRoot` based on
 * its detected profile. Pure read-only — no filesystem mutation.
 */
export function autoDetectScanGlobs(
  projectRoot: string,
  profile: ProjectProfile,
): ScanAutoDetectResult {
  const langs = profile.languages.languages.filter((l) => l.percentage >= 5);
  if (langs.length === 0) {
    // Nothing detected — emit a permissive default so the run doesn't no-op.
    return { include: ['src/**/*'], exclude: [...BASE_EXCLUDES, 'node_modules/**', 'dist/**'] };
  }

  const roots = detectRoots(projectRoot, profile);
  const includeSet = new Set<string>();
  for (const lang of langs) {
    const exts = LANGUAGE_EXTENSIONS[lang.name];
    if (!exts) continue;
    const extGlob = exts.length === 1 ? exts[0] : `{${exts.join(',')}}`;
    for (const root of roots) {
      includeSet.add(root === '.' ? `**/*.${extGlob}` : `${root}/**/*.${extGlob}`);
    }
  }

  const excludeSet = new Set<string>(BASE_EXCLUDES);
  for (const lang of langs) {
    const v = LANGUAGE_VENDOR_EXCLUDES[lang.name];
    if (v) for (const e of v) excludeSet.add(e);
  }
  // Test files: only add if a testing framework is in the profile, so we
  // don't silently drop tests in projects that audit them on purpose.
  const hasJsTesting = profile.frameworks.some((f) => f.id === 'vitest' || f.id === 'jest');
  if (hasJsTesting) {
    excludeSet.add('**/*.test.ts');
    excludeSet.add('**/*.test.tsx');
    excludeSet.add('**/*.test.js');
    excludeSet.add('**/*.spec.ts');
    excludeSet.add('**/*.spec.js');
  }
  const hasPyTesting = profile.frameworks.some((f) => f.id === 'pytest');
  if (hasPyTesting) {
    excludeSet.add('**/test_*.py');
    excludeSet.add('**/*_test.py');
    excludeSet.add('tests/**');
  }

  return {
    include: Array.from(includeSet).sort(),
    exclude: Array.from(excludeSet).sort(),
  };
}

/**
 * Pick source-root directories for the project. Falls back to `.` when no
 * conventional layout matches — combined with vendor excludes that's still
 * safe.
 */
function detectRoots(projectRoot: string, profile: ProjectProfile): string[] {
  const roots = new Set<string>();

  // src/ is the dominant convention across TS/Rust/Java; accept it on sight.
  if (existsSync(join(projectRoot, 'src'))) roots.add('src');

  // package.json hints (workspaces → monorepo, files → publish set)
  const pkg = safeReadJson(join(projectRoot, 'package.json'));
  if (pkg) {
    const ws = pkg['workspaces'];
    const wsList = Array.isArray(ws) ? ws : (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: string[] }).packages
      : null);
    if (wsList) {
      for (const w of wsList) {
        // `packages/*` → `packages/*/src` if any sibling has src; else `packages/*`
        roots.add(`${stripTrailingSlash(w)}/src`);
      }
    }
  }

  // tsconfig.json `include` (best-effort — JSON5 with comments is common, so
  // failures are silent and we just keep src/).
  const tsconfig = safeReadJson(join(projectRoot, 'tsconfig.json'));
  if (tsconfig && Array.isArray(tsconfig['include'])) {
    for (const inc of tsconfig['include'] as unknown[]) {
      if (typeof inc !== 'string') continue;
      const dir = inc.replace(/\/?\*\*\/?\*?.*$/, '').replace(/\/$/, '');
      if (dir && !dir.startsWith('.')) roots.add(dir);
    }
  }

  // Python: pyproject [tool.poetry.packages] / [project] is hard to parse
  // without a TOML lib; trust src/ + bare layout. Add common dirs if present.
  const langNames = new Set(profile.languages.languages.map((l) => l.name));
  if (langNames.has('Python')) {
    for (const dir of ['app', 'lib']) {
      if (existsSync(join(projectRoot, dir))) roots.add(dir);
    }
  }

  // Go: cmd/ and internal/ are canonical when src/ is absent.
  if (langNames.has('Go')) {
    for (const dir of ['cmd', 'internal', 'pkg']) {
      if (existsSync(join(projectRoot, dir))) roots.add(dir);
    }
  }

  // Fallback: nothing detected, scan from project root.
  if (roots.size === 0) roots.add('.');

  return Array.from(roots).sort();
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
