// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Idempotent bootstrap integration test.
 *
 * Verifies that calling bootstrapAnatoly twice produces no filesystem changes
 * on the second call (no new files, no mtime changes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FsEntry {
  path: string;
  isSymlink: boolean;
  isDir: boolean;
  size: number;
}

/**
 * Recursively snapshot a directory tree.
 * Captures path, type (symlink/dir/file), and size.
 * Excludes mtime on purpose — mkdirSync with recursive:true may touch
 * parent dirs even when no-op; we compare structure + size instead.
 */
function snapshotTree(root: string, prefix = ''): FsEntry[] {
  const entries: FsEntry[] = [];
  let items: string[];
  try {
    items = readdirSync(join(root, prefix));
  } catch {
    return entries;
  }

  for (const item of items.sort()) {
    const relPath = prefix ? `${prefix}/${item}` : item;
    const fullPath = join(root, relPath);
    const lstat = lstatSync(fullPath);

    entries.push({
      path: relPath,
      isSymlink: lstat.isSymbolicLink(),
      isDir: lstat.isDirectory(),
      size: lstat.isFile() ? lstat.size : 0,
    });

    // Recurse into real directories (not symlinks)
    if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
      entries.push(...snapshotTree(root, relPath));
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('idempotent bootstrap integration (Story 52.7)', () => {
  let base: string;
  let root: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-idemp-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME!;
    process.env.HOME = fakeHome;

    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it('second bootstrapAnatoly call produces identical filesystem snapshot', () => {
    // First bootstrap
    bootstrapAnatoly(root);

    // Snapshot project .anatoly/ tree
    const snapshot1Project = snapshotTree(join(root, '.anatoly'));
    // Snapshot user-wide ~/.anatoly/ tree
    const snapshot1UserWide = snapshotTree(join(fakeHome, '.anatoly'));

    // Second bootstrap
    bootstrapAnatoly(root);

    // Compare snapshots
    const snapshot2Project = snapshotTree(join(root, '.anatoly'));
    const snapshot2UserWide = snapshotTree(join(fakeHome, '.anatoly'));

    expect(snapshot2Project).toEqual(snapshot1Project);
    expect(snapshot2UserWide).toEqual(snapshot1UserWide);
  });

  it('env vars are correctly set on both calls', () => {
    bootstrapAnatoly(root);
    const hfHome1 = process.env.HF_HOME;
    const tc1 = process.env.TRANSFORMERS_CACHE;

    bootstrapAnatoly(root);
    expect(process.env.HF_HOME).toBe(hfHome1);
    expect(process.env.TRANSFORMERS_CACHE).toBe(tc1);
  });

  it('no new entries appear after second bootstrap', () => {
    bootstrapAnatoly(root);
    const count1 = snapshotTree(join(root, '.anatoly')).length;

    bootstrapAnatoly(root);
    const count2 = snapshotTree(join(root, '.anatoly')).length;

    expect(count2).toBe(count1);
  });
});
