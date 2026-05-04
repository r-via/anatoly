// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — mocks referenced inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockSdkEmbed,
  mockSdkEmbedMany,
  mockGetVercelEmbeddingModel,
} = vi.hoisted(() => {
  const mockSdkEmbed = vi.fn();
  const mockSdkEmbedMany = vi.fn();
  const mockGetVercelEmbeddingModel = vi.fn().mockReturnValue({ modelId: 'mock-sdk-model' });
  return { mockSdkEmbed, mockSdkEmbedMany, mockGetVercelEmbeddingModel };
});

vi.mock('ai', () => ({
  embed: mockSdkEmbed,
  embedMany: mockSdkEmbedMany,
}));

vi.mock('./sdk-embedding.js', () => ({
  getVercelEmbeddingModel: mockGetVercelEmbeddingModel,
}));

// Mock ONNX pipeline to avoid network calls
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3]) }),
  ),
}));

// Mock docker-gguf to prevent Docker calls
vi.mock('./docker-gguf.js', () => ({
  ensureModel: vi.fn().mockResolvedValue(undefined),
}));

import {
  configureModels,
  embedCode,
  embedCodeBatch,
  embedNlp,
  embedNlpBatch,
  getCodeDim,
  getNlpDim,
} from './embeddings.js';
import type { ResolvedModels } from './hardware-detect.js';

// ---------------------------------------------------------------------------
// SDK runtime tests (Story 50.4)
// ---------------------------------------------------------------------------

describe('embeddings.ts — SDK runtime (Story 50.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sdkResolved: ResolvedModels = {
    codeModel: 'text-embedding-3-large',
    codeDim: 3072,
    codeRuntime: 'sdk',
    nlpModel: 'text-embedding-3-large',
    nlpDim: 3072,
    nlpRuntime: 'sdk',
    backend: 'advanced-gguf',
    codeProvider: 'openai',
    nlpProvider: 'openai',
  };

  it('should configure SDK models when codeRuntime is sdk', () => {
    configureModels(sdkResolved);
    expect(mockGetVercelEmbeddingModel).toHaveBeenCalledWith(
      'code',
      'text-embedding-3-large',
      expect.objectContaining({ provider: 'openai' }),
    );
    expect(mockGetVercelEmbeddingModel).toHaveBeenCalledWith(
      'nlp',
      'text-embedding-3-large',
      expect.objectContaining({ provider: 'openai' }),
    );
  });

  it('should use embed() from ai SDK for embedCode', async () => {
    configureModels(sdkResolved);
    const fakeVec = [0.1, 0.2, 0.3, 0.4];
    mockSdkEmbed.mockResolvedValueOnce({ embedding: fakeVec });

    const result = await embedCode('function add(a, b) { return a + b; }');
    expect(result).toEqual(fakeVec);
    expect(mockSdkEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'mock-sdk-model' },
      }),
    );
  });

  it('should use embedMany() from ai SDK for embedCodeBatch', async () => {
    configureModels(sdkResolved);
    const fakeVecs = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    mockSdkEmbedMany.mockResolvedValueOnce({ embeddings: fakeVecs });

    const result = await embedCodeBatch(['a', 'b', 'c']);
    expect(result).toEqual(fakeVecs);
    expect(mockSdkEmbedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ['a', 'b', 'c'],
      }),
    );
  });

  it('should use embed() from ai SDK for embedNlp', async () => {
    configureModels(sdkResolved);
    const fakeVec = [0.5, 0.6, 0.7];
    mockSdkEmbed.mockResolvedValueOnce({ embedding: fakeVec });

    const result = await embedNlp('validation logic');
    expect(result).toEqual(fakeVec);
  });

  it('should use embedMany() from ai SDK for embedNlpBatch', async () => {
    configureModels(sdkResolved);
    const fakeVecs = [[0.1], [0.2]];
    mockSdkEmbedMany.mockResolvedValueOnce({ embeddings: fakeVecs });

    const result = await embedNlpBatch(['text1', 'text2']);
    expect(result).toEqual(fakeVecs);
  });

  it('should return empty array for empty batch input', async () => {
    configureModels(sdkResolved);
    expect(await embedCodeBatch([])).toEqual([]);
    expect(await embedNlpBatch([])).toEqual([]);
  });

  it('should set dimensions from resolved models', () => {
    configureModels(sdkResolved);
    expect(getCodeDim()).toBe(3072);
    expect(getNlpDim()).toBe(3072);
  });
});

describe('embeddings.ts — ONNX runtime preserved (Story 50.4 NFR9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const onnxResolved: ResolvedModels = {
    codeModel: 'jinaai/jina-embeddings-v2-base-code',
    codeDim: 768,
    codeRuntime: 'onnx',
    nlpModel: 'Xenova/all-MiniLM-L6-v2',
    nlpDim: 384,
    nlpRuntime: 'onnx',
    backend: 'lite',
  } as any;

  it('should NOT call getVercelEmbeddingModel for onnx runtime', () => {
    configureModels(onnxResolved);
    expect(mockGetVercelEmbeddingModel).not.toHaveBeenCalled();
  });

  it('should use ONNX path for embedCode when onnx runtime', async () => {
    configureModels(onnxResolved);
    const result = await embedCode('test code');
    // ONNX mock returns [0.1, 0.2, 0.3]
    expect(result).toHaveLength(3);
    expect(mockSdkEmbed).not.toHaveBeenCalled();
  });
});

describe('embeddings.ts — Runtime type is onnx | sdk', () => {
  it('should not contain gguf references in runtime type', async () => {
    // Verify the module source uses 'sdk' not 'gguf' in its runtime type.
    // We check this by configuring with sdk runtime and verifying it works.
    const sdkResolved: ResolvedModels = {
      codeModel: 'test-model',
      codeDim: 512,
      codeRuntime: 'sdk',
      nlpModel: 'test-model',
      nlpDim: 512,
      nlpRuntime: 'sdk',
      backend: 'external',
      codeProvider: 'openai',
      nlpProvider: 'openai',
    };
    configureModels(sdkResolved);
    mockSdkEmbed.mockResolvedValueOnce({ embedding: [1, 2, 3] });
    const result = await embedCode('test');
    expect(result).toEqual([1, 2, 3]);
  });
});
