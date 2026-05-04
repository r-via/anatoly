// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { totalmem, cpus } from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { KNOWN_EMBEDDING_PROVIDERS } from './known-embedding-providers.js';

// ---------------------------------------------------------------------------
// Hardware detection
// ---------------------------------------------------------------------------

export interface HardwareProfile {
  totalMemoryGB: number;
  cpuCores: number;
  hasGpu: boolean;
  gpuType?: 'cuda' | 'metal' | 'rocm';
  vramGB?: number;
  hasDocker?: boolean;
  hasNvidiaContainerToolkit?: boolean;
}

/**
 * Detect available hardware: RAM, CPU cores, and GPU presence.
 * Used to auto-select embedding models when config is set to 'auto'.
 */
export function detectHardware(): HardwareProfile {
  const totalMemoryGB = Math.round(totalmem() / (1024 ** 3) * 10) / 10;
  const cpuCores = cpus().length;

  let hasGpu = false;
  let gpuType: HardwareProfile['gpuType'];

  // Check for NVIDIA GPU (CUDA)
  try {
    execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 });
    hasGpu = true;
    gpuType = 'cuda';
  } catch {
    // No NVIDIA GPU or nvidia-smi not available
  }

  // Check for Apple Silicon (Metal)
  if (!hasGpu && process.platform === 'darwin') {
    try {
      const output = execSync('sysctl -n machdep.cpu.brand_string', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (output.includes('Apple')) {
        hasGpu = true;
        gpuType = 'metal';
      }
    } catch {
      // Not Apple Silicon
    }
  }

  // Check for AMD GPU (ROCm)
  if (!hasGpu) {
    try {
      execSync('rocm-smi', { stdio: 'ignore', timeout: 5000 });
      hasGpu = true;
      gpuType = 'rocm';
    } catch {
      // No AMD GPU or rocm-smi not available
    }
  }

  // Detect VRAM (NVIDIA only for now)
  let vramGB: number | undefined;
  if (gpuType === 'cuda') {
    vramGB = detectVramGB();
  }

  // Detect Docker + NVIDIA Container Toolkit
  const hasDocker = detectDocker();
  const hasNvidiaContainerToolkit = hasDocker && gpuType === 'cuda' ? detectNvidiaContainerToolkit() : false;

  return { totalMemoryGB, cpuCores, hasGpu, gpuType, vramGB, hasDocker, hasNvidiaContainerToolkit };
}

/**
 * Detect total VRAM in GB via nvidia-smi.
 * Returns undefined if nvidia-smi is unavailable.
 */
export function detectVramGB(): number | undefined {
  try {
    const output = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    // nvidia-smi returns MiB — convert to GB
    const mib = parseInt(output.split('\n')[0]!, 10);
    if (isNaN(mib)) return undefined;
    return Math.round(mib / 1024 * 10) / 10;
  } catch {
    return undefined;
  }
}

