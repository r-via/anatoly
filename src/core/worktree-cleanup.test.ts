// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupOrphanedWorktrees } from './worktree-cleanup.js';
import { writeRunStatus, readRunStatus, type RunStatus } from './run-status.js';

function makeStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    runId: 'test-run',
    pid: 12345,
    status: 'running',
    startedAt: '2026-04-27T10:00:00.000Z',
    background: true,
    ...overrides,
  };
}

describe('worktree-cleanup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-cleanup-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createWorktreeDir(runId: string): void {
    mkdirSync(join(tempDir, '.anatoly', 'worktrees', runId), { recursive: true });
  }

  function createRunWithStatus(runId: string, status: Partial<RunStatus>): void {
    const runsDir = join(tempDir, '.anatoly', 'runs');
    writeRunStatus(join(runsDir, runId), makeStatus({ runId, ...status }));
  }

  it('should return 0 when no worktrees directory exists', () => {
    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('should return 0 when worktrees directory is empty', () => {
    mkdirSync(join(tempDir, '.anatoly', 'worktrees'), { recursive: true });
    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(0);
  });

  it('should skip active worktrees (run status is running with alive PID)', () => {
    createWorktreeDir('active-run');
    createRunWithStatus('active-run', { status: 'running', pid: process.pid });

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.skipped).toBe(1);
    expect(result.cleaned).toBe(0);
    // Worktree dir still exists
    expect(existsSync(join(tempDir, '.anatoly', 'worktrees', 'active-run'))).toBe(true);
  });

  it('should clean up worktrees for completed runs (status done)', () => {
    createWorktreeDir('done-run');
    createRunWithStatus('done-run', { status: 'done', completedAt: '2026-04-27T10:05:00Z' });

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(1);
    // Worktree dir should be removed
    expect(existsSync(join(tempDir, '.anatoly', 'worktrees', 'done-run'))).toBe(false);
  });

  it('should clean up worktrees for failed runs', () => {
    createWorktreeDir('failed-run');
    createRunWithStatus('failed-run', { status: 'failed', error: 'LLM error' });

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(1);
  });

  it('should clean up worktrees for crashed runs', () => {
    createWorktreeDir('crashed-run');
    createRunWithStatus('crashed-run', { status: 'crashed' });

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(1);
  });

  it('should clean up orphan worktrees with no run-status.json', () => {
    // Worktree exists but no run status — orphaned
    createWorktreeDir('orphan-run');

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(1);
  });

  it('should clean up worktrees whose "running" status has a dead PID', () => {
    createWorktreeDir('dead-pid-run');
    createRunWithStatus('dead-pid-run', { status: 'running', pid: 99999999 });

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(1);
  });

  it('should skip the .needs-cleanup.json file', () => {
    mkdirSync(join(tempDir, '.anatoly', 'worktrees'), { recursive: true });
    writeFileSync(join(tempDir, '.anatoly', 'worktrees', '.needs-cleanup.json'), '{}');

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.cleaned).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('should handle multiple worktrees with mixed states', () => {
    createWorktreeDir('active');
    createWorktreeDir('done');
    createWorktreeDir('orphan');

    createRunWithStatus('active', { status: 'running', pid: process.pid });
    createRunWithStatus('done', { status: 'done' });
    // 'orphan' has no run status

    const result = cleanupOrphanedWorktrees(tempDir);
    expect(result.skipped).toBe(1); // active
    expect(result.cleaned).toBe(2); // done + orphan
  });
});
