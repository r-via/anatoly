// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, lstatSync, readdirSync, existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import type { AnatolyArea } from './anatoly-paths.js';
import { anatolyPath, runPath, commandPath, bootstrapAnatoly, clearCache, clearShared } from './anatoly-paths.js';

describe('anatolyPath', () => {
  it('resolves area under <root>/.anatoly/', () => {
    expect(anatolyPath('/tmp/proj-A', 'cache/reviews')).toBe(
      join('/tmp/proj-A', '.anatoly', 'cache', 'reviews'),
    );
  });

  it('resolves area with rest segments', () => {
    expect(anatolyPath('/tmp/proj-A', 'cache/reviews', 'ab', 'abcdef.rev.json')).toBe(
      join('/tmp/proj-A', '.anatoly', 'cache', 'reviews', 'ab', 'abcdef.rev.json'),
    );
  });

  it('resolves all known areas', () => {
    const areas: AnatolyArea[] = [
      'cache/reviews',
      'cache/refinements',
      'cache/nlp-summaries',
      'shared/pricing',
      'shared/pricing/sources',
      'shared/grammars',
      'shared/models',
      'shared/models/gguf',
      'shared/models/hf-cache',
      'user',
      'state',
      'state/internal-docs',
      'cache',
      'cache/rag',
      'cache/rag/lancedb',
      'cache/doc-build',
      'commands',
      'runs',
      'runtime',
      'setup',
      'baseline',
    ];

    for (const area of areas) {
      const result = anatolyPath('/tmp/test', area);
      expect(result).toBe(join('/tmp/test', '.anatoly', ...area.split('/')));
    }
  });
});

describe('commandPath', () => {
  it('resolves path under .anatoly/commands/<command>/', () => {
    expect(commandPath('/tmp/proj', 'refresh')).toBe(
      join('/tmp/proj', '.anatoly', 'commands', 'refresh'),
    );
    expect(commandPath('/tmp/proj', 'scope', '2026-05-30', 'conversations')).toBe(
      join('/tmp/proj', '.anatoly', 'commands', 'scope', '2026-05-30', 'conversations'),
    );
  });
});

describe('runPath', () => {
  it('resolves path under .anatoly/runs/<runId>/', () => {
    expect(runPath('/tmp/proj', 'run-123')).toBe(
      join('/tmp/proj', '.anatoly', 'runs', 'run-123'),
    );
  });

  it('resolves path with rest segments', () => {
    expect(runPath('/tmp/proj', 'run-123', 'logs', 'anatoly.ndjson')).toBe(
      join('/tmp/proj', '.anatoly', 'runs', 'run-123', 'logs', 'anatoly.ndjson'),
    );
  });
});

