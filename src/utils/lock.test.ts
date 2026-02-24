import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, isLockActive } from './lock.js';

describe('acquireLock / releaseLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-lock-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a lock file with PID and timestamp', () => {
    const lockPath = acquireLock(tempDir);
    expect(existsSync(lockPath)).toBe(true);

    const data = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(data.pid).toBe(process.pid);
    expect(data.started_at).toBeDefined();

    releaseLock(lockPath);
  });

  it('should throw LOCK_EXISTS if lock is held by running process', () => {
    const lockPath = acquireLock(tempDir);

    expect(() => acquireLock(tempDir)).toThrow('Another instance is running');

    releaseLock(lockPath);
  });

  it('should clean up stale lock (non-existent PID)', () => {
    // Write a lock with a PID that doesn't exist
    const lockDir = join(tempDir, '.anatoly');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'anatoly.lock'),
      JSON.stringify({ pid: 999999999, started_at: '2020-01-01T00:00:00Z' }),
    );

    // Should succeed — stale lock is cleaned up
    const lockPath = acquireLock(tempDir);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
  });

  it('should release lock (file is deleted)', () => {
    const lockPath = acquireLock(tempDir);
    expect(existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should not throw when releasing non-existent lock', () => {
    expect(() => releaseLock('/tmp/non-existent-lock')).not.toThrow();
  });
});

describe('isLockActive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-lock-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when no lock file exists', () => {
    expect(isLockActive(tempDir)).toBe(false);
  });

  it('returns false when lock is held by current process', () => {
    const lockPath = acquireLock(tempDir);
    // isLockActive excludes our own PID
    expect(isLockActive(tempDir)).toBe(false);
    releaseLock(lockPath);
  });

  it('returns false when lock is stale (dead PID)', () => {
    const lockDir = join(tempDir, '.anatoly');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'anatoly.lock'),
      JSON.stringify({ pid: 999999999, started_at: '2020-01-01T00:00:00Z' }),
    );
    expect(isLockActive(tempDir)).toBe(false);
  });

  it('returns false when lock file is corrupted', () => {
    const lockDir = join(tempDir, '.anatoly');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'anatoly.lock'), 'corrupted');
    expect(isLockActive(tempDir)).toBe(false);
  });
});
