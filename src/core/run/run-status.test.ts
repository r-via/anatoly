// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, readRunStatus, listRunStatuses, isProcessAlive, detectResumableRun, type RunStatus } from './run-status.js';

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

  describe('detectResumableRun', () => {
    /** Set up `.anatoly/runs/<runId>/run-status.json` + a progress file. */
    const seed = (runId: string, status: RunStatus, files: Record<string, string>): void => {
      const runDir = join(tempDir, '.anatoly', 'runs', runId);
      writeRunStatus(runDir, { ...status, runId });
      const cacheDir = join(tempDir, '.anatoly', 'cache');
      mkdirSync(cacheDir, { recursive: true });
      const progress = { version: 1, files: Object.fromEntries(Object.entries(files).map(([f, s]) => [f, { file: f, status: s, hash: 'h', updated_at: 't' }])) };
      writeFileSync(join(cacheDir, 'progress.json'), JSON.stringify(progress));
    };

    it('returns undefined when no runs exist', () => {
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });

    it('returns undefined when the latest run is done (nothing to resume)', () => {
      seed('r1', makeStatus({ status: 'done' }), { 'a.ts': 'DONE' });
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });

    it('flags a failed run with pending files', () => {
      seed('r1', makeStatus({ status: 'failed' }), { 'a.ts': 'DONE', 'b.ts': 'PENDING', 'c.ts': 'TIMEOUT' });
      const r = detectResumableRun(tempDir);
      expect(r).toEqual({ runId: 'r1', state: 'failed', pending: 2, done: 1 });
    });

    it('flags a crashed run', () => {
      seed('r1', makeStatus({ status: 'crashed' }), { 'a.ts': 'ERROR' });
      expect(detectResumableRun(tempDir)?.state).toBe('crashed');
    });

    it('flags a running run with a dead PID as stale-running', () => {
      seed('r1', makeStatus({ status: 'running', pid: 99999999 }), { 'a.ts': 'IN_PROGRESS' });
      expect(detectResumableRun(tempDir)?.state).toBe('stale-running');
    });

    it('does NOT flag a running run with a live PID', () => {
      seed('r1', makeStatus({ status: 'running', pid: process.pid }), { 'a.ts': 'PENDING' });
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });

    it('returns undefined when a failed run has no pending files left', () => {
      seed('r1', makeStatus({ status: 'failed' }), { 'a.ts': 'DONE', 'b.ts': 'CACHED' });
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });

    it('returns undefined when progress.json is absent', () => {
      const runDir = join(tempDir, '.anatoly', 'runs', 'r1');
      writeRunStatus(runDir, { ...makeStatus({ status: 'failed' }), runId: 'r1' });
      // no progress.json written
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });

    it('picks the most recent run when multiple exist', () => {
      seed('r1', makeStatus({ status: 'done' }), { 'a.ts': 'DONE' });
      seed('r2', makeStatus({ status: 'failed' }), { 'b.ts': 'PENDING' });
      const r = detectResumableRun(tempDir);
      expect(r?.runId).toBe('r2');
    });

    it('flags a DONE run that skipped a tail phase on a usage limit (no pending files)', () => {
      seed('r1', makeStatus({ status: 'done', incompletePhases: ['invariants', 'refinement'] }), { 'a.ts': 'DONE', 'b.ts': 'CACHED' });
      const r = detectResumableRun(tempDir);
      expect(r).toEqual({
        runId: 'r1',
        state: 'incomplete',
        pending: 0,
        done: 2,
        incompletePhases: ['invariants', 'refinement'],
      });
    });

    it('flags an incomplete-phases run even when progress.json is absent', () => {
      const runDir = join(tempDir, '.anatoly', 'runs', 'r1');
      writeRunStatus(runDir, { ...makeStatus({ status: 'done', incompletePhases: ['refinement'] }), runId: 'r1' });
      // no progress.json written — the resume re-runs the phase, not files
      const r = detectResumableRun(tempDir);
      expect(r?.state).toBe('incomplete');
      expect(r?.pending).toBe(0);
      expect(r?.incompletePhases).toEqual(['refinement']);
    });

    it('keeps the failure state (not incomplete) when a failed run ALSO has incompletePhases', () => {
      seed('r1', makeStatus({ status: 'failed', incompletePhases: ['invariants'] }), { 'a.ts': 'DONE' });
      const r = detectResumableRun(tempDir);
      // failed/crashed takes priority over the softer 'incomplete' label, but
      // the run is still resumable (pending===0 guard relaxed by the phases).
      expect(r?.state).toBe('failed');
      expect(r?.incompletePhases).toEqual(['invariants']);
    });

    it('does NOT flag a DONE run with an empty incompletePhases array', () => {
      seed('r1', makeStatus({ status: 'done', incompletePhases: [] }), { 'a.ts': 'DONE' });
      expect(detectResumableRun(tempDir)).toBeUndefined();
    });
  });
});
