// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// vi.hoisted — variables used inside vi.mock factories must be declared here
// ---------------------------------------------------------------------------

const {
  mockOpenaiTextEmbedding,
  mockCompatibleTextEmbeddingModel,
  mockCreateOpenAICompatible,
  mockEmbed,
} = vi.hoisted(() => {
  const mockOpenaiTextEmbedding = vi.fn().mockReturnValue({ modelId: 'mock-openai-embed', doEmbed: vi.fn() });
  const mockCompatibleTextEmbeddingModel = vi.fn().mockReturnValue({ modelId: 'mock-compatible-embed', doEmbed: vi.fn() });
  const mockCreateOpenAICompatible = vi.fn().mockReturnValue({
    textEmbeddingModel: mockCompatibleTextEmbeddingModel,
  });
  const mockEmbed = vi.fn();
  return { mockOpenaiTextEmbedding, mockCompatibleTextEmbeddingModel, mockCreateOpenAICompatible, mockEmbed };
});

vi.mock('@ai-sdk/openai', () => ({
  openai: { textEmbeddingModel: mockOpenaiTextEmbedding },
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

vi.mock('ai', () => ({
  embed: mockEmbed,
}));

// Mock docker-gguf to prevent actual Docker calls
vi.mock('./docker-gguf.js', () => ({
  ensureModel: vi.fn().mockResolvedValue(undefined),
}));

// Now import the module under test
import {
  getVercelEmbeddingModel,
  probeEmbeddingDim,
  getEmbeddingSignature,
  ensureEmbeddingDims,
} from './sdk-embedding.js';
import type { EmbeddingsReadyFlag } from './hardware-detect.js';

// ---------------------------------------------------------------------------
// getVercelEmbeddingModel
// ---------------------------------------------------------------------------

describe('getVercelEmbeddingModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use openai native SDK for openai provider', () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    try {
      const model = getVercelEmbeddingModel('code', 'text-embedding-3-large', { provider: 'openai' });
      expect(mockOpenaiTextEmbedding).toHaveBeenCalledWith('text-embedding-3-large');
      expect(model).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('should use createOpenAICompatible for voyage provider', () => {
    const saved = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = 'test-voyage-key';
    try {
      const model = getVercelEmbeddingModel('code', 'voyage-code-3', { provider: 'voyage' });
      expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.voyageai.com/v1',
          name: 'voyage',
          apiKey: 'test-voyage-key',
        }),
      );
      expect(mockCompatibleTextEmbeddingModel).toHaveBeenCalledWith('voyage-code-3');
      expect(model).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
      else delete process.env.VOYAGE_API_KEY;
    }
  });

  it('should resolve dynamic base_url for anatoly-local per kind', () => {
    const modelCode = getVercelEmbeddingModel('code', 'nomic-embed-code', { provider: 'anatoly-local' });
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://127.0.0.1:11437/v1',
      }),
    );
    expect(modelCode).toBeDefined();

    vi.clearAllMocks();

    const modelNlp = getVercelEmbeddingModel('nlp', 'qwen3-embedding-8b', { provider: 'anatoly-local' });
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://127.0.0.1:11438/v1',
      }),
    );
    expect(modelNlp).toBeDefined();
  });

  it('should pass empty apiKey for providers with env_key: null', () => {
    getVercelEmbeddingModel('code', 'nomic-embed-code', { provider: 'anatoly-local' });
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: '',
      }),
    );
  });

  it('should throw AnatolyError when required API key is missing', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() =>
        getVercelEmbeddingModel('code', 'text-embedding-3-large', { provider: 'openai' }),
      ).toThrow(/No API key for embedding provider "openai"/);
      expect(() =>
        getVercelEmbeddingModel('code', 'text-embedding-3-large', { provider: 'openai' }),
      ).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('should accept config overrides for base_url and env_key', () => {
    process.env.MY_CUSTOM_KEY = 'custom-key';
    try {
      getVercelEmbeddingModel('code', 'my-model', {
        provider: 'my-custom',
        base_url: 'https://custom.example.com/v1',
        env_key: 'MY_CUSTOM_KEY',
      });
      expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://custom.example.com/v1',
          apiKey: 'custom-key',
        }),
      );
    } finally {
      delete process.env.MY_CUSTOM_KEY;
    }
  });

  it('passes empty apiKey when an unknown provider is declared with no env_key (auth: none)', () => {
    // Mirrors how `local-advanced` is written by the wizard: openai_compatible
    // pointing at localhost with no env_key. The factory must not throw or
    // synthesize a fallback env var name — the YAML is the source of truth.
    getVercelEmbeddingModel('code', 'nomic-embed-code-gguf', {
      provider: 'local-advanced',
      base_url: 'http://localhost:8082/v1',
    });
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:8082/v1',
        apiKey: '',
      }),
    );
  });

  it('should wrap model with pre_hook for anatoly-local provider', () => {
    const model = getVercelEmbeddingModel('code', 'nomic-embed-code', { provider: 'anatoly-local' });
    // The wrapper should have a doEmbed method
    expect(model).toHaveProperty('doEmbed');
    expect(typeof model.doEmbed).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// probeEmbeddingDim
// ---------------------------------------------------------------------------

describe('probeEmbeddingDim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call embed and return embedding length', async () => {
    const fakeDim = 1536;
    const fakeEmbedding = new Array(fakeDim).fill(0.1);
    mockEmbed.mockResolvedValueOnce({ embedding: fakeEmbedding });

    const dim = await probeEmbeddingDim({ modelId: 'test-model' } as any, 'code');
    expect(dim).toBe(fakeDim);
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'anatoly probe code',
      }),
    );
  });

  it('should return correct dim for nlp kind', async () => {
    const fakeEmbedding = new Array(384).fill(0.1);
    mockEmbed.mockResolvedValueOnce({ embedding: fakeEmbedding });

    const dim = await probeEmbeddingDim({ modelId: 'test-model' } as any, 'nlp');
    expect(dim).toBe(384);
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'anatoly probe nlp',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingSignature
// ---------------------------------------------------------------------------

describe('getEmbeddingSignature', () => {
  it('should return an 8-char hex SHA256 hash', () => {
    const sig = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    expect(sig).toHaveLength(8);
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should produce consistent results for same inputs', () => {
    const a = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    const b = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    expect(a).toBe(b);
  });

  it('should produce different results for different inputs', () => {
    const a = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    const b = getEmbeddingSignature('voyage', 'voyage-code-3', 'voyage', 'voyage-3-large');
    expect(a).not.toBe(b);
  });

  it('should produce different signature when only nlpProvider changes', () => {
    const a = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    const b = getEmbeddingSignature('openai', 'text-embedding-3-large', 'voyage', 'text-embedding-3-large');
    expect(a).not.toBe(b);
  });

  it('should match manual SHA256 computation', () => {
    const input = 'openai|text-embedding-3-large|openai|text-embedding-3-large';
    const expected = createHash('sha256').update(input).digest('hex').slice(0, 8);
    const sig = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    expect(sig).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ensureEmbeddingDims
// ---------------------------------------------------------------------------

describe('ensureEmbeddingDims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use cached dims when signature matches', async () => {
    const sig = getEmbeddingSignature('openai', 'text-embedding-3-large', 'openai', 'text-embedding-3-large');
    const flag = {
      device: 'cpu',
      dim_code: 3072,
      dim_nlp: 3072,
      embedding_signature: sig,
    } as EmbeddingsReadyFlag & { embedding_signature: string };

    const resolved = {
      codeProvider: 'openai',
      codeModel: 'text-embedding-3-large',
      nlpProvider: 'openai',
      nlpModel: 'text-embedding-3-large',
      codeDim: -1,
      nlpDim: -1,
    };

    const result = await ensureEmbeddingDims(resolved, { readyFlag: flag });
    expect(result.codeDim).toBe(3072);
    expect(result.nlpDim).toBe(3072);
    // embed should NOT have been called (used cache)
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('should probe when signature does not match', async () => {
    const flag = {
      device: 'cpu',
      dim_code: 768,
      dim_nlp: 384,
      embedding_signature: 'stale000',
    } as EmbeddingsReadyFlag & { embedding_signature: string };

    const codeEmbedding = new Array(3072).fill(0.01);
    const nlpEmbedding = new Array(3072).fill(0.01);
    mockEmbed
      .mockResolvedValueOnce({ embedding: codeEmbedding })
      .mockResolvedValueOnce({ embedding: nlpEmbedding });

    const resolved = {
      codeProvider: 'openai',
      codeModel: 'text-embedding-3-large',
      nlpProvider: 'openai',
      nlpModel: 'text-embedding-3-large',
      codeDim: -1,
      nlpDim: -1,
    };

    const mockModel = { modelId: 'mock' };
    const result = await ensureEmbeddingDims(resolved, {
      readyFlag: flag,
      getCodeModel: () => mockModel as any,
      getNlpModel: () => mockModel as any,
    });
    expect(result.codeDim).toBe(3072);
    expect(result.nlpDim).toBe(3072);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it('should probe when no flag exists', async () => {
    const codeEmbedding = new Array(1536).fill(0.01);
    const nlpEmbedding = new Array(1536).fill(0.01);
    mockEmbed
      .mockResolvedValueOnce({ embedding: codeEmbedding })
      .mockResolvedValueOnce({ embedding: nlpEmbedding });

    const resolved = {
      codeProvider: 'openai',
      codeModel: 'text-embedding-3-large',
      nlpProvider: 'openai',
      nlpModel: 'text-embedding-3-large',
      codeDim: -1,
      nlpDim: -1,
    };

    const mockModel = { modelId: 'mock' };
    const result = await ensureEmbeddingDims(resolved, {
      readyFlag: null,
      getCodeModel: () => mockModel as any,
      getNlpModel: () => mockModel as any,
    });
    expect(result.codeDim).toBe(1536);
    expect(result.nlpDim).toBe(1536);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it('should call onLog when probing', async () => {
    const codeEmbedding = new Array(1536).fill(0.01);
    const nlpEmbedding = new Array(384).fill(0.01);
    mockEmbed
      .mockResolvedValueOnce({ embedding: codeEmbedding })
      .mockResolvedValueOnce({ embedding: nlpEmbedding });

    const logMessages: string[] = [];
    const resolved = {
      codeProvider: 'openai',
      codeModel: 'text-embedding-3-large',
      nlpProvider: 'openai',
      nlpModel: 'text-embedding-3-large',
      codeDim: -1,
      nlpDim: -1,
    };

    const mockModel = { modelId: 'mock' };
    await ensureEmbeddingDims(resolved, {
      readyFlag: null,
      getCodeModel: () => mockModel as any,
      getNlpModel: () => mockModel as any,
      onLog: (msg: string) => logMessages.push(msg),
    });
    expect(logMessages.some(m => m.includes('embedding dims probed'))).toBe(true);
    expect(logMessages.some(m => m.includes('code=1536'))).toBe(true);
    expect(logMessages.some(m => m.includes('nlp=384'))).toBe(true);
  });
});
