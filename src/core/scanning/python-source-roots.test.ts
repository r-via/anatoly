// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectPythonSourceRoots } from './python-source-roots.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `anatoly-pyroots-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(testDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('detectPythonSourceRoots', () => {
  it('returns project-root only when no pyproject.toml and no src/ directory', () => {
    expect(detectPythonSourceRoots(testDir)).toEqual(['']);
  });

  it('adds src/ via heuristic when the directory exists', () => {
    mkdirSync(join(testDir, 'src'));
    const roots = detectPythonSourceRoots(testDir);
    expect(roots).toContain('');
    expect(roots).toContain('src');
  });

  it('parses setuptools packages.find.where', () => {
    write('pyproject.toml', '[tool.setuptools.packages.find]\nwhere = ["src", "lib"]\n');
    const roots = detectPythonSourceRoots(testDir);
    expect(roots).toContain('src');
    expect(roots).toContain('lib');
  });

  it('parses poetry packages[].from', () => {
    write(
      'pyproject.toml',
      '[tool.poetry]\nname = "demo"\npackages = [\n  {include = "a", from = "src"},\n  {include = "b", from = "vendor"},\n]\n',
    );
    const roots = detectPythonSourceRoots(testDir);
    expect(roots).toContain('src');
    expect(roots).toContain('vendor');
  });

  it('parses hatch wheel packages (top segment only)', () => {
    write(
      'pyproject.toml',
      '[tool.hatch.build.targets.wheel]\npackages = ["src/foo", "src/bar"]\n',
    );
    const roots = detectPythonSourceRoots(testDir);
    expect(roots).toContain('src');
  });

  it('does not bleed across tables', () => {
    write(
      'pyproject.toml',
      '[tool.ruff]\nsrc = ["unrelated"]\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n\n[tool.mypy]\nfiles = ["src"]\n',
    );
    const roots = detectPythonSourceRoots(testDir);
    expect(roots).toContain('src');
    expect(roots).not.toContain('unrelated');
  });

  it('survives malformed pyproject.toml without throwing', () => {
    write('pyproject.toml', 'this is not valid toml ][ ');
    expect(() => detectPythonSourceRoots(testDir)).not.toThrow();
    expect(detectPythonSourceRoots(testDir)).toEqual(['']);
  });
});
