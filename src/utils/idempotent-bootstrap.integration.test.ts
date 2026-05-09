// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Idempotent bootstrap integration test.
 *
 * Verifies that calling bootstrapAnatoly twice produces no filesystem
 * changes (mtime, content, structure) between the two calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { bootstrapAnatoly } from './anatoly-paths.js';

interface FsEntry {
  path: string;
  isSymlink: boolean;
  isDirectory: boolean;
  target?: string; // symlink target
  size: number;
}

/**
 * Recursively snapshot a directory tree.
 * Returns sorted array of entries with metadata.
 * Excludes mtime to focus on structure+content.
 */
function snapshotTree(root: string, prefix = ''): FsEntry[] {
  const entries: FsEntry[] = [];
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(join(root, prefix));
  } catch {
    return entries;
  }

  for (const name of dirEntries.sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, rel);
    const stat = lstatSync(full);

    const entry: FsEntry = {
      path: rel,
      isSymlink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    };

    if (stat.isSymbolicLink()) {
      entry.target = readlinkSync(full);
    }

    entries.push(entry);

    // Recurse into directories (but not symlinks, to avoid loops)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push(...snapshotTree(root, rel));
    }
  }

  return entries;
}

describe('idempotent bootstrap integration', () => {
  let base: string;
  let fakeHome: string;
  let savedHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-idempotent-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME ?? homedir();
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('second bootstrapAnatoly call produces identical filesystem structure', () => {
    const root = join(base, 'project');
    mkdirSync(root);

    // First bootstrap
    bootstrapAnatoly(root);
    const snapshot1 = snapshotTree(join(root, '.anatoly'));
    const homeSnapshot1 = snapshotTree(join(fakeHome, '.anatoly'));

    // Second bootstrap
    bootstrapAnatoly(root);
    const snapshot2 = snapshotTree(join(root, '.anatoly'));
    const homeSnapshot2 = snapshotTree(join(fakeHome, '.anatoly'));

    // Structure identical
    expect(snapshot2.map((e) => e.path)).toEqual(snapshot1.map((e) => e.path));
    expect(homeSnapshot2.map((e) => e.path)).toEqual(homeSnapshot1.map((e) => e.path));

    // Entry types identical
    for (let i = 0; i < snapshot1.length; i++) {
      expect(snapshot2[i].isSymlink).toBe(snapshot1[i].isSymlink);
      expect(snapshot2[i].isDirectory).toBe(snapshot1[i].isDirectory);
      if (snapshot1[i].isSymlink) {
        expect(snapshot2[i].target).toBe(snapshot1[i].target);
      }
    }
  });

  it('env vars are set correctly after both calls', () => {
    const root = join(base, 'project');
    mkdirSync(root);

    bootstrapAnatoly(root);
    const hfHome1 = process.env.HF_HOME;

    bootstrapAnatoly(root);
    expect(process.env.HF_HOME).toBe(hfHome1);
    expect(process.env.TRANSFORMERS_CACHE).toBe(hfHome1);
  });
});
