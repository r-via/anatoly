// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolve } from 'node:path';
import type { Progress, FileProgress, FileStatus } from '../schemas/progress.js';
import { readProgress, atomicWriteJson } from '../utils/cache.js';

/**
 * Manages review progress: reads state, filters pending files,
 * and atomically updates file statuses.
 *
 * Thread-safe: concurrent calls to updateFileStatus() are serialized
 * through an internal write queue to prevent data corruption.
 */
export class ProgressManager {
  private progress: Progress;
  private readonly progressPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * @param projectRoot - Absolute path to the project root directory.
   */
  constructor(projectRoot: string) {
    this.progressPath = resolve(projectRoot, '.anatoly', 'cache', 'progress.json');
    this.progress = readProgress(this.progressPath) ?? {
      version: 1,
      started_at: new Date().toISOString(),
      files: {},
    };
  }

  /**
   * Get all files that need to be reviewed.
   * Includes PENDING, ERROR, and IN_PROGRESS (stale from a previous interrupted run).
   *
   * @returns Array of file progress entries that still require review.
   */
  getPendingFiles(): FileProgress[] {
    return Object.values(this.progress.files).filter(
      (f) => f.status === 'PENDING' || f.status === 'ERROR' || f.status === 'IN_PROGRESS',
    );
  }

  /**
   * Get current progress snapshot.
   *
   * @returns The in-memory progress state (direct reference, not a copy).
   */
  getProgress(): Progress {
    return this.progress;
  }

  /**
   * Get summary counts by status.
   *
   * @returns A record mapping each {@link FileStatus} to its count.
   */
  getSummary(): Record<FileStatus, number> {
    const counts: Record<string, number> = {
      PENDING: 0,
      IN_PROGRESS: 0,
      DONE: 0,
      TIMEOUT: 0,
      ERROR: 0,
      CACHED: 0,
    };

    for (const f of Object.values(this.progress.files)) {
      counts[f.status] = (counts[f.status] ?? 0) + 1;
    }

    return counts as Record<FileStatus, number>;
  }

  /**
   * Update a file's status. Writes are serialized through an internal queue
   * so concurrent callers never corrupt progress.json.
   *
   * @param filePath - Relative path of the file to update (must already exist in progress).
   * @param status - New status to assign.
   * @param error - Optional error message when status is ERROR.
   * @param axes - Sorted list of axis IDs that were evaluated (stored for per-axis cache invalidation).
   */
  updateFileStatus(
    filePath: string,
    status: FileStatus,
    error?: string,
    axes?: string[],
  ): void {
    const existing = this.progress.files[filePath];
    if (!existing) return;

    // Update in-memory state immediately (single-threaded JS = safe)
    this.progress.files[filePath] = {
      ...existing,
      status,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
      ...(axes ? { axes } : {}),
    };

    // Queue the disk write — each write waits for the previous one to finish
    this.writeQueue = this.writeQueue.then(() =>
      atomicWriteJson(this.progressPath, this.progress),
    );
  }

  /**
   * Wait for all queued writes to complete.
   * Call this before reading progress from disk or before exiting.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Check if there are any files left to review.
   *
   * @returns `true` if any files are PENDING, ERROR, or IN_PROGRESS.
   */
  hasWork(): boolean {
    return this.getPendingFiles().length > 0;
  }

  /**
   * Total number of tracked files.
   *
   * @returns Count of all files registered in progress (any status).
   */
  totalFiles(): number {
    return Object.keys(this.progress.files).length;
  }
}
