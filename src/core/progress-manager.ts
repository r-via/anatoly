import { resolve, join } from 'node:path';
import type { Progress, FileProgress, FileStatus } from '../schemas/progress.js';
import { readProgress, atomicWriteJson } from '../utils/cache.js';

/**
 * Manages review progress: reads state, filters pending files,
 * and atomically updates file statuses.
 */
export class ProgressManager {
  private progress: Progress;
  private readonly progressPath: string;

  constructor(projectRoot: string) {
    this.progressPath = resolve(projectRoot, '.anatoly', 'cache', 'progress.json');
    this.progress = readProgress(this.progressPath) ?? {
      version: 1,
      started_at: new Date().toISOString(),
      files: {},
    };
  }

  /**
   * Get all files that need to be reviewed (status PENDING or ERROR).
   * Files with DONE, CACHED, IN_PROGRESS, or TIMEOUT are skipped.
   */
  getPendingFiles(): FileProgress[] {
    return Object.values(this.progress.files).filter(
      (f) => f.status === 'PENDING' || f.status === 'ERROR',
    );
  }

  /**
   * Get current progress snapshot.
   */
  getProgress(): Progress {
    return this.progress;
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
   * Update a file's status atomically (writes progress.json immediately).
   */
  updateFileStatus(
    filePath: string,
    status: FileStatus,
    error?: string,
  ): void {
    const existing = this.progress.files[filePath];
    if (!existing) return;

    this.progress.files[filePath] = {
      ...existing,
      status,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    };

    atomicWriteJson(this.progressPath, this.progress);
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
