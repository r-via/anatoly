// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  determineBackend,
  resolveEmbeddingModels,
  type HardwareProfile,
  type EmbeddingsReadyFlag,
  type EmbeddingBackend,
} from './hardware-detect.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const liteHardware: HardwareProfile = {
  totalMemoryGB: 8,
  cpuCores: 4,
  hasGpu: false,
};

const gpuHardware: HardwareProfile = {
  totalMemoryGB: 32,
  cpuCores: 8,
  hasGpu: true,
  gpuType: 'cuda',
  vramGB: 16,
};

const defaultConfig = { code_model: 'auto' as string, nlp_model: 'auto' as string };

// ---------------------------------------------------------------------------
// determineBackend (Story 50.5)
// ---------------------------------------------------------------------------

describe('determineBackend — extended for external (Story 50.5)', () => {
  it('should return external when flag has backend external', () => {
    const flag = { device: 'cpu', backend: 'external' as EmbeddingBackend };
    expect(determineBackend(flag, liteHardware)).toBe('external');
  });

  it('should return advanced-gguf when flag has backend advanced-gguf', () => {
    const flag = { device: 'cuda', backend: 'advanced-gguf' as EmbeddingBackend };
    expect(determineBackend(flag, gpuHardware)).toBe('advanced-gguf');
  });

  it('should return lite when flag has backend advanced-fp16 (legacy)', () => {
    const flag = { device: 'cpu', backend: 'advanced-fp16' as EmbeddingBackend };
    expect(determineBackend(flag, liteHardware)).toBe('lite');
  });

  it('should return lite when flag has backend lite', () => {
    const flag = { device: 'cpu', backend: 'lite' as EmbeddingBackend };
    expect(determineBackend(flag, liteHardware)).toBe('lite');
  });

  it('should return lite when no flag', () => {
    expect(determineBackend(null, liteHardware)).toBe('lite');
  });

  it('should infer external when no flag but config.rag.embedding.code.provider is set', () => {
    const config = { rag: { embedding: { code: { provider: 'voyage' } } } };
    expect(determineBackend(null, liteHardware, config)).toBe('external');
  });

  it('should infer external when no flag but config.rag.embedding.nlp.provider is set', () => {
    const config = { rag: { embedding: { nlp: { provider: 'openai' } } } };
    expect(determineBackend(null, liteHardware, config)).toBe('external');
  });

  it('should still return lite when no flag and config has no rag.embedding', () => {
    const config = { rag: {} };
    expect(determineBackend(null, liteHardware, config)).toBe('lite');
  });

  it('should respect explicit flag.backend over config inference', () => {
    const flag = { device: 'cpu', backend: 'lite' as EmbeddingBackend };
    const config = { rag: { embedding: { code: { provider: 'voyage' } } } };
    // The flag is the source of truth — config inference only kicks in when
    // no flag exists.
    expect(determineBackend(flag, liteHardware, config)).toBe('lite');
  });
});

// ---------------------------------------------------------------------------
// resolveEmbeddingModels — lite backend (Story 50.5)
// ---------------------------------------------------------------------------

describe('resolveEmbeddingModels — lite backend (Story 50.5)', () => {
  it('should return onnx runtime with no provider fields', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, liteHardware);
    expect(result.codeRuntime).toBe('onnx');
    expect(result.nlpRuntime).toBe('onnx');
    expect(result.backend).toBe('lite');
    expect(result.codeProvider).toBeUndefined();
    expect(result.nlpProvider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEmbeddingModels — advanced-gguf backend (Story 50.5)
// ---------------------------------------------------------------------------

describe('resolveEmbeddingModels — advanced-gguf backend (Story 50.5)', () => {
  const ggufFlag: EmbeddingsReadyFlag = {
    device: 'cuda',
    backend: 'advanced-gguf',
  };

  it('should return sdk runtime with anatoly-local provider', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, ggufFlag);
    expect(result.codeRuntime).toBe('sdk');
    expect(result.nlpRuntime).toBe('sdk');
    expect(result.codeProvider).toBe('anatoly-local');
    expect(result.nlpProvider).toBe('anatoly-local');
  });

  it('should set correct base URLs for code and nlp', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, ggufFlag);
    expect(result.codeBaseUrl).toBe('http://127.0.0.1:11437/v1');
    expect(result.nlpBaseUrl).toBe('http://127.0.0.1:11438/v1');
  });

  it('should set null env keys for anatoly-local', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, ggufFlag);
    expect(result.codeEnvKey).toBeNull();
    expect(result.nlpEnvKey).toBeNull();
  });

  it('should set dims from MODEL_REGISTRY (3584 code, 4096 nlp)', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, ggufFlag);
    expect(result.codeDim).toBe(3584);
    expect(result.nlpDim).toBe(4096);
  });

  it('should preserve advanced-gguf as backend label for traceability', async () => {
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, ggufFlag);
    expect(result.backend).toBe('advanced-gguf');
  });
});

// ---------------------------------------------------------------------------
// resolveEmbeddingModels — external backend (Story 50.5)
// ---------------------------------------------------------------------------

