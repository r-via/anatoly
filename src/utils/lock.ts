// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { AnatolyError, ERROR_CODES } from './errors.js';
import { isProcessRunning } from './process.js';

interface LockData {
  pid: number;
  started_at: string;
}

/**
 * Acquire a lock file to prevent concurrent Anatoly instances.
 * Throws LOCK_EXISTS if another instance is running.
 * Stale locks (process no longer running) are automatically cleaned up.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns The absolute path to the created lock file (pass to {@link releaseLock} to release).
 * @throws {AnatolyError} With code `LOCK_EXISTS` when another live process holds the lock.
 */
export function acquireLock(projectRoot: string): string {
  const lockPath = resolve(projectRoot, '.anatoly', 'anatoly.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  const lockData: LockData = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  const lockContent = JSON.stringify(lockData, null, 2) + '\n';

  // Attempt atomic exclusive-create — eliminates TOCTOU race
  try {
    writeFileSync(lockPath, lockContent, { flag: 'wx' });
    return lockPath;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Lock file exists — check if stale
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockData;

    if (isProcessRunning(existing.pid)) {
      throw new AnatolyError(
        `Another instance is running (PID: ${existing.pid}). Wait for it to finish or run 'anatoly reset' to force clear.`,
        ERROR_CODES.LOCK_EXISTS,
        false,
      );
    }

    // Stale lock — clean it up
    unlinkSync(lockPath);
  } catch (error) {
    if (error instanceof AnatolyError) throw error;
    // Corrupted lock file — remove it
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }

  // Retry atomic create after removing stale/corrupted lock
  try {
    writeFileSync(lockPath, lockContent, { flag: 'wx' });
    return lockPath;
  } catch (retryErr: unknown) {
    if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process acquired the lock between our unlink and retry
      let msg = 'Failed to acquire lock — another instance may be starting.';
      try {
        const winner = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockData;
        msg = `Another instance is running (PID: ${winner.pid}). Wait for it to finish or run 'anatoly reset' to force clear.`;
      } catch { /* use default message */ }
      throw new AnatolyError(msg, ERROR_CODES.LOCK_EXISTS, false);
    }
    throw retryErr;
  }
}

/**
 * Release the lock file. Silently succeeds if the file was already removed.
 *
 * @param lockPath - Path returned by {@link acquireLock}.
 */
export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock may have already been removed
  }
}

/**
 * Check if the lock is held by another running process.
 * Does NOT acquire the lock — read-only check for hook coordination.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns `true` only when a lock exists held by a different live process
 *   (the current process's own lock is excluded via a PID check).
 */
export function isLockActive(projectRoot: string): boolean {
  const lockPath = resolve(projectRoot, '.anatoly', 'anatoly.lock');
  if (!existsSync(lockPath)) return false;

  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockData;
    // Lock is active if the process is running AND it's not our own process
    return isProcessRunning(existing.pid) && existing.pid !== process.pid;
  } catch {
    return false;
  }
}

