// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Cross-platform symlinks test.
 *
 * On Linux/macOS: verifies symlinks are created normally by bootstrapAnatoly.
 * On Windows: skipped (would need EPERM fallback testing).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { bootstrapAnatoly } from '../utils/anatoly-paths.js';

const IS_WINDOWS = platform() === 'win32';

describe('cross-platform symlinks (Story 52.7)', () => {
  let base: string;
  let root: string;
  let savedHome: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-xplat-'));
    fakeHome = join(base, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    savedHome = process.env.HOME!;
    process.env.HOME = fakeHome;
    mkdirSync(join(fakeHome, '.anatoly'), { recursive: true });  // simulate local install

    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    delete process.env.HF_HOME;
    delete process.env.TRANSFORMERS_CACHE;
    rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(IS_WINDOWS)('creates shared/ as a symlink on Linux/macOS', () => {
    bootstrapAnatoly(root);

    const sharedPath = join(root, '.anatoly', 'shared');
    const stat = lstatSync(sharedPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readlinkSync(sharedPath);
    expect(target).toBe(join(fakeHome, '.anatoly', 'shared'));
  });

  it.skipIf(IS_WINDOWS)('creates user/ as a symlink on Linux/macOS', () => {
    bootstrapAnatoly(root);

    const userPath = join(root, '.anatoly', 'user');
    const stat = lstatSync(userPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readlinkSync(userPath);
    expect(target).toBe(join(fakeHome, '.anatoly', 'user'));
  });

  it.skipIf(IS_WINDOWS)('symlink targets exist and are directories', () => {
    bootstrapAnatoly(root);

    // Resolve through symlink
    const sharedTarget = join(fakeHome, '.anatoly', 'shared');
    const userTarget = join(fakeHome, '.anatoly', 'user');

    expect(lstatSync(sharedTarget).isDirectory()).toBe(true);
    expect(lstatSync(userTarget).isDirectory()).toBe(true);
  });

  it('bootstrapAnatoly succeeds regardless of platform', () => {
    // Should not throw on any platform
    expect(() => bootstrapAnatoly(root)).not.toThrow();

    // shared/ should exist (as symlink on Unix, as dir on Windows)
    const sharedPath = join(root, '.anatoly', 'shared');
    const stat = lstatSync(sharedPath);
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
  });
});
