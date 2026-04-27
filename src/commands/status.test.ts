// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, type RunStatus } from '../core/run-status.js';
import { formatDuration, buildRunTable, buildRunDetail } from './status.js';

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

describe('formatDuration', () => {
  it('should format seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(135_000)).toBe('2m 15s');
  });

  it('should format hours, minutes and seconds', () => {
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
  });

  it('should return 0s for zero duration', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('buildRunTable', () => {
  it('should return "No recent reviews found." when statuses is empty', () => {
    const result = buildRunTable([]);
    expect(result).toContain('No recent reviews found.');
  });

  it('should include runId and status for each run', () => {
    const statuses = [
      makeStatus({ runId: 'run-001', status: 'done', completedAt: '2026-04-27T10:05:00.000Z' }),
      makeStatus({ runId: 'run-002', status: 'running' }),
    ];

    const result = buildRunTable(statuses);
    expect(result).toContain('run-001');
    expect(result).toContain('run-002');
    expect(result).toContain('done');
    expect(result).toContain('running');
  });

  it('should include branch and commit info when available', () => {
    const statuses = [
      makeStatus({ runId: 'run-001', status: 'done', branch: 'main', commit: 'abc1234' }),
    ];

    const result = buildRunTable(statuses);
    expect(result).toContain('main');
    expect(result).toContain('abc1234');
  });
});

describe('buildRunDetail', () => {
  it('should show full run information for a completed run', () => {
    const status = makeStatus({
      runId: 'my-run',
      status: 'done',
      startedAt: '2026-04-27T10:00:00.000Z',
      completedAt: '2026-04-27T10:05:00.000Z',
      branch: 'main',
      commit: 'abc1234',
    });

    const result = buildRunDetail(status, '/project/.anatoly/runs/my-run');
    expect(result).toContain('my-run');
    expect(result).toContain('done');
    expect(result).toContain('main');
    expect(result).toContain('abc1234');
    expect(result).toContain('5m 0s');
  });

  it('should show error message for a failed run', () => {
    const status = makeStatus({
      runId: 'fail-run',
      status: 'failed',
      error: 'Rate limit exceeded',
      completedAt: '2026-04-27T10:01:00.000Z',
    });

    const result = buildRunDetail(status, '/project/.anatoly/runs/fail-run');
    expect(result).toContain('failed');
    expect(result).toContain('Rate limit exceeded');
  });

  it('should show report path for completed runs', () => {
    const status = makeStatus({ runId: 'done-run', status: 'done' });
    const runDir = '/project/.anatoly/runs/done-run';

    const result = buildRunDetail(status, runDir);
    expect(result).toContain('report');
  });
});
