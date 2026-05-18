// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 53.1 — Foreground run-status.json lifecycle tests.
 *
 * Verifies that writeRunStatus writes the correct initial 'running' status,
 * and that transitions to 'done' and 'failed' are observable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, readRunStatus, isProcessAlive, type RunStatus } from './index.js';

describe('run-status.json foreground lifecycle (Story 53.1)', () => {
  let tempDir: string;
  let runDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-rs-fg-'));
    runDir = join(tempDir, 'runs', 'test-run');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes initial running status with correct fields', () => {
    const runningStatus: RunStatus = {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      branch: 'main',
      commit: 'abc1234',
      background: false,
    };

    writeRunStatus(runDir, runningStatus);
    const result = readRunStatus(runDir);

    expect(result).toBeDefined();
    expect(result!.status).toBe('running');
    expect(result!.pid).toBe(process.pid);
    expect(result!.background).toBe(false);
    expect(result!.branch).toBe('main');
    expect(result!.commit).toBe('abc1234');
    expect(result!.runId).toBe('test-run');
  });

  it('running → done transition is observable', () => {
    const startedAt = new Date().toISOString();

    // Write running
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt,
      branch: 'main',
      commit: 'abc1234',
      background: false,
    });

    expect(readRunStatus(runDir)!.status).toBe('running');

    // Transition to done
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'done',
      startedAt,
      completedAt: new Date().toISOString(),
      branch: 'main',
      commit: 'abc1234',
      background: false,
    });

    const done = readRunStatus(runDir)!;
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeDefined();
    expect(done.startedAt).toBe(startedAt);
    expect(done.branch).toBe('main');
    expect(done.commit).toBe('abc1234');
  });

  it('running → failed transition is observable with error message', () => {
    const startedAt = new Date().toISOString();

    // Write running
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt,
      branch: 'feature-x',
      commit: 'def5678',
      background: false,
    });

    expect(readRunStatus(runDir)!.status).toBe('running');

    // Transition to failed
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: 'LLM rate limit exceeded',
      branch: 'feature-x',
      commit: 'def5678',
      background: false,
    });

    const failed = readRunStatus(runDir)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('LLM rate limit exceeded');
    expect(failed.branch).toBe('feature-x');
  });

  it('foreground run has background === false', () => {
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      background: false,
    });

    expect(readRunStatus(runDir)!.background).toBe(false);
  });

  it('background run has background === true', () => {
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      background: true,
    });

    expect(readRunStatus(runDir)!.background).toBe(true);
  });

  it('pid corresponds to a live process', () => {
    writeRunStatus(runDir, {
      runId: 'test-run',
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      background: false,
    });

    const result = readRunStatus(runDir)!;
    expect(isProcessAlive(result.pid)).toBe(true);
  });
});
