// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, readRunStatus, listRunStatuses, isProcessAlive, type RunStatus } from './run-status.js';

describe('run-status', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-run-status-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeStatus = (overrides: Partial<RunStatus> = {}): RunStatus => ({
    runId: 'test-run-123',
    pid: 12345,
    status: 'running',
    startedAt: '2026-04-27T10:00:00.000Z',
    background: true,
    ...overrides,
  });

  it('should write and read run-status.json', () => {
    const runDir = join(tempDir, 'runs', 'test-run');
    const status = makeStatus();

    writeRunStatus(runDir, status);
    const result = readRunStatus(runDir);

    expect(result).toEqual(status);
  });

  it('should return undefined when run-status.json does not exist', () => {
    const result = readRunStatus(join(tempDir, 'nonexistent'));
    expect(result).toBeUndefined();
  });

  it('should write completed status with completedAt', () => {
    const runDir = join(tempDir, 'runs', 'done-run');
    const status = makeStatus({
      status: 'done',
      completedAt: '2026-04-27T10:05:00.000Z',
    });

    writeRunStatus(runDir, status);
    const result = readRunStatus(runDir);

    expect(result?.status).toBe('done');
    expect(result?.completedAt).toBe('2026-04-27T10:05:00.000Z');
  });

  it('should write failed status with error message', () => {
    const runDir = join(tempDir, 'runs', 'failed-run');
    const status = makeStatus({
      status: 'failed',
      error: 'LLM rate limit exceeded',
      completedAt: '2026-04-27T10:02:00.000Z',
    });

    writeRunStatus(runDir, status);
    const result = readRunStatus(runDir);

    expect(result?.status).toBe('failed');
    expect(result?.error).toBe('LLM rate limit exceeded');
  });

  it('should persist branch and commit info', () => {
    const runDir = join(tempDir, 'runs', 'git-run');
    const status = makeStatus({
      branch: 'main',
      commit: 'abc1234',
    });

    writeRunStatus(runDir, status);
    const result = readRunStatus(runDir);

    expect(result?.branch).toBe('main');
    expect(result?.commit).toBe('abc1234');
  });

  it('should create parent directories if they do not exist', () => {
    const deepDir = join(tempDir, 'deep', 'nested', 'run');
    const status = makeStatus();

    writeRunStatus(deepDir, status);
    const result = readRunStatus(deepDir);

    expect(result).toEqual(status);
  });

  describe('listRunStatuses', () => {
    it('should return statuses for all runs that have run-status.json', () => {
      const projectRoot = tempDir;
      const runsDir = join(projectRoot, '.anatoly', 'runs');

      // Create two runs with status files
      writeRunStatus(join(runsDir, 'run-001'), makeStatus({ runId: 'run-001', status: 'done' }));
      writeRunStatus(join(runsDir, 'run-002'), makeStatus({ runId: 'run-002', status: 'running' }));

      // Create a run directory without a status file
      mkdirSync(join(runsDir, 'run-003'), { recursive: true });

      const statuses = listRunStatuses(projectRoot);
      expect(statuses).toHaveLength(2);
      expect(statuses[0].runId).toBe('run-001');
      expect(statuses[1].runId).toBe('run-002');
    });

    it('should return empty array when no runs directory exists', () => {
      const statuses = listRunStatuses(join(tempDir, 'nonexistent'));
      expect(statuses).toEqual([]);
    });

    it('should skip the latest symlink entry', () => {
      const projectRoot = tempDir;
      const runsDir = join(projectRoot, '.anatoly', 'runs');

      writeRunStatus(join(runsDir, 'run-001'), makeStatus({ runId: 'run-001' }));
      // Simulate a 'latest' file — listRunStatuses should not try to read it
      writeFileSync(join(runsDir, 'latest'), 'run-001');

      const statuses = listRunStatuses(projectRoot);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].runId).toBe('run-001');
    });
  });

  describe('isProcessAlive', () => {
    it('should return true for the current process PID', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('should return false for a non-existent PID', () => {
      // PID 99999999 is extremely unlikely to exist
      expect(isProcessAlive(99999999)).toBe(false);
    });

    it('should return false for PID 0', () => {
      expect(isProcessAlive(0)).toBe(false);
    });
  });
});
