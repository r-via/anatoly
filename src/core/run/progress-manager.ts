// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Progress, FileProgress, FileStatus } from '../../schemas/progress.js';
import { readProgress, atomicWriteJson } from '../../utils/cache.js';
import { anatolyPath } from '../../utils/anatoly-paths.js';

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

  constructor(projectRoot: string) {
    this.progressPath = anatolyPath(projectRoot, 'cache', 'progress.json');
    this.progress = readProgress(this.progressPath) ?? {
      version: 1,
      started_at: new Date().toISOString(),
      files: {},
    };
  }

  /**
   * Get all files that need to be reviewed.
   * Includes PENDING, ERROR, and IN_PROGRESS (stale from a previous interrupted run).
   */
  getPendingFiles(): FileProgress[] {
    return Object.values(this.progress.files).filter(
      (f) => f.status === 'PENDING' || f.status === 'ERROR' || f.status === 'IN_PROGRESS',
    );
  }

  /**
   * Get current progress snapshot.
   */
  getProgress(): Progress {
    return this.progress;
  }

  /**
   * Files that failed (ERROR or TIMEOUT) during the run that started at
   * `sinceMs` (epoch ms). The progress store is global and persists across
   * runs, so a file left ERROR/TIMEOUT by an earlier run would otherwise be
   * reported as a failure of every later run that never touched it. A real
   * failure this run has its `updated_at` refreshed at/after the run start;
   * a stale one predates it. An unparseable `updated_at` is treated as
   * in-scope (never silently drop a real failure).
   * @param sinceMs - Epoch ms of the current run's start (e.g. `ctx.startTime`).
   * @returns The file paths that failed during this run, in store order.
   */
  getErrorFilesSince(sinceMs: number): string[] {
    const out: string[] = [];
    for (const f of Object.values(this.progress.files)) {
      if (f.status !== 'ERROR' && f.status !== 'TIMEOUT') continue;
      const updatedMs = Date.parse(f.updated_at);
      if (Number.isNaN(updatedMs) || updatedMs >= sinceMs) out.push(f.file);
    }
    return out;
  }

  /**
   * Get summary counts by status.
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
   */
  updateFileStatus(
    filePath: string,
    status: FileStatus,
    error?: string,
    /** Sorted list of axis IDs that were evaluated (stored for per-axis cache invalidation) */
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
    this.writeQueue = this.writeQueue.then(() => {
      atomicWriteJson(this.progressPath, this.progress);
    });
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
   */
  hasWork(): boolean {
    return this.getPendingFiles().length > 0;
  }

  /**
   * Total number of tracked files.
   */
  totalFiles(): number {
    return Object.keys(this.progress.files).length;
  }
}
