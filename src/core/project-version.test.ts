// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { detectProjectIdentity } from './project-version.js';

function makeRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
}

function tagAt(dir: string, tag: string, message = 'tag'): void {
  writeFileSync(join(dir, 'README.md'), `# r ${Date.now()}`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'c'], { cwd: dir });
  execFileSync('git', ['tag', '-a', tag, '-m', message], { cwd: dir });
}

describe('detectProjectIdentity', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pident-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns package.json name + version when present', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));
    expect(detectProjectIdentity(dir)).toEqual({ name: 'demo', version: '1.2.3' });
  });

  it('returns Cargo.toml [package] name + version', () => {
    writeFileSync(
      join(dir, 'Cargo.toml'),
      ['[package]', 'name = "rusty"', 'version = "0.4.0"', 'edition = "2021"', ''].join('\n'),
    );
    expect(detectProjectIdentity(dir)).toEqual({ name: 'rusty', version: '0.4.0' });
  });

  it('returns pyproject [project] name + version (PEP 621)', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      ['[project]', 'name = "snek"', 'version = "2.0.1"', ''].join('\n'),
    );
    expect(detectProjectIdentity(dir)).toEqual({ name: 'snek', version: '2.0.1' });
  });

  it('returns pyproject [tool.poetry] name + version (legacy)', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      ['[tool.poetry]', 'name = "old-poet"', 'version = "1.0.0"', ''].join('\n'),
    );
    expect(detectProjectIdentity(dir)).toEqual({ name: 'old-poet', version: '1.0.0' });
  });

  it('reads module name from go.mod and falls back to git tag for version', () => {
    writeFileSync(join(dir, 'go.mod'), ['module github.com/awf-project/cli', '', 'go 1.25.8', ''].join('\n'));
    makeRepo(dir);
    tagAt(dir, 'v0.8.1');
    expect(detectProjectIdentity(dir)).toEqual({ name: 'cli', version: 'v0.8.1' });
  });

  it('falls back to git tag even when no manifest exists', () => {
    makeRepo(dir);
    tagAt(dir, 'v9.9.9');
    expect(detectProjectIdentity(dir)).toEqual({ name: basename(dir), version: 'v9.9.9' });
  });

  it('returns null version when no manifest and no tag', () => {
    makeRepo(dir); // empty repo, no tag
    expect(detectProjectIdentity(dir)).toEqual({ name: basename(dir), version: null });
  });

  it('returns null version for an unmarked directory (no repo, no manifest)', () => {
    expect(detectProjectIdentity(dir)).toEqual({ name: basename(dir), version: null });
  });

  it('ignores Cargo.toml that only declares [workspace]', () => {
    writeFileSync(join(dir, 'Cargo.toml'), ['[workspace]', 'members = ["a"]', ''].join('\n'));
    makeRepo(dir);
    tagAt(dir, 'v3.0.0');
    // No [package], so manifest is rejected, git tag fills version, name from basename
    expect(detectProjectIdentity(dir)).toEqual({ name: basename(dir), version: 'v3.0.0' });
  });
});
