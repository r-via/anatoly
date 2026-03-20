// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Semaphore } from '../core/sdk-semaphore.js';

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

export type PipelinePhase = 'rag' | 'review' | 'summary';

export class PipelineState {
  readonly tasks: TaskState[] = [];
  readonly activeFiles = new Map<string, FileState>();
  phase: PipelinePhase = 'rag';
  semaphore?: Semaphore;
  summary?: SummaryState;
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
  reapDoneFiles(flashDurationMs = 200): void {
    const now = Date.now();
    for (const [key, file] of this.activeFiles) {
      if (file.doneAt && now - file.doneAt >= flashDurationMs) {
        this.activeFiles.delete(key);
      }
    }
  }

  setSemaphore(sem: Semaphore): void {
    this.semaphore = sem;
  }

  setPhase(phase: PipelinePhase): void {
    this.phase = phase;
  }

  setSummary(summary: SummaryState): void {
    this.summary = summary;
    this.phase = 'summary';
  }
}
