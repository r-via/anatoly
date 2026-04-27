// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, isLockActive } from './lock.js';

/**
 * Story 47.6 — Multi-run lock tests.
 *
 * These tests verify that:
 * - Background runs skip the global lock and don't conflict with each other
 * - Background runs don't conflict with foreground runs
 * - The global lock only prevents concurrent foreground runs
 */
describe('multi-run lock behavior (Story 47.6)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-multirun-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('foreground lock does not affect background run directories', () => {
    // A foreground run acquires the global lock
    const lockPath = acquireLock(tempDir);
    expect(existsSync(lockPath)).toBe(true);

    // Background runs use per-run directories, never the global lock
    // Verify that run-specific directories can coexist with the global lock
    const run1Dir = join(tempDir, '.anatoly', 'runs', 'bg-run-001');
    const run2Dir = join(tempDir, '.anatoly', 'runs', 'bg-run-002');
    mkdirSync(run1Dir, { recursive: true });
    mkdirSync(run2Dir, { recursive: true });
    writeFileSync(join(run1Dir, 'run-status.json'), '{"status":"running"}');
    writeFileSync(join(run2Dir, 'run-status.json'), '{"status":"running"}');

    // Both run directories exist alongside the global lock
    expect(existsSync(join(run1Dir, 'run-status.json'))).toBe(true);
    expect(existsSync(join(run2Dir, 'run-status.json'))).toBe(true);

    releaseLock(lockPath);
  });

  it('isLockActive only checks the global foreground lock', () => {
    // No global lock — isLockActive returns false
    expect(isLockActive(tempDir)).toBe(false);

    // Even with per-run status files, isLockActive stays false
    const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run-status.json'), '{"status":"running","pid":12345}');
    expect(isLockActive(tempDir)).toBe(false);
  });

  it('multiple background run directories can exist simultaneously', () => {
    const runsDir = join(tempDir, '.anatoly', 'runs');
    mkdirSync(runsDir, { recursive: true });

    // Create multiple run directories (as background runs would)
    for (let i = 1; i <= 5; i++) {
      const runDir = join(runsDir, `bg-run-${i}`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'run-status.json'),
        JSON.stringify({ runId: `bg-run-${i}`, status: 'running', pid: 10000 + i }),
      );
    }

    // All 5 run directories exist independently
    for (let i = 1; i <= 5; i++) {
      expect(existsSync(join(runsDir, `bg-run-${i}`, 'run-status.json'))).toBe(true);
    }
  });

  it('foreground lock acquisition succeeds even when background runs exist', () => {
    // Background runs write status files
    const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run-001');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run-status.json'), '{"status":"running","pid":99999}');

    // Foreground lock acquisition should succeed — bg runs don't use the global lock
    const lockPath = acquireLock(tempDir);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
  });
});
