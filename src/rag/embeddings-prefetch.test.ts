// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { prefetchLiteModels, LITE_MODEL_IDS, type PrefetchProgress } from './embeddings-prefetch.js';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers — never hit the network in tests
// ---------------------------------------------------------------------------

const pipelineMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectProgress(): { events: PrefetchProgress[]; onProgress: (ev: PrefetchProgress) => void } {
  const events: PrefetchProgress[] = [];
  return { events, onProgress: (ev) => events.push(ev) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prefetchLiteModels', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('exports the correct model IDs', () => {
    expect(LITE_MODEL_IDS).toEqual([
      'jinaai/jina-embeddings-v2-base-code',
      'Xenova/all-MiniLM-L6-v2',
    ]);
  });

  // AC: downloads both models via pipeline('feature-extraction', modelId)
  it('calls pipeline for both lite models', async () => {
    pipelineMock.mockResolvedValue({});

    await prefetchLiteModels();

    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(pipelineMock).toHaveBeenCalledWith(
      'feature-extraction',
      'jinaai/jina-embeddings-v2-base-code',
      expect.objectContaining({ progress_callback: expect.any(Function) }),
    );
    expect(pipelineMock).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      expect.objectContaining({ progress_callback: expect.any(Function) }),
    );
  });

  // AC: progress_callback is wired to the onProgress callback
  it('forwards progress events from pipeline to onProgress callback', async () => {
    pipelineMock.mockImplementation(async (_task: string, _model: string, opts: { progress_callback?: (info: unknown) => void }) => {
      // Simulate HuggingFace progress events
      opts.progress_callback?.({ status: 'initiate', file: 'model.onnx' });
      opts.progress_callback?.({ status: 'progress', file: 'model.onnx', progress: 50 });
      opts.progress_callback?.({ status: 'done', file: 'model.onnx' });
      return {};
    });

    const { events, onProgress } = collectProgress();
    await prefetchLiteModels({ onProgress });

    // Should have progress events for both models
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Check that model IDs are included in events
    const modelIds = [...new Set(events.map(e => e.modelId))];
    expect(modelIds).toContain('jinaai/jina-embeddings-v2-base-code');
    expect(modelIds).toContain('Xenova/all-MiniLM-L6-v2');
  });

  // AC: progress events include file and percent fields
  it('emits progress events with file and percent', async () => {
    pipelineMock.mockImplementation(async (_task: string, _model: string, opts: { progress_callback?: (info: unknown) => void }) => {
      opts.progress_callback?.({ status: 'progress', file: 'model.onnx', progress: 75 });
      return {};
    });

    const { events, onProgress } = collectProgress();
    await prefetchLiteModels({ onProgress });

    const progressEvents = events.filter(e => e.kind === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]!.file).toBe('model.onnx');
    expect(progressEvents[0]!.percent).toBe(75);
  });

  // AC: emits 'done' events per model
  it('emits done event for each successfully loaded model', async () => {
    pipelineMock.mockResolvedValue({});

    const { events, onProgress } = collectProgress();
    await prefetchLiteModels({ onProgress });

    const doneEvents = events.filter(e => e.kind === 'done');
    expect(doneEvents).toHaveLength(2);
  });

  // AC: when models are cached, pipeline resolves instantly (no progress events)
  it('handles cached models gracefully (no progress callbacks fired)', async () => {
    // Cached models resolve immediately without progress callbacks
    pipelineMock.mockResolvedValue({});

    const { events, onProgress } = collectProgress();
    await prefetchLiteModels({ onProgress });

    // Only 'done' events emitted (no 'progress' since cache is instant)
    const progressEvents = events.filter(e => e.kind === 'progress');
    expect(progressEvents).toHaveLength(0);
    const doneEvents = events.filter(e => e.kind === 'done');
    expect(doneEvents).toHaveLength(2);
  });

  // AC: download failure → warn logged, run continues
  it('continues loading second model when first fails', async () => {
    pipelineMock
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({});

    const { events, onProgress } = collectProgress();
    await prefetchLiteModels({ onProgress });

    // Should have emitted an error event for first model
    const errorEvents = events.filter(e => e.kind === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.modelId).toBe('jinaai/jina-embeddings-v2-base-code');
    expect(errorEvents[0]!.error).toBeDefined();

    // Second model should still succeed
    const doneEvents = events.filter(e => e.kind === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.modelId).toBe('Xenova/all-MiniLM-L6-v2');
  });

  // AC: when both fail, prefetch doesn't throw (run continues)
  it('does not throw when both models fail to load', async () => {
    pipelineMock.mockRejectedValue(new Error('Network error'));

    const { events, onProgress } = collectProgress();
    await expect(prefetchLiteModels({ onProgress })).resolves.toBeUndefined();

    const errorEvents = events.filter(e => e.kind === 'error');
    expect(errorEvents).toHaveLength(2);
  });

  // AC: works without onProgress callback (no-op default)
  it('works without an onProgress callback', async () => {
    pipelineMock.mockResolvedValue({});
    await expect(prefetchLiteModels()).resolves.toBeUndefined();
  });
});
