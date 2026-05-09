// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Cross-platform symlinks test.
 *
 * Verifies that bootstrapAnatoly creates symlinks on Linux/macOS
 * and handles Windows (EPERM) gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir, platform } from 'node:os';
import { bootstrapAnatoly } from './anatoly-paths.js';

describe('cross-platform symlinks', () => {
  let base: string;
  let fakeHome: string;
  let savedHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-symlink-'));
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

  it('creates symlinks for shared/ and user/ on Linux/macOS', () => {
    // Skip on Windows
    if (platform() === 'win32') return;

    const root = join(base, 'project');
    mkdirSync(root);
    bootstrapAnatoly(root);

    const sharedStat = lstatSync(join(root, '.anatoly', 'shared'));
    expect(sharedStat.isSymbolicLink()).toBe(true);

    const userStat = lstatSync(join(root, '.anatoly', 'user'));
    expect(userStat.isSymbolicLink()).toBe(true);
  });

  it('symlinks point to user-wide dirs under ~/.anatoly/', () => {
    if (platform() === 'win32') return;

    const root = join(base, 'project');
    mkdirSync(root);
    bootstrapAnatoly(root);

    const { readlinkSync } = require('node:fs');
    const sharedTarget = readlinkSync(join(root, '.anatoly', 'shared'));
    expect(sharedTarget).toBe(join(fakeHome, '.anatoly', 'shared'));

    const userTarget = readlinkSync(join(root, '.anatoly', 'user'));
    expect(userTarget).toBe(join(fakeHome, '.anatoly', 'user'));
  });

  it('user-wide shared subdirs are created', () => {
    const root = join(base, 'project');
    mkdirSync(root);
    bootstrapAnatoly(root);

    const sharedSubdirs = ['reviews', 'refinements', 'nlp-summaries', 'pricing', 'grammars', 'models'];
    for (const sub of sharedSubdirs) {
      expect(existsSync(join(fakeHome, '.anatoly', 'shared', sub))).toBe(true);
    }
  });
});