/** Check if Docker daemon is running and accessible. */
export function detectDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if NVIDIA Container Toolkit is installed (needed for --gpus flag). */
export function detectNvidiaContainerToolkit(): boolean {
  try {
    execSync('nvidia-container-cli --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    // Fallback: check if nvidia runtime is registered in Docker
    try {
      const output = execSync('docker info', { encoding: 'utf-8', timeout: 10000 });
      return output.includes('nvidia');
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Embeddings readiness flag (written by setup-embeddings.sh)
// ---------------------------------------------------------------------------

/** Embedding backend type — determines runtime embedding strategy. */
export type EmbeddingBackend = 'lite' | 'advanced-fp16' | 'advanced-gguf' | 'external';

// 'advanced-gguf' is a legacy label preserved for traceability — mapped
// internally to provider: 'anatoly-local' + runtime: 'sdk'.
// 'advanced-fp16' is no longer used at runtime (TEI replaced it) — treated as 'lite'.
// 'external' means a third-party embedding provider configured via .anatoly.yml.

/**
 * Shape of the `.anatoly/embeddings-ready.json` flag file written by
 * `setup-embeddings.sh` after successful embedding backend configuration.
 *
 * Read at runtime by {@link readEmbeddingsReadyFlag} to determine which
 * embedding backend and models to use.
 */
export interface EmbeddingsReadyFlag {
  model?: string;
  dim?: number;
  code_model?: string;
  nlp_model?: string;
  dim_code?: number;
  dim_nlp?: number;
  device: string;
  /** @deprecated Python is no longer used. Kept for backwards compatibility. */
  python?: string;
  setup_at?: string;
  checked_at?: string;
  code_quantize?: boolean;
  nlp_quantize?: boolean;
  code_precision?: string;
  nlp_precision?: string;
  /** Embedding backend: lite (ONNX) or advanced-gguf (Docker llama.cpp). */
  backend?: EmbeddingBackend;
  /** VRAM detected in GB at setup time. */
  vram_gb?: number;
  /** Path to GGUF code model file (for advanced-gguf backend). */
  gguf_code_model?: string;
  /** Path to GGUF NLP model file (for advanced-gguf backend). */
  gguf_nlp_model?: string;
  /** Docker image for the GGUF backend. */
  docker_image?: string;
  /** ISO timestamp of last A/B test. */
  ab_test_at?: string;
  /** Embedding provider for external backend (e.g. 'openai', 'voyage'). */
  embedding_provider?: string;
  /** SHA256 signature of the embedding config (for dim cache invalidation). */
  embedding_signature?: string;
}

/**
 * Check if setup-embeddings.sh has been run successfully.
 * Returns the flag data if .anatoly/embeddings-ready.json exists, null otherwise.
 */
export function readEmbeddingsReadyFlag(projectRoot: string): EmbeddingsReadyFlag | null {
  const flagPath = resolve(projectRoot, '.anatoly', 'embeddings-ready.json');
  if (!existsSync(flagPath)) return null;
  try {
    return JSON.parse(readFileSync(flagPath, 'utf-8')) as EmbeddingsReadyFlag;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

export const CODE_MODEL_ID = 'nomic-ai/nomic-embed-code';
export const NLP_MODEL_ID = 'Qwen/Qwen3-Embedding-8B';

// GGUF Docker backend constants
export const GGUF_DOCKER_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-cuda';
export const GGUF_CODE_PORT = 11437;
export const GGUF_NLP_PORT = 11438;
export const GGUF_CODE_MODEL_FILE = 'nomic-embed-code.Q5_K_M.gguf';
export const GGUF_NLP_MODEL_FILE = 'Qwen3-Embedding-8B-Q5_K_M.gguf';
/** Minimum VRAM (GB) required for GGUF dual-model loading. */
export const GGUF_MIN_VRAM_GB = 12;

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Known embedding model metadata. */
export interface ModelInfo {
  dim: number;
  runtime: 'onnx' | 'gguf';
  description: string;
  minMemoryGB: number;
  requiresGpu?: boolean;
}

/**
 * Registry of known embedding models with their properties.
 * When config specifies a model not in this registry, dimensions
 * are detected at runtime from the first embedding output.
 */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // ONNX models (CPU, in-process via @huggingface/transformers)
  'jinaai/jina-embeddings-v2-base-code': {
    dim: 768,
    runtime: 'onnx',
    description: 'Jina Code v2 (768d, ONNX)',
    minMemoryGB: 2,
  },
  'Xenova/all-MiniLM-L6-v2': {
    dim: 384,
    runtime: 'onnx',
    description: 'MiniLM L6 (384d, ONNX)',
    minMemoryGB: 1,
  },
  'Xenova/nomic-embed-text-v1': {
    dim: 768,
    runtime: 'onnx',
    description: 'Nomic Text v1 (768d, ONNX)',
    minMemoryGB: 2,
  },
  // GGUF Docker backends (quantized Q5_K_M, via llama.cpp server-cuda)
  'nomic-embed-code-gguf': {
    dim: 3584,
    runtime: 'gguf',
    description: 'Nomic Embed Code Q5_K_M (3584d, llama.cpp Docker)',
    minMemoryGB: 6,
    requiresGpu: true,
  },
  'qwen3-embedding-8b-gguf': {
    dim: 4096,
    runtime: 'gguf',
    description: 'Qwen3 Embedding 8B Q5_K_M (4096d, llama.cpp Docker)',
    minMemoryGB: 6,
    requiresGpu: true,
  },
};

export interface ResolvedModels {
  codeModel: string;
  codeDim: number;
  codeRuntime: 'onnx' | 'gguf' | 'sdk';
  nlpModel: string;
  nlpDim: number;
  nlpRuntime: 'onnx' | 'gguf' | 'sdk';
  backend: EmbeddingBackend;
  /** Provider identifier for code embeddings (set when runtime is 'sdk'). */
  codeProvider?: string;
  /** Base URL for code embedding API (absent for native SDK providers like openai). */
  codeBaseUrl?: string;
  /** Environment variable name for code embedding API key. null = no key needed. */
  codeEnvKey?: string | null;
  /** Provider identifier for NLP embeddings (set when runtime is 'sdk'). */
  nlpProvider?: string;
  /** Base URL for NLP embedding API. */
  nlpBaseUrl?: string;
  /** Environment variable name for NLP embedding API key. null = no key needed. */
  nlpEnvKey?: string | null;
}

/**
 * Determine the backend tier from embeddings-ready.json.
 * Returns the backend field if set, or infers from available infrastructure.
 *
 * Runtime backends: advanced-gguf (Docker GPU) or lite (ONNX CPU).
 * The legacy 'advanced-fp16' is treated as 'lite' at runtime since
 * fp16 has been replaced by Docker-only backends.
 */
export function determineBackend(
  flag: EmbeddingsReadyFlag | null,
  _hardware: HardwareProfile,
): EmbeddingBackend {
  // Explicit backend from setup
  if (flag?.backend) {
    // Treat legacy fp16 as lite (no longer a runtime backend)
    if (flag.backend === 'advanced-fp16') return 'lite';
    return flag.backend;
  }

  // No setup flag → always lite (advanced-gguf requires setup-embeddings)
  return 'lite';
}

/** Embedding provider config from .anatoly.yml (per-axis). */
interface EmbeddingAxisConfig {
  provider: string;
  model?: string;
  base_url?: string;
  env_key?: string;
}

/**
 * Resolve embedding models based on config and hardware.
 *
 * Routes to one of three strategies:
 * - `lite` → ONNX CPU (in-process @huggingface/transformers)
 * - `advanced-gguf` → SDK via anatoly-local Docker containers
 * - `external` → SDK via third-party provider (OpenAI, Voyage, etc.)
 */
export async function resolveEmbeddingModels(
  config: {
    code_model: string;
    nlp_model: string;
    embedding?: { code?: EmbeddingAxisConfig; nlp?: EmbeddingAxisConfig };
  },
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
  readyFlag?: EmbeddingsReadyFlag | null,
): Promise<ResolvedModels> {
  const backend = determineBackend(readyFlag ?? null, hardware);

  if (backend === 'advanced-gguf') {
    return resolveAdvancedGguf(onLog);
  }

  if (backend === 'external') {
    return resolveExternalBackend(config, readyFlag ?? null, onLog);
  }

  // lite backend — ONNX path (unchanged)
  return resolveLiteBackend(config, hardware, onLog);
}

/** Resolve for lite (ONNX) backend. */
function resolveLiteBackend(
  config: { code_model: string; nlp_model: string },
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
): ResolvedModels {
  const codeModel = resolveCodeModel(config.code_model, hardware, onLog, 'lite');
  const codeDim = MODEL_REGISTRY[codeModel]?.dim ?? 768;
  const nlpModel = resolveNlpModel(config.nlp_model, 'onnx', onLog);
  const nlpDim = MODEL_REGISTRY[nlpModel]?.dim ?? 384;
  return { codeModel, codeDim, codeRuntime: 'onnx', nlpModel, nlpDim, nlpRuntime: 'onnx', backend: 'lite' };
}

/** Resolve for advanced-gguf backend (SDK via anatoly-local Docker). */
function resolveAdvancedGguf(onLog?: (message: string) => void): ResolvedModels {
  const provider = KNOWN_EMBEDDING_PROVIDERS['anatoly-local']!;
  const codeModel = provider.default_code_model;
  const nlpModel = provider.default_nlp_model;
  const codeDim = MODEL_REGISTRY['nomic-embed-code-gguf']?.dim ?? 3584;
  const nlpDim = MODEL_REGISTRY['qwen3-embedding-8b-gguf']?.dim ?? 4096;
  const codeBaseUrl = typeof provider.base_url === 'function' ? provider.base_url('code') : provider.base_url;
  const nlpBaseUrl = typeof provider.base_url === 'function' ? provider.base_url('nlp') : provider.base_url;

  onLog?.(`backend: advanced-gguf → SDK via anatoly-local (${codeModel} + ${nlpModel})`);

  return {
    codeModel, codeDim, codeRuntime: 'sdk',
    nlpModel, nlpDim, nlpRuntime: 'sdk',
    backend: 'advanced-gguf',
    codeProvider: 'anatoly-local',
    codeBaseUrl: codeBaseUrl ?? undefined,
    codeEnvKey: null,
    nlpProvider: 'anatoly-local',
    nlpBaseUrl: nlpBaseUrl ?? undefined,
    nlpEnvKey: null,
  };
}

/** Resolve for external backend (SDK via third-party provider). */
function resolveExternalBackend(
  config: {
    code_model: string;
    nlp_model: string;
    embedding?: { code?: EmbeddingAxisConfig; nlp?: EmbeddingAxisConfig };
  },
  readyFlag: EmbeddingsReadyFlag | null,
  onLog?: (message: string) => void,
): ResolvedModels {
  // FR8: bidirectional duplication rule.
  // If only one axis section is configured, the other inherits from it.
  const rawCode = config.embedding?.code;
  const rawNlp = config.embedding?.nlp;
  const effectiveCode = rawCode ?? rawNlp;
  const effectiveNlp = rawNlp ?? rawCode;

  // Determine providers: config > flag > default
  const codeProvider = effectiveCode?.provider ?? readyFlag?.embedding_provider ?? 'openai';
  const nlpProvider = effectiveNlp?.provider ?? readyFlag?.embedding_provider ?? 'openai';

  const codeEntry = KNOWN_EMBEDDING_PROVIDERS[codeProvider];
  const nlpEntry = KNOWN_EMBEDDING_PROVIDERS[nlpProvider];

  // Determine models: config > registry defaults
  const codeModel = effectiveCode?.model ?? codeEntry?.default_code_model ?? '';
  const nlpModel = effectiveNlp?.model ?? nlpEntry?.default_nlp_model ?? '';

  // Resolve base URLs: config > registry
  const codeBaseUrl = effectiveCode?.base_url
    ?? (typeof codeEntry?.base_url === 'function' ? codeEntry.base_url('code') : codeEntry?.base_url)
    ?? undefined;
  const nlpBaseUrl = effectiveNlp?.base_url
    ?? (typeof nlpEntry?.base_url === 'function' ? nlpEntry.base_url('nlp') : nlpEntry?.base_url)
    ?? undefined;

  // Resolve env keys: config > registry
  const codeEnvKey = effectiveCode?.env_key ?? codeEntry?.env_key ?? null;
  const nlpEnvKey = effectiveNlp?.env_key ?? nlpEntry?.env_key ?? null;

  // Dims: from MODEL_REGISTRY if known, otherwise sentinel -1 (probe via ensureEmbeddingDims)
  const codeDim = MODEL_REGISTRY[codeModel]?.dim ?? -1;
  const nlpDim = MODEL_REGISTRY[nlpModel]?.dim ?? -1;

  onLog?.(`backend: external → ${codeProvider}/${codeModel} (code), ${nlpProvider}/${nlpModel} (nlp)`);

  return {
    codeModel, codeDim, codeRuntime: 'sdk',
    nlpModel, nlpDim, nlpRuntime: 'sdk',
    backend: 'external',
    codeProvider, codeBaseUrl: codeBaseUrl ?? undefined, codeEnvKey,
    nlpProvider, nlpBaseUrl: nlpBaseUrl ?? undefined, nlpEnvKey,
  };
}

function resolveCodeModel(
  configured: string,
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
  backend?: EmbeddingBackend,
): string {
  if (configured !== 'auto') return configured;

  // GGUF Docker backend — use the GGUF model key
  if (backend === 'advanced-gguf') {
    onLog?.(`backend: advanced-gguf — ${MODEL_REGISTRY['nomic-embed-code-gguf']!.description}`);
    return 'nomic-embed-code-gguf';
  }

  // No GPU or no Docker — ONNX fallback
  if (!hardware.hasGpu) {
    onLog?.(`hardware: no GPU detected — using ${MODEL_REGISTRY['jinaai/jina-embeddings-v2-base-code']!.description}`);
  } else {
    onLog?.(`hardware: GPU available but GGUF backend not configured — using ONNX fallback`);
  }

  return 'jinaai/jina-embeddings-v2-base-code';
}

function resolveNlpModel(
  configured: string,
  codeRuntime: 'onnx' | 'gguf' | 'sdk',
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  // GGUF Docker backend — use GGUF NLP model (legacy path for direct GGUF callers)
  if (codeRuntime === 'gguf') {
    onLog?.(`NLP model: ${MODEL_REGISTRY['qwen3-embedding-8b-gguf']!.description} (Docker)`);
    return 'qwen3-embedding-8b-gguf';
  }

  const model = 'Xenova/all-MiniLM-L6-v2';
  onLog?.(`NLP model: ${MODEL_REGISTRY[model]!.description}`);
  return model;
}
