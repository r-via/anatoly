// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, readRunStatus, type RunStatus } from './run-status.js';

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
});
