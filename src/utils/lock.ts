import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { AnatolyError, ERROR_CODES } from './errors.js';

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
          `Another Anatoly instance is running (PID ${existing.pid}, started ${existing.started_at}). Remove ${lockPath} if this is stale.`,
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
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
