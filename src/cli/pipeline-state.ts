// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { TransportRouter } from '../core/transports/index.js';

export interface TaskState {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done';
  detail: string;
  visible: boolean;
}

export interface FileState {
  path: string;
  axesDone: number;
  axesTotal: number;
  retryMsg?: string;
  doneAt?: number;
}

export interface SummaryState {
  headline: string;
  paths: { key: string; value: string }[];
  cost: string;
}

export type PipelinePhase = 'rag' | 'review' | 'refinement' | 'summary';

/**
 * Shared mutable state bag for the review pipeline, consumed by the
 * screen renderer to draw live progress.
 *
 * Owns three concerns:
 * - **Task lifecycle** — tasks progress through pending -> active -> done.
 *   `startTask` sets `_activeTaskId` as a side-effect so the renderer can
 *   suppress the agents counter during upsert operations.
 * - **Per-file axis progress** — `trackFile` / `markAxisDone` / `untrackFile`
 *   track axis completion per file. `untrackFile` stamps `doneAt` instead of
 *   deleting so the renderer can flash a brief completion highlight;
 *   `reapDoneFiles` garbage-collects entries after the flash expires.
 *   `markAxisDone` silently clears any pending `retryMsg`.
 * - **Phase & summary** — `phase` reflects the current pipeline stage
 *   (rag -> review -> summary) and `summary` holds the final output paths
 *   and cost once the run completes.
 */
export class PipelineState {
  readonly tasks: TaskState[] = [];
  readonly activeFiles = new Map<string, FileState>();
  phase: PipelinePhase = 'rag';
  router?: TransportRouter;
  summary?: SummaryState;
  /** Optional override for the "In progress" section header. */
  inProgressLabel?: string;
  /** Current active task id — used to suppress agents counter during upsert */
  private _activeTaskId?: string;

  addTask(id: string, label: string, visible = true): void {
    this.tasks.push({ id, label, status: 'pending', detail: '\u2014', visible });
  }

  startTask(id: string, detail?: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    this._activeTaskId = id;
    task.status = 'active';
    if (detail !== undefined) task.detail = detail;
  }

  updateTask(id: string, detail: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (task) task.detail = detail;
  }

  relabelTask(id: string, label: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (task) task.label = label;
  }

  /** Insert a new task before an existing task (for dynamically added phases). */
  insertTaskBefore(beforeId: string, id: string, label: string): void {
    const idx = this.tasks.findIndex((t) => t.id === beforeId);
    const task = { id, label, status: 'pending' as const, detail: '\u2014', visible: true };
    if (idx >= 0) {
      this.tasks.splice(idx, 0, task);
    } else {
      this.tasks.push(task);
    }
  }

  completeTask(id: string, detail: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = 'done';
    task.detail = detail;
    if (this._activeTaskId === id) this._activeTaskId = undefined;
  }

  get activeTaskId(): string | undefined {
    return this._activeTaskId;
  }

  trackFile(path: string, opts?: { axesTotal?: number }): void {
    this.activeFiles.set(path, {
      path,
      axesDone: 0,
      axesTotal: opts?.axesTotal ?? 0,
    });
  }

  markAxisDone(path: string): void {
    const file = this.activeFiles.get(path);
    if (file) {
      file.axesDone = Math.min(file.axesDone + 1, file.axesTotal);
      file.retryMsg = undefined;
    }
  }

  setRetryMessage(path: string, msg: string): void {
    const file = this.activeFiles.get(path);
    if (file) file.retryMsg = msg;
  }

  untrackFile(path: string): void {
    const file = this.activeFiles.get(path);
    if (file) {
      file.doneAt = Date.now();
    }
  }

  /** Remove files whose flash-vert has expired (called by renderer) */
  reapDoneFiles(flashDurationMs = 2000): void {
    const now = Date.now();
    for (const [key, file] of this.activeFiles) {
      if (file.doneAt && now - file.doneAt >= flashDurationMs) {
        this.activeFiles.delete(key);
      }
    }
  }

  setRouter(router: TransportRouter): void {
    this.router = router;
  }

  setPhase(phase: PipelinePhase): void {
    this.phase = phase;
  }

  setSummary(summary: SummaryState): void {
    this.summary = summary;
    this.phase = 'summary';
  }
}
