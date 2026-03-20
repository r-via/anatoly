// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it } from 'vitest';
import { PipelineState } from './pipeline-state.js';

describe('PipelineState', () => {
  it('adds tasks with pending status', () => {
    const state = new PipelineState();
    state.addTask('review', 'review');
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].status).toBe('pending');
    expect(state.tasks[0].detail).toBe('\u2014');
    expect(state.tasks[0].visible).toBe(true);
  });

  it('supports hidden tasks', () => {
    const state = new PipelineState();
    state.addTask('rag-nlp', 'rag — nlp embeddings', false);
    expect(state.tasks[0].visible).toBe(false);
  });

  it('transitions task through pending → active → done', () => {
    const state = new PipelineState();
    state.addTask('review', 'review');
    expect(state.tasks[0].status).toBe('pending');

    state.startTask('review', '0/100');
    expect(state.tasks[0].status).toBe('active');
    expect(state.tasks[0].detail).toBe('0/100');
    expect(state.activeTaskId).toBe('review');

    state.updateTask('review', '50/100');
    expect(state.tasks[0].detail).toBe('50/100');

    state.completeTask('review', '100/100 | 5 findings');
    expect(state.tasks[0].status).toBe('done');
    expect(state.tasks[0].detail).toBe('100/100 | 5 findings');
  });

  it('tracks files with axis progress', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts', { axesTotal: 5 });
    const file = state.activeFiles.get('src/foo.ts')!;
    expect(file.axesDone).toBe(0);
    expect(file.axesTotal).toBe(5);

    state.markAxisDone('src/foo.ts');
    expect(file.axesDone).toBe(1);

    state.markAxisDone('src/foo.ts');
    expect(file.axesDone).toBe(2);
  });

  it('sets retry message and clears on axis done', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts', { axesTotal: 5 });
    state.setRetryMessage('src/foo.ts', 'retry 5s (1/5)');
    expect(state.activeFiles.get('src/foo.ts')!.retryMsg).toBe('retry 5s (1/5)');

    state.markAxisDone('src/foo.ts');
    expect(state.activeFiles.get('src/foo.ts')!.retryMsg).toBeUndefined();
  });

  it('untrackFile sets doneAt for flash vert', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts');
    state.untrackFile('src/foo.ts');
    const file = state.activeFiles.get('src/foo.ts')!;
    expect(file.doneAt).toBeGreaterThan(0);
  });

  it('reapDoneFiles removes expired files', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts');
    state.untrackFile('src/foo.ts');
    // Set doneAt to past
    state.activeFiles.get('src/foo.ts')!.doneAt = Date.now() - 300;
    state.reapDoneFiles(200);
    expect(state.activeFiles.size).toBe(0);
  });

  it('reapDoneFiles keeps recent files', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts');
    state.untrackFile('src/foo.ts');
    state.reapDoneFiles(200);
    expect(state.activeFiles.size).toBe(1);
  });

  it('setSummary switches to summary phase', () => {
    const state = new PipelineState();
    state.setSummary({ headline: 'done', paths: [], cost: '$0' });
    expect(state.phase).toBe('summary');
    expect(state.summary?.headline).toBe('done');
  });

  it('tracks files without axes during RAG', () => {
    const state = new PipelineState();
    state.trackFile('src/foo.ts');
    const file = state.activeFiles.get('src/foo.ts')!;
    expect(file.axesTotal).toBe(0);
    expect(file.axesDone).toBe(0);
  });
});
