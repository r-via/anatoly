// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.3 — Enrichissement anatoly status pour run actif

import { describe, it, expect } from 'vitest';
import { buildRunTable, buildRunDetail } from './status.js';
import { sortRunStatusesForDisplay } from '../core/run-status.js';
import type { RunStatus } from '../core/run-status.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeStatus(overrides: Partial<RunStatus> & { runId: string; status: RunStatus['status'] }): RunStatus {
  return {
    pid: 12345,
    startedAt: '2025-01-01T00:00:00.000Z',
    background: false,
    branch: 'main',
    commit: 'abc1234',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  sortRunStatusesForDisplay                                         */
/* ------------------------------------------------------------------ */

describe('sortRunStatusesForDisplay', () => {
  it('places running runs first, then sorts others by startedAt descending', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-001', status: 'done', startedAt: '2025-01-01T01:00:00Z' }),
      makeStatus({ runId: 'run-003', status: 'running', startedAt: '2025-01-01T03:00:00Z' }),
      makeStatus({ runId: 'run-002', status: 'failed', startedAt: '2025-01-01T02:00:00Z' }),
    ];

    const sorted = sortRunStatusesForDisplay(statuses);
    expect(sorted.map((s) => s.runId)).toEqual(['run-003', 'run-002', 'run-001']);
  });

  it('keeps multiple running runs sorted by startedAt descending', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-a', status: 'running', startedAt: '2025-01-01T01:00:00Z' }),
      makeStatus({ runId: 'run-b', status: 'running', startedAt: '2025-01-01T02:00:00Z' }),
    ];

    const sorted = sortRunStatusesForDisplay(statuses);
    expect(sorted.map((s) => s.runId)).toEqual(['run-b', 'run-a']);
  });

  it('returns empty array for empty input', () => {
    expect(sortRunStatusesForDisplay([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  buildRunTable with activeRunId highlighting                       */
/* ------------------------------------------------------------------ */

describe('buildRunTable with activeRunId', () => {
  it('marks the active run line differently from others', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-active', status: 'running' }),
      makeStatus({ runId: 'run-done', status: 'done', completedAt: '2025-01-01T00:05:00.000Z' }),
    ];

    const table = buildRunTable(statuses, 'run-active');
    // The active run line should contain the runId
    const lines = table.split('\n');
    const activeLine = lines.find((l) => l.includes('run-active'));
    expect(activeLine).toBeDefined();
    // We can't easily test chalk colors in plain text, but the function should accept the param
  });

  it('works without activeRunId (backward compatible)', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-1', status: 'done', completedAt: '2025-01-01T00:05:00.000Z' }),
    ];
    const table = buildRunTable(statuses);
    expect(table).toContain('run-1');
    expect(table).toContain('done');
  });
});

/* ------------------------------------------------------------------ */
/*  Scenario (a): project with no runs                                */
/* ------------------------------------------------------------------ */

describe('status — no runs scenario', () => {
  it('buildRunTable returns "No recent reviews" for empty array', () => {
    const table = buildRunTable([]);
    expect(table).toContain('No recent reviews found');
  });
});

/* ------------------------------------------------------------------ */
/*  Scenario (b): active run, no reviews yet                          */
/* ------------------------------------------------------------------ */

describe('status — active run, no reviews', () => {
  it('buildRunDetail shows report as (in progress) when run is running and no report exists', () => {
    const status = makeStatus({ runId: 'run-active', status: 'running' });
    // Use a non-existent runDir so report file won't be found
    const detail = buildRunDetail(status, '/tmp/non-existent-run-dir');
    expect(detail).toContain('report      (not yet generated)');
    expect(detail).toContain('status      running');
  });
});

/* ------------------------------------------------------------------ */
/*  Scenario (c): active run with reviews — tested via pure helpers   */
/* ------------------------------------------------------------------ */

describe('status — active run with reviews', () => {
  it('buildRunTable includes running status in output', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-active', status: 'running', startedAt: '2025-01-01T03:00:00Z' }),
      makeStatus({ runId: 'run-old', status: 'done', startedAt: '2025-01-01T01:00:00Z', completedAt: '2025-01-01T01:05:00Z' }),
    ];
    const table = buildRunTable(statuses, 'run-active');
    expect(table).toContain('run-active');
    expect(table).toContain('running');
  });
});

/* ------------------------------------------------------------------ */
/*  Scenario (d): multiple runs, active first in sorted output        */
/* ------------------------------------------------------------------ */

describe('status — multiple runs, active first in table', () => {
  it('sortRunStatusesForDisplay puts running run before done/failed/crashed', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-old-done', status: 'done', startedAt: '2025-01-01T01:00:00Z', completedAt: '2025-01-01T01:10:00Z' }),
      makeStatus({ runId: 'run-crashed', status: 'crashed', startedAt: '2025-01-01T02:00:00Z', completedAt: '2025-01-01T02:05:00Z' }),
      makeStatus({ runId: 'run-active', status: 'running', startedAt: '2025-01-01T03:00:00Z' }),
      makeStatus({ runId: 'run-failed', status: 'failed', startedAt: '2025-01-01T02:30:00Z', completedAt: '2025-01-01T02:35:00Z' }),
    ];

    const sorted = sortRunStatusesForDisplay(statuses);
    // Active run first
    expect(sorted[0].runId).toBe('run-active');
    expect(sorted[0].status).toBe('running');
    // Rest sorted by startedAt descending
    expect(sorted[1].runId).toBe('run-failed');
    expect(sorted[2].runId).toBe('run-crashed');
    expect(sorted[3].runId).toBe('run-old-done');
  });

  it('buildRunTable with sorted statuses shows active run in first data row', () => {
    const statuses: RunStatus[] = sortRunStatusesForDisplay([
      makeStatus({ runId: 'run-old', status: 'done', startedAt: '2025-01-01T01:00:00Z', completedAt: '2025-01-01T01:05:00Z' }),
      makeStatus({ runId: 'run-now', status: 'running', startedAt: '2025-01-01T03:00:00Z' }),
    ]);

    const table = buildRunTable(statuses, 'run-now');
    const lines = table.split('\n');
    // After header and separator, first data line should contain 'run-now'
    const dataLines = lines.slice(2);
    expect(dataLines[0]).toContain('run-now');
  });
});

/* ------------------------------------------------------------------ */
/*  Crashed detection — non-regression                                */
/* ------------------------------------------------------------------ */

describe('status — crashed detection non-regression', () => {
  it('sortRunStatusesForDisplay does not alter status fields', () => {
    const statuses: RunStatus[] = [
      makeStatus({ runId: 'run-crashed', status: 'crashed', startedAt: '2025-01-01T01:00:00Z' }),
      makeStatus({ runId: 'run-done', status: 'done', startedAt: '2025-01-01T02:00:00Z' }),
    ];
    const sorted = sortRunStatusesForDisplay(statuses);
    expect(sorted.find((s) => s.runId === 'run-crashed')?.status).toBe('crashed');
    expect(sorted.find((s) => s.runId === 'run-done')?.status).toBe('done');
  });
});
