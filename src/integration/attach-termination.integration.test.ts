// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.6 — attach termination integration tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeRunStatus, readRunStatus, type RunStatus } from '../core/run-status.js';
import { tailNdjson } from '../core/ndjson-tail.js';
import {
  buildFinalizationMessage,
  monitorRunStatus,
  type MonitorResult,
} from '../commands/attach.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let tmpRoot: string;
let runDir: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ndjsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function writeStatusFile(overrides: Partial<RunStatus>): void {
  const status: RunStatus = {
    runId: 'test-run',
    pid: process.pid,
    status: 'running',
    startedAt: '2025-01-01T00:00:00.000Z',
    background: false,
    branch: 'main',
    commit: 'abc1234',
    ...overrides,
  };
  writeRunStatus(runDir, status);
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `attach-term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  runDir = join(tmpRoot, '.anatoly', 'runs', 'test-run');
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  buildFinalizationMessage — pure function tests                    */
/* ------------------------------------------------------------------ */

describe('buildFinalizationMessage', () => {
  it('returns done summary with CLEAN verdict and exit 0', () => {
    const status: RunStatus = {
      runId: 'test-run',
      pid: 1234,
      status: 'done',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:05:00.000Z',
      background: false,
      branch: 'main',
      commit: 'abc',
    };

    const result = buildFinalizationMessage(status, 'CLEAN', 0, '/path/to/report.md');
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('CLEAN');
    expect(result.message).toContain('0 findings');
    expect(result.message).toContain('report.md');
  });

  it('returns done summary with non-CLEAN verdict and exit 1', () => {
    const status: RunStatus = {
      runId: 'test-run',
      pid: 1234,
      status: 'done',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:05:00.000Z',
      background: false,
    };

    const result = buildFinalizationMessage(status, 'NEEDS_REFACTOR', 5, '/path/to/report.md');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('NEEDS_REFACTOR');
    expect(result.message).toContain('5 findings');
  });

  it('returns failed message with exit 1', () => {
    const status: RunStatus = {
      runId: 'test-run',
      pid: 1234,
      status: 'failed',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:05:00.000Z',
      background: false,
      error: 'Out of tokens',
    };

    const result = buildFinalizationMessage(status, 'CLEAN', 0, null);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Run failed');
    expect(result.message).toContain('Out of tokens');
  });

  it('returns crashed message with exit 2', () => {
    const status: RunStatus = {
      runId: 'test-run',
      pid: 1234,
      status: 'crashed',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:05:00.000Z',
      background: false,
    };

    const result = buildFinalizationMessage(status, 'CLEAN', 0, null);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('crashed');
  });
});

/* ------------------------------------------------------------------ */
/*  monitorRunStatus — polling integration tests                      */
/* ------------------------------------------------------------------ */

describe('monitorRunStatus', () => {
  it('detects done transition', async () => {
    writeStatusFile({ status: 'running' });

    const monitorPromise = monitorRunStatus(runDir, process.pid, {
      statusPollMs: 50,
      pidPollMs: 100,
    });

    // Transition to done after a short delay
    await sleep(100);
    writeStatusFile({ status: 'done', completedAt: new Date().toISOString() });

    const result = await monitorPromise;
    expect(result.reason).toBe('status_change');
    expect(result.finalStatus?.status).toBe('done');
  });

  it('detects failed transition', async () => {
    writeStatusFile({ status: 'running' });

    const monitorPromise = monitorRunStatus(runDir, process.pid, {
      statusPollMs: 50,
      pidPollMs: 100,
    });

    await sleep(100);
    writeStatusFile({ status: 'failed', error: 'Rate limited', completedAt: new Date().toISOString() });

    const result = await monitorPromise;
    expect(result.reason).toBe('status_change');
    expect(result.finalStatus?.status).toBe('failed');
    expect(result.finalStatus?.error).toBe('Rate limited');
  });

  it('detects PID death and writes crashed status', async () => {
    // Use a PID that is definitely not alive
    const deadPid = 99999999;
    writeStatusFile({ status: 'running', pid: deadPid });

    const result = await monitorRunStatus(runDir, deadPid, {
      statusPollMs: 50,
      pidPollMs: 50,
    });

    expect(result.reason).toBe('pid_dead');
    expect(result.finalStatus?.status).toBe('crashed');

    // Verify the file was updated
    const onDisk = readRunStatus(runDir);
    expect(onDisk?.status).toBe('crashed');
    expect(onDisk?.completedAt).toBeTruthy();
  });

  it('can be stopped externally', async () => {
    writeStatusFile({ status: 'running' });

    const controller = new AbortController();
    const monitorPromise = monitorRunStatus(runDir, process.pid, {
      statusPollMs: 50,
      pidPollMs: 100,
      signal: controller.signal,
    });

    await sleep(80);
    controller.abort();

    const result = await monitorPromise;
    expect(result.reason).toBe('aborted');
  });
});

/* ------------------------------------------------------------------ */
/*  NFR5: attach never writes to ndjson                               */
/* ------------------------------------------------------------------ */

describe('attach never writes to ndjson (NFR5)', () => {
  it('ndjson file is unchanged by tail + monitor lifecycle', async () => {
    const ndjsonPath = join(runDir, 'anatoly.ndjson');
    const initialContent = ndjsonLine({ event: 'phase_start', phase: 'scan' }) +
                           ndjsonLine({ event: 'phase_end', phase: 'scan' });
    writeFileSync(ndjsonPath, initialContent);

    const initialSize = statSync(ndjsonPath).size;
    const initialHash = createHash('sha256').update(readFileSync(ndjsonPath)).digest('hex');

    writeStatusFile({ status: 'running' });

    // Start tail (read-only)
    const events: unknown[] = [];
    const tailHandle = tailNdjson(ndjsonPath, {
      fromStart: true,
      onEvent: (ev) => events.push(ev),
      onError: () => {},
    });

    // Start monitor
    const controller = new AbortController();
    const monitorPromise = monitorRunStatus(runDir, process.pid, {
      statusPollMs: 50,
      pidPollMs: 100,
      signal: controller.signal,
    });

    await sleep(150);

    // Stop everything
    tailHandle.stop();
    controller.abort();
    await monitorPromise;

    // Verify ndjson was NOT modified
    const finalSize = statSync(ndjsonPath).size;
    const finalHash = createHash('sha256').update(readFileSync(ndjsonPath)).digest('hex');
    expect(finalSize).toBe(initialSize);
    expect(finalHash).toBe(initialHash);

    // Verify events were read
    expect(events).toHaveLength(2);
  });
});
