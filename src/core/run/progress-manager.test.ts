// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProgressManager } from './progress-manager.js';
import { atomicWriteJson } from '../../utils/cache.js';

function makeProgress(tempDir: string, files: Record<string, { status: string; hash?: string }>): void {
  const cacheDir = join(tempDir, '.anatoly', 'cache');
  mkdirSync(cacheDir, { recursive: true });

  const progress = {
    version: 1,
    started_at: '2026-01-01T00:00:00Z',
    files: Object.fromEntries(
      Object.entries(files).map(([file, { status, hash }]) => [
        file,
        { file, hash: hash ?? 'abc123', status, updated_at: '2026-01-01T00:00:00Z' },
      ]),
    ),
  };

  atomicWriteJson(join(cacheDir, 'progress.json'), progress);
}

describe('ProgressManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-pm-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty state when no progress.json exists', () => {
    const pm = new ProgressManager(tempDir);
    expect(pm.totalFiles()).toBe(0);
    expect(pm.hasWork()).toBe(false);
    expect(pm.getPendingFiles()).toEqual([]);
  });

  it('should load existing progress and return pending files', () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'PENDING' },
      'src/b.ts': { status: 'DONE' },
      'src/c.ts': { status: 'CACHED' },
      'src/d.ts': { status: 'ERROR' },
    });

    const pm = new ProgressManager(tempDir);
    expect(pm.totalFiles()).toBe(4);
    expect(pm.hasWork()).toBe(true);

    const pending = pm.getPendingFiles();
    expect(pending).toHaveLength(2);
    expect(pending.map((f) => f.file).sort()).toEqual(['src/a.ts', 'src/d.ts']);
  });

  it('should return summary counts by status', () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'PENDING' },
      'src/b.ts': { status: 'PENDING' },
      'src/c.ts': { status: 'DONE' },
      'src/d.ts': { status: 'CACHED' },
      'src/e.ts': { status: 'ERROR' },
      'src/f.ts': { status: 'TIMEOUT' },
    });

    const pm = new ProgressManager(tempDir);
    const summary = pm.getSummary();
    expect(summary.PENDING).toBe(2);
    expect(summary.DONE).toBe(1);
    expect(summary.CACHED).toBe(1);
    expect(summary.ERROR).toBe(1);
    expect(summary.TIMEOUT).toBe(1);
    expect(summary.IN_PROGRESS).toBe(0);
  });

  it('getErrorFilesSince scopes failures to the current run by updated_at', () => {
    const cacheDir = join(tempDir, '.anatoly', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const runStart = Date.parse('2026-06-03T10:00:00Z');
    atomicWriteJson(join(cacheDir, 'progress.json'), {
      version: 1,
      started_at: '2026-06-03T10:00:00Z',
      files: {
        // failed THIS run (updated at/after run start) → included
        'src/fresh-error.ts': { file: 'src/fresh-error.ts', hash: 'h', status: 'ERROR', updated_at: '2026-06-03T10:05:00Z' },
        'src/fresh-timeout.ts': { file: 'src/fresh-timeout.ts', hash: 'h', status: 'TIMEOUT', updated_at: '2026-06-03T10:00:00Z' },
        // failed an EARLIER run (stale updated_at) → excluded
        'src/stale-timeout.ts': { file: 'src/stale-timeout.ts', hash: 'h', status: 'TIMEOUT', updated_at: '2026-06-01T08:00:00Z' },
        'src/stale-error.ts': { file: 'src/stale-error.ts', hash: 'h', status: 'ERROR', updated_at: '2026-05-30T12:00:00Z' },
        // not a failure → never included regardless of timestamp
        'src/done.ts': { file: 'src/done.ts', hash: 'h', status: 'DONE', updated_at: '2026-06-03T10:06:00Z' },
        'src/pending.ts': { file: 'src/pending.ts', hash: 'h', status: 'PENDING', updated_at: '2026-06-03T10:06:00Z' },
      },
    });

    const pm = new ProgressManager(tempDir);
    expect(pm.getErrorFilesSince(runStart).sort()).toEqual(['src/fresh-error.ts', 'src/fresh-timeout.ts']);
  });

  it('getErrorFilesSince keeps a failure whose updated_at is unparseable (no silent drop)', () => {
    const cacheDir = join(tempDir, '.anatoly', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    atomicWriteJson(join(cacheDir, 'progress.json'), {
      version: 1,
      started_at: '2026-06-03T10:00:00Z',
      files: {
        'src/weird.ts': { file: 'src/weird.ts', hash: 'h', status: 'ERROR', updated_at: 'not-a-date' },
      },
    });

    const pm = new ProgressManager(tempDir);
    expect(pm.getErrorFilesSince(Date.parse('2026-06-03T10:00:00Z'))).toEqual(['src/weird.ts']);
  });

  it('should update file status atomically', async () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'PENDING' },
    });

    const pm = new ProgressManager(tempDir);
    pm.updateFileStatus('src/a.ts', 'IN_PROGRESS');
    await pm.flush();

    // Re-read from disk to verify atomic write
    const pm2 = new ProgressManager(tempDir);
    const files = pm2.getProgress().files;
    expect(files['src/a.ts'].status).toBe('IN_PROGRESS');
  });

  it('should update file status with error message', async () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'IN_PROGRESS' },
    });

    const pm = new ProgressManager(tempDir);
    pm.updateFileStatus('src/a.ts', 'ERROR', 'Zod validation failed');
    await pm.flush();

    const pm2 = new ProgressManager(tempDir);
    const file = pm2.getProgress().files['src/a.ts'];
    expect(file.status).toBe('ERROR');
    expect(file.error).toBe('Zod validation failed');
  });

  it('should ignore updates for unknown files', () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'PENDING' },
    });

    const pm = new ProgressManager(tempDir);
    pm.updateFileStatus('src/unknown.ts', 'DONE');

    // Should not crash, original file unchanged
    const file = pm.getProgress().files['src/a.ts'];
    expect(file.status).toBe('PENDING');
  });
});
