import { totalmem, cpus } from 'node:os';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Hardware detection
// ---------------------------------------------------------------------------

export interface HardwareProfile {
  totalMemoryGB: number;
  cpuCores: number;
  hasGpu: boolean;
  gpuType?: 'cuda' | 'metal' | 'rocm';
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

  return { totalMemoryGB, cpuCores, hasGpu, gpuType };
}

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
  'nomic-ai/nomic-embed-code': {
    dim: 768,
    runtime: 'gguf',
    description: 'Nomic Code 7B (768d, GGUF)',
    minMemoryGB: 16,
    requiresGpu: true,
  },
};

export interface ResolvedModels {
  codeModel: string;
  codeDim: number;
  nlpModel: string;
  nlpDim: number;
}

/**
 * Resolve embedding models based on config and hardware.
 *
 * When config value is 'auto', picks the best model the hardware can run.
 * When a specific model ID is set, uses that model directly.
 */
export function resolveEmbeddingModels(
  config: { code_model: string; nlp_model: string },
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
): ResolvedModels {
  const codeModel = resolveCodeModel(config.code_model, hardware, onLog);
  const nlpModel = resolveNlpModel(config.nlp_model, hardware, onLog);

  const codeDim = MODEL_REGISTRY[codeModel]?.dim ?? 768;
  const nlpDim = MODEL_REGISTRY[nlpModel]?.dim ?? 384;

  return { codeModel, codeDim, nlpModel, nlpDim };
}

function resolveCodeModel(
  configured: string,
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  // nomic-embed-code (7B) requires GPU + 16GB+ RAM and GGUF runtime
  const canRunNomic = hardware.hasGpu && hardware.totalMemoryGB >= 16;

  if (canRunNomic) {
    const info = MODEL_REGISTRY['nomic-ai/nomic-embed-code']!;
    if (info.runtime === 'gguf') {
      onLog?.(`hardware: GPU (${hardware.gpuType}) + ${hardware.totalMemoryGB.toFixed(0)}GB RAM — ${info.description} eligible but GGUF runtime not yet integrated, using Jina fallback`);
    }
  } else {
    const reason = !hardware.hasGpu ? 'no GPU detected' : `${hardware.totalMemoryGB.toFixed(0)}GB RAM < 16GB required`;
    onLog?.(`hardware: ${reason} — using ${MODEL_REGISTRY['jinaai/jina-embeddings-v2-base-code']!.description}`);
  }

  // Fallback to Jina until GGUF runtime is added
  return 'jinaai/jina-embeddings-v2-base-code';
}

function resolveNlpModel(
  configured: string,
  _hardware: HardwareProfile,
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  const model = 'Xenova/all-MiniLM-L6-v2';
  onLog?.(`NLP model: ${MODEL_REGISTRY[model]!.description}`);
  return model;
}
