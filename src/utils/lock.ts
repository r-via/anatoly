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
 */
export function acquireLock(projectRoot: string): string {
  const lockPath = resolve(projectRoot, '.anatoly', 'anatoly.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  // Check for existing lock
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockData;

      // Check if the process is still running
      if (isProcessRunning(existing.pid)) {
        throw new AnatolyError(
          `Another instance is running (PID: ${existing.pid}). Wait for it to finish or run 'anatoly reset' to force clear.`,
          ERROR_CODES.LOCK_EXISTS,
          false,
        );
      }

      // Stale lock — clean it up
    } catch (error) {
      if (error instanceof AnatolyError) throw error;
      // Corrupted lock file — remove it
    }
  }

  const lockData: LockData = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + '\n');
  return lockPath;
}

/**
 * Release the lock file.
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

