// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — Runs latest symlink test.
 *
 * Verifies that after two successive runs, `runs/latest` is a symlink
 * pointing to the most recent run ID. On Windows, it falls back to a
 * plain text file containing the run ID.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { updateLatestPointer, readLatestPointer } from '../utils/run-id.js';

const IS_WINDOWS = platform() === 'win32';

describe('runs/latest symlink (Story 52.7)', () => {
  let base: string;
  let runsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'anatoly-runs-'));
    runsDir = join(base, 'runs');
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('latest points to the most recent run after two updates', () => {
    const run1 = 'run-2025-01-01-aaa';
    const run2 = 'run-2025-01-02-bbb';

    // Create run dirs
    mkdirSync(join(runsDir, run1), { recursive: true });
    mkdirSync(join(runsDir, run2), { recursive: true });

    // Update latest pointer — first run
    updateLatestPointer(runsDir, run1);
    expect(readLatestPointer(runsDir)).toBe(run1);

    // Update latest pointer — second run (overwrites)
    updateLatestPointer(runsDir, run2);
    expect(readLatestPointer(runsDir)).toBe(run2);
  });

  it.skipIf(IS_WINDOWS)('latest is a symlink on Linux/macOS', () => {
    const runId = 'run-2025-01-01-ccc';
    mkdirSync(join(runsDir, runId), { recursive: true });

    updateLatestPointer(runsDir, runId);

    const latestPath = join(runsDir, 'latest');
    const stat = lstatSync(latestPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readlinkSync(latestPath);
    expect(target).toBe(runId);
  });

  it('readLatestPointer returns null when no latest exists', () => {
    expect(readLatestPointer(runsDir)).toBeNull();
  });

  it('latest is readable after three successive updates', () => {
    const runs = ['run-a', 'run-b', 'run-c'];
    for (const runId of runs) {
      mkdirSync(join(runsDir, runId), { recursive: true });
      updateLatestPointer(runsDir, runId);
    }

    expect(readLatestPointer(runsDir)).toBe('run-c');
  });
});
