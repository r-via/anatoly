// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.4 — attach [runId] run resolution tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunStatus, type RunStatus } from '../core/run-status.js';
import { resolveAttachTarget, buildAttachHeader } from './attach.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let tmpRoot: string;

function makeRunDir(runId: string): string {
  const dir = join(tmpRoot, '.anatoly', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStatus(runId: string, overrides: Partial<RunStatus>): void {
  const dir = makeRunDir(runId);
  const status: RunStatus = {
    runId,
    pid: overrides.pid ?? process.pid,
    status: overrides.status ?? 'done',
    startedAt: overrides.startedAt ?? '2025-01-01T00:00:00.000Z',
    background: overrides.background ?? false,
    branch: overrides.branch ?? 'main',
    commit: overrides.commit ?? 'abc1234',
    ...overrides,
  };
  writeRunStatus(dir, status);
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `attach-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(tmpRoot, '.anatoly', 'runs'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  resolveAttachTarget                                               */
/* ------------------------------------------------------------------ */

describe('resolveAttachTarget', () => {
  it('without runId, auto-selects the only active run', () => {
    writeStatus('run-done', { status: 'done', pid: 99999999 });
    writeStatus('run-active', { status: 'running', pid: process.pid });

    const result = resolveAttachTarget(tmpRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe('run-active');
    }
  });

  it('without runId, returns error when no active runs', () => {
    writeStatus('run-done', { status: 'done', pid: 99999999 });

    const result = resolveAttachTarget(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('No active run found');
    }
  });

  it('without runId, returns error when multiple active runs', () => {
    writeStatus('run-a', { status: 'running', pid: process.pid });
    writeStatus('run-b', { status: 'running', pid: process.pid });

    const result = resolveAttachTarget(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Specify a run ID');
    }
  });

  it('with runId, selects the matching active run', () => {
    writeStatus('run-target', { status: 'running', pid: process.pid });

    const result = resolveAttachTarget(tmpRoot, 'run-target');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe('run-target');
    }
  });

  it('with runId, returns error for non-existent run', () => {
    const result = resolveAttachTarget(tmpRoot, 'ghost-run');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('not found');
    }
  });

  it('with runId, returns error for done run (not active)', () => {
    writeStatus('run-done', { status: 'done', pid: 99999999 });

    const result = resolveAttachTarget(tmpRoot, 'run-done');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('not active');
      expect(result.message).toContain('done');
    }
  });

  it('with runId, detects crashed run (running but PID dead)', () => {
    writeStatus('run-zombie', { status: 'running', pid: 99999999 });

    const result = resolveAttachTarget(tmpRoot, 'run-zombie');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('dead');
      expect(result.message).toContain('crashed');
      expect(result.exitCode).toBe(2);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  buildAttachHeader                                                 */
/* ------------------------------------------------------------------ */

describe('buildAttachHeader', () => {
  it('includes all required fields', () => {
    const status: RunStatus = {
      runId: 'test-run-123',
      pid: 12345,
      status: 'running',
      startedAt: new Date().toISOString(),
      background: false,
      branch: 'feat/attach',
      commit: 'def5678',
    };

    const header = buildAttachHeader(status, '/path/to/log.ndjson');
    expect(header).toContain('test-run-123');
    expect(header).toContain('12345');
    expect(header).toContain('feat/attach');
    expect(header).toContain('def5678');
    expect(header).toContain('false');
    expect(header).toContain('log.ndjson');
    expect(header).toContain('attached at');
    expect(header).toContain('Ctrl-C to detach');
  });

  it('shows background true when set', () => {
    const status: RunStatus = {
      runId: 'bg-run',
      pid: 12345,
      status: 'running',
      startedAt: new Date().toISOString(),
      background: true,
      branch: 'main',
      commit: 'abc',
    };

    const header = buildAttachHeader(status, '/tmp/log.ndjson');
    expect(header).toContain('true');
  });
});

/* ------------------------------------------------------------------ */
/*  Multi-attach safety — no lock required (NFR4)                     */
/* ------------------------------------------------------------------ */

describe('multi-attach safety', () => {
  it('resolveAttachTarget can be called concurrently without conflict', () => {
    writeStatus('run-live', { status: 'running', pid: process.pid });

    // Simulate concurrent resolves
    const results = Array.from({ length: 3 }, () => resolveAttachTarget(tmpRoot, 'run-live'));
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.runId).toBe('run-live');
    }
  });
});
