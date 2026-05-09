// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 52.7 — runs/latest symlink test.
 *
 * Verifies that after two runs, `runs/latest` is a symlink
 * pointing at the most recent run directory.
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
import { tmpdir } from 'node:os';
import { updateLatestPointer, readLatestPointer } from './run-id.js';

describe('runs/latest symlink', () => {
  let runsDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'anatoly-runs-'));
    runsDir = join(base, 'runs');
    mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up parent of runsDir
    rmSync(join(runsDir, '..'), { recursive: true, force: true });
  });

  it('creates a symlink for latest pointing to the run ID', () => {
    const runId = 'run-001';
    mkdirSync(join(runsDir, runId));

    updateLatestPointer(runsDir, runId);

    const latestPath = join(runsDir, 'latest');
    const stat = lstatSync(latestPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(latestPath)).toBe(runId);
  });

  it('after two runs, latest points to the second run', () => {
    const run1 = 'run-001';
    const run2 = 'run-002';
    mkdirSync(join(runsDir, run1));
    mkdirSync(join(runsDir, run2));

    updateLatestPointer(runsDir, run1);
    expect(readLatestPointer(runsDir)).toBe(run1);

    updateLatestPointer(runsDir, run2);
    expect(readLatestPointer(runsDir)).toBe(run2);

    const stat = lstatSync(join(runsDir, 'latest'));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(runsDir, 'latest'))).toBe(run2);
  });

  it('readLatestPointer returns null when no pointer exists', () => {
    expect(readLatestPointer(runsDir)).toBeNull();
  });
});