describe('bootstrapAnatoly', () => {
  let tempDir: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-paths-'));
    // Redirect HOME so we don't touch real ~/.anatoly/
    savedHome = process.env.HOME ?? homedir();
    fakeHome = join(tempDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.anatoly'), { recursive: true });  // simulate local install
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(tempDir, { recursive: true, force: true });
    // Clean up env vars set by bootstrap
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
  });

  it('creates .anatoly/ directory structure on virgin project', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);

    bootstrapAnatoly(root);

    // Project-level .anatoly/ exists
    expect(existsSync(join(root, '.anatoly'))).toBe(true);

    // User-wide dirs exist
    expect(existsSync(join(fakeHome, '.anatoly', 'shared'))).toBe(true);
    expect(existsSync(join(fakeHome, '.anatoly', 'user'))).toBe(true);

    // Shared subdirs in user-wide — multi-tenant safe content only
    // (pricing/grammars/models). Code-derived artifacts live project-local
    // under cache/, not in shared/.
    const sharedSubdirs = [
      'pricing', 'pricing/sources',
      'grammars', 'models', 'models/gguf', 'models/hf-cache',
    ];
    for (const sub of sharedSubdirs) {
      expect(existsSync(join(fakeHome, '.anatoly', 'shared', ...sub.split('/')))).toBe(true);
    }

    // Symlinks from project to user-wide
    const sharedLink = lstatSync(join(root, '.anatoly', 'shared'));
    expect(sharedLink.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.anatoly', 'shared'))).toBe(
      join(fakeHome, '.anatoly', 'shared'),
    );

    const userLink = lstatSync(join(root, '.anatoly', 'user'));
    expect(userLink.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, '.anatoly', 'user'))).toBe(
      join(fakeHome, '.anatoly', 'user'),
    );

    // Project-only subdirs — code-derived caches live here, not in shared/.
    const projectSubdirs = [
      'state',
      'cache', 'cache/reviews', 'cache/refinements', 'cache/nlp-summaries',
      'cache/rag', 'cache/rag/lancedb', 'cache/doc-build',
      'runs', 'runtime', 'setup',
    ];
    for (const sub of projectSubdirs) {
      expect(existsSync(join(root, '.anatoly', ...sub.split('/')))).toBe(true);
    }
  });

  it('sets HF_HOME and TRANSFORMERS_CACHE env vars', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);

    bootstrapAnatoly(root);

    const expectedPath = anatolyPath(root, 'shared/models/hf-cache');
    expect(process.env.HF_HOME).toBe(expectedPath);
    expect(process.env.TRANSFORMERS_CACHE).toBe(expectedPath);
  });

  it('is idempotent — second call makes no changes', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);

    bootstrapAnatoly(root);

    // Snapshot filesystem state
    const snapshot = readdirSync(join(root, '.anatoly'), { recursive: true }).sort();

    bootstrapAnatoly(root);

    // Filesystem state unchanged
    const snapshot2 = readdirSync(join(root, '.anatoly'), { recursive: true }).sort();
    expect(snapshot2).toEqual(snapshot);

    // Env vars still set correctly
    const expectedPath = anatolyPath(root, 'shared/models/hf-cache');
    expect(process.env.HF_HOME).toBe(expectedPath);
  });

  it('respects existing real directory for shared/ (isolated mode)', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);
    mkdirSync(join(root, '.anatoly', 'shared'), { recursive: true });
    // Put a marker file to prove it's untouched
    writeFileSync(join(root, '.anatoly', 'shared', 'marker.txt'), 'isolated');

    bootstrapAnatoly(root);

    // Should NOT be a symlink
    const stat = lstatSync(join(root, '.anatoly', 'shared'));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    // Marker still there
    expect(existsSync(join(root, '.anatoly', 'shared', 'marker.txt'))).toBe(true);
  });

  it('respects existing real directory for user/ (isolated mode)', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);
    mkdirSync(join(root, '.anatoly', 'user'), { recursive: true });

    bootstrapAnatoly(root);

    const stat = lstatSync(join(root, '.anatoly', 'user'));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('clearCache', () => {
  let tempDir: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-clear-'));
    savedHome = process.env.HOME ?? homedir();
    fakeHome = join(tempDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.anatoly'), { recursive: true });  // simulate local install
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
  });

  it('clears cache/ but leaves state/, runs/, shared/ intact', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);
    bootstrapAnatoly(root);

    // Seed cache with data
    writeFileSync(join(root, '.anatoly', 'cache', 'test.json'), '{}');
    writeFileSync(join(root, '.anatoly', 'cache', 'rag', 'test.json'), '{}');

    // Seed state with data
    writeFileSync(join(root, '.anatoly', 'state', 'keep.json'), '{}');

    clearCache(root);

    // Cache contents removed but cache dir itself recreated
    expect(existsSync(join(root, '.anatoly', 'cache', 'test.json'))).toBe(false);
    expect(existsSync(join(root, '.anatoly', 'cache', 'rag', 'test.json'))).toBe(false);

    // State untouched
    expect(existsSync(join(root, '.anatoly', 'state', 'keep.json'))).toBe(true);

    // Shared symlink untouched
    expect(existsSync(join(root, '.anatoly', 'shared'))).toBe(true);

    // Runs untouched
    expect(existsSync(join(root, '.anatoly', 'runs'))).toBe(true);
  });
});

describe('clearShared', () => {
  let tempDir: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-clear-shared-'));
    savedHome = process.env.HOME ?? homedir();
    fakeHome = join(tempDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.anatoly'), { recursive: true });  // simulate local install
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
  });

  it('clears all shared sub-dirs but preserves user/ and dir structure', () => {
    const root = join(tempDir, 'project');
    mkdirSync(root);
    bootstrapAnatoly(root);

    const sharedBase = join(fakeHome, '.anatoly', 'shared');

    // Seed every clearable shared sub-dir (multi-tenant safe content only)
    writeFileSync(join(sharedBase, 'pricing', 'normalized.json'), '{}');
    mkdirSync(join(sharedBase, 'grammars'), { recursive: true });
    writeFileSync(join(sharedBase, 'grammars', 'python.wasm'), 'wasm');
    mkdirSync(join(sharedBase, 'models', 'gguf'), { recursive: true });
    writeFileSync(join(sharedBase, 'models', 'gguf', 'code.gguf'), 'gguf');

    // Seed user with data
    writeFileSync(join(fakeHome, '.anatoly', 'user', 'prefs.json'), '{}');

    clearShared();

    // All shared content cleared
    expect(existsSync(join(sharedBase, 'pricing', 'normalized.json'))).toBe(false);
    expect(existsSync(join(sharedBase, 'grammars', 'python.wasm'))).toBe(false);
    expect(existsSync(join(sharedBase, 'models', 'gguf', 'code.gguf'))).toBe(false);

    // Directory structure preserved (empty dirs still exist)
    expect(existsSync(join(sharedBase, 'pricing'))).toBe(true);
    expect(existsSync(join(sharedBase, 'grammars'))).toBe(true);
    expect(existsSync(join(sharedBase, 'models'))).toBe(true);

    // User untouched
    expect(existsSync(join(fakeHome, '.anatoly', 'user', 'prefs.json'))).toBe(true);
  });
});
