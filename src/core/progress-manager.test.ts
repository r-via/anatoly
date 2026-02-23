import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProgressManager } from './progress-manager.js';
import { atomicWriteJson } from '../utils/cache.js';

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

  it('should update file status atomically', () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'PENDING' },
    });

    const pm = new ProgressManager(tempDir);
    pm.updateFileStatus('src/a.ts', 'IN_PROGRESS');

    // Re-read from disk to verify atomic write
    const pm2 = new ProgressManager(tempDir);
    const files = pm2.getProgress().files;
    expect(files['src/a.ts'].status).toBe('IN_PROGRESS');
  });

  it('should update file status with error message', () => {
    makeProgress(tempDir, {
      'src/a.ts': { status: 'IN_PROGRESS' },
    });

    const pm = new ProgressManager(tempDir);
    pm.updateFileStatus('src/a.ts', 'ERROR', 'Zod validation failed');

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