describe('resolveEmbeddingModels — external backend (Story 50.5)', () => {
  const externalFlag: EmbeddingsReadyFlag = {
    device: 'cpu',
    backend: 'external' as EmbeddingBackend,
  };

  it('should return sdk runtime with openai provider from config', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'openai', model: 'text-embedding-3-large' },
        nlp: { provider: 'openai', model: 'text-embedding-3-large' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeRuntime).toBe('sdk');
    expect(result.nlpRuntime).toBe('sdk');
    expect(result.codeProvider).toBe('openai');
    expect(result.nlpProvider).toBe('openai');
    expect(result.backend).toBe('external');
  });

  it('should use sentinel dims (-1) for unknown models', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'openai', model: 'text-embedding-3-large' },
        nlp: { provider: 'openai', model: 'text-embedding-3-large' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeDim).toBe(-1);
    expect(result.nlpDim).toBe(-1);
  });

  it('should support different providers for code and nlp', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'voyage', model: 'voyage-code-3' },
        nlp: { provider: 'qwen', model: 'text-embedding-v4' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeProvider).toBe('voyage');
    expect(result.nlpProvider).toBe('qwen');
    expect(result.codeModel).toBe('voyage-code-3');
    expect(result.nlpModel).toBe('text-embedding-v4');
  });

  it('should resolve env_key from registry for known providers', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'openai' },
        nlp: { provider: 'voyage' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeEnvKey).toBe('OPENAI_API_KEY');
    expect(result.nlpEnvKey).toBe('VOYAGE_API_KEY');
  });

  it('should use default models from registry when model not in config', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'voyage' },
        nlp: { provider: 'qwen' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeModel).toBe('voyage-code-3');
    expect(result.nlpModel).toBe('text-embedding-v4');
  });

  // FR8: bidirectional duplication — only code configured → nlp inherits
  it('should duplicate code config to nlp when only code is configured (FR8)', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'voyage', model: 'voyage-code-3' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeProvider).toBe('voyage');
    expect(result.nlpProvider).toBe('voyage');
    expect(result.codeModel).toBe('voyage-code-3');
    expect(result.nlpModel).toBe('voyage-code-3');
  });

  // FR8: bidirectional duplication — only nlp configured → code inherits
  it('should duplicate nlp config to code when only nlp is configured (FR8)', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        nlp: { provider: 'qwen', model: 'text-embedding-v4' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeProvider).toBe('qwen');
    expect(result.nlpProvider).toBe('qwen');
    expect(result.codeModel).toBe('text-embedding-v4');
    expect(result.nlpModel).toBe('text-embedding-v4');
  });

  // FR8: both configured → use independently (no duplication)
  it('should use independent configs when both code and nlp are configured (FR8)', async () => {
    const config = {
      ...defaultConfig,
      embedding: {
        code: { provider: 'voyage', model: 'voyage-code-3' },
        nlp: { provider: 'qwen', model: 'text-embedding-v4' },
      },
    };
    const result = await resolveEmbeddingModels(config, liteHardware, undefined, externalFlag);
    expect(result.codeProvider).toBe('voyage');
    expect(result.nlpProvider).toBe('qwen');
  });
});

// ---------------------------------------------------------------------------
// Backward compat — pre-Epic-50 flags (Story 50.5)
// ---------------------------------------------------------------------------

describe('resolveEmbeddingModels — backward compat (Story 50.5)', () => {
  it('should map advanced-gguf flag without embedding_provider to anatoly-local', async () => {
    const legacyFlag: EmbeddingsReadyFlag = {
      device: 'cuda',
      backend: 'advanced-gguf',
      // No embedding_provider — pre-Epic-50 format
    };
    const result = await resolveEmbeddingModels(defaultConfig, gpuHardware, undefined, legacyFlag);
    expect(result.codeProvider).toBe('anatoly-local');
    expect(result.codeRuntime).toBe('sdk');
  });

  it('should route external flag with embedding_provider to that provider', async () => {
    const flag: EmbeddingsReadyFlag = {
      device: 'cpu',
      backend: 'external' as EmbeddingBackend,
      embedding_provider: 'voyage',
    };
    const result = await resolveEmbeddingModels(defaultConfig, liteHardware, undefined, flag);
    expect(result.codeProvider).toBe('voyage');
    expect(result.codeModel).toBe('voyage-code-3');
    expect(result.nlpProvider).toBe('voyage');
    expect(result.nlpModel).toBe('voyage-3-large');
  });
});

// ---------------------------------------------------------------------------
// EmbeddingsReadyFlag — new fields (Story 50.5)
// ---------------------------------------------------------------------------

describe('EmbeddingsReadyFlag — new fields (Story 50.5)', () => {
  it('should accept embedding_provider and embedding_signature fields', () => {
    const flag: EmbeddingsReadyFlag = {
      device: 'cpu',
      backend: 'external' as EmbeddingBackend,
      embedding_provider: 'openai',
      embedding_signature: 'abc12345',
    };
    expect(flag.embedding_provider).toBe('openai');
    expect(flag.embedding_signature).toBe('abc12345');
  });
});
