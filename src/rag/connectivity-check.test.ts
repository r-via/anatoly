// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedModels } from './hardware-detect.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — replace the SDK + docker-gguf to keep this hermetic
// ---------------------------------------------------------------------------

const { mockEmbed, mockGetVercelEmbeddingModel } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockGetVercelEmbeddingModel: vi.fn(),
}));

vi.mock('ai', () => ({ embed: mockEmbed }));
vi.mock('./sdk-embedding.js', () => ({
  getVercelEmbeddingModel: mockGetVercelEmbeddingModel,
}));

import { runConnectivityCheck } from './connectivity-check.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liteResolved(): ResolvedModels {
  return {
    codeModel: 'jinaai/jina-embeddings-v2-base-code',
    codeDim: 768,
    codeRuntime: 'onnx',
    nlpModel: 'Xenova/all-MiniLM-L6-v2',
    nlpDim: 384,
    nlpRuntime: 'onnx',
    backend: 'lite',
  };
}

function externalResolved(): ResolvedModels {
  return {
    codeModel: 'voyage-code-3',
    codeDim: 1024,
    codeRuntime: 'sdk',
    nlpModel: 'voyage-3-large',
    nlpDim: 1024,
    nlpRuntime: 'sdk',
    backend: 'external',
    codeProvider: 'voyage',
    codeBaseUrl: 'https://api.voyageai.com/v1',
    codeEnvKey: 'VOYAGE_API_KEY',
    nlpProvider: 'voyage',
    nlpBaseUrl: 'https://api.voyageai.com/v1',
    nlpEnvKey: 'VOYAGE_API_KEY',
  };
}

function advancedGgufResolved(): ResolvedModels {
  return {
    codeModel: 'nomic-embed-code',
    codeDim: 3584,
    codeRuntime: 'sdk',
    nlpModel: 'qwen3-embedding-8b',
    nlpDim: 4096,
    nlpRuntime: 'sdk',
    backend: 'advanced-gguf',
    codeProvider: 'local-advanced',
    codeBaseUrl: 'http://127.0.0.1:11437/v1',
    codeEnvKey: null,
    nlpProvider: 'local-advanced',
    nlpBaseUrl: 'http://127.0.0.1:11438/v1',
    nlpEnvKey: null,
  };
}

beforeEach(() => {
  mockEmbed.mockReset();
  mockGetVercelEmbeddingModel.mockReset();
  mockGetVercelEmbeddingModel.mockReturnValue({ modelId: 'stub' });
});

// ---------------------------------------------------------------------------
// Lite mode — pure in-process, no network probes expected
// ---------------------------------------------------------------------------

describe('runConnectivityCheck — lite backend', () => {
  it('returns ok with empty probes and emits a confirmation log', async () => {
    const logs: string[] = [];
    const outcome = await runConnectivityCheck(liteResolved(), (msg) => logs.push(msg));

    expect(outcome).toEqual({ ok: true, backend: 'lite', probes: [] });
    expect(logs).toEqual(['RAG · lite · ok']);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockGetVercelEmbeddingModel).not.toHaveBeenCalled();
  });

  it('treats the legacy advanced-fp16 alias as lite', async () => {
    const resolved: ResolvedModels = { ...liteResolved(), backend: 'advanced-fp16' };
    const outcome = await runConnectivityCheck(resolved, () => {});
    expect(outcome.ok).toBe(true);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// External mode — both axes probed via the SDK
// ---------------------------------------------------------------------------

describe('runConnectivityCheck — external backend', () => {
  it('probes both axes and returns dims + durations on success', async () => {
    mockEmbed
      .mockResolvedValueOnce({ embedding: new Array(1024).fill(0) })
      .mockResolvedValueOnce({ embedding: new Array(1024).fill(0) });

    const outcome = await runConnectivityCheck(externalResolved(), () => {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backend).toBe('external');
    expect(outcome.probes).toHaveLength(2);
    expect(outcome.probes[0]).toMatchObject({ axis: 'code', provider: 'voyage', model: 'voyage-code-3', dim: 1024 });
    expect(outcome.probes[1]).toMatchObject({ axis: 'nlp', provider: 'voyage', model: 'voyage-3-large', dim: 1024 });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    // First positional call argument should be the SDK model from getVercelEmbeddingModel
    expect(mockEmbed.mock.calls[0]?.[0]).toMatchObject({ value: expect.stringContaining('anatoly') });
  });

  it('builds SDK models per axis with the right provider config', async () => {
    mockEmbed.mockResolvedValue({ embedding: [0, 0, 0] });
    await runConnectivityCheck(externalResolved(), () => {});

    expect(mockGetVercelEmbeddingModel).toHaveBeenCalledTimes(2);
    expect(mockGetVercelEmbeddingModel).toHaveBeenNthCalledWith(1, 'code', 'voyage-code-3', {
      provider: 'voyage',
      base_url: 'https://api.voyageai.com/v1',
      env_key: 'VOYAGE_API_KEY',
    });
    expect(mockGetVercelEmbeddingModel).toHaveBeenNthCalledWith(2, 'nlp', 'voyage-3-large', {
      provider: 'voyage',
      base_url: 'https://api.voyageai.com/v1',
      env_key: 'VOYAGE_API_KEY',
    });
  });

  it('reports failure on the failing axis without probing the next one', async () => {
    const boom = new Error('401 Unauthorized');
    mockEmbed.mockRejectedValueOnce(boom);

    const outcome = await runConnectivityCheck(externalResolved(), () => {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toMatchObject({
      axis: 'code',
      provider: 'voyage',
      model: 'voyage-code-3',
      cause: boom,
    });
    // We bailed after the first failure — only one embed call total.
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('surfaces NLP-axis failure even when the code axis passed', async () => {
    mockEmbed
      .mockResolvedValueOnce({ embedding: new Array(1024).fill(0) })
      .mockRejectedValueOnce(new Error('model not found'));

    const outcome = await runConnectivityCheck(externalResolved(), () => {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.axis).toBe('nlp');
    expect(outcome.failure.cause.message).toContain('model not found');
  });

  it('reports failure when no provider was resolved for an axis', async () => {
    const broken: ResolvedModels = { ...externalResolved(), codeProvider: undefined };
    const outcome = await runConnectivityCheck(broken, () => {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.axis).toBe('code');
    expect(outcome.failure.cause.message).toMatch(/provider/i);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Advanced GGUF — exercises the swap by probing both axes via SDK
// ---------------------------------------------------------------------------

describe('runConnectivityCheck — advanced-gguf backend', () => {
  it('probes both axes (code, then nlp) — exercising the hot-swap', async () => {
    mockEmbed
      .mockResolvedValueOnce({ embedding: new Array(3584).fill(0) })
      .mockResolvedValueOnce({ embedding: new Array(4096).fill(0) });

    const outcome = await runConnectivityCheck(advancedGgufResolved(), () => {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backend).toBe('advanced-gguf');
    expect(outcome.probes.map((p) => p.axis)).toEqual(['code', 'nlp']);
    expect(outcome.probes[0]?.dim).toBe(3584);
    expect(outcome.probes[1]?.dim).toBe(4096);
    // Two calls — proves the swap was driven (the SDK model's pre_hook is
    // what actually runs ensureModel; this test just confirms we issue both
    // probes through the SDK).
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it('reports failure when the local container does not respond', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:11437'));

    const outcome = await runConnectivityCheck(advancedGgufResolved(), () => {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.axis).toBe('code');
    expect(outcome.failure.cause.message).toContain('ECONNREFUSED');
  });
});
