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

export interface OllamaStatus {
  running: boolean;
  hasModel: boolean;
  host: string;
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

// ---------------------------------------------------------------------------
// Ollama detection
// ---------------------------------------------------------------------------

const OLLAMA_MODEL = 'manutic/nomic-embed-code';
const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';

/** Get the Ollama host from env or default. */
export function getOllamaHost(): string {
  return process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_HOST;
}

/**
 * Detect whether Ollama is running and has the required embedding model.
 * Non-blocking: returns { running: false, hasModel: false } on any error.
 */
export async function detectOllama(): Promise<OllamaStatus> {
  const host = getOllamaHost();
  const status: OllamaStatus = { running: false, hasModel: false, host };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return status;
    status.running = true;

    const data = await res.json() as { models?: Array<{ name: string }> };
    status.hasModel = data.models?.some((m) => m.name.startsWith(OLLAMA_MODEL)) ?? false;
  } catch {
    // Ollama not running or not reachable
  }

  return status;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Known embedding model metadata. */
export interface ModelInfo {
  dim: number;
  runtime: 'onnx' | 'ollama';
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
  'manutic/nomic-embed-code': {
    dim: 768,
    runtime: 'ollama',
    description: 'Nomic Embed Code (768d, Ollama)',
    minMemoryGB: 4,
    requiresGpu: true,
  },
};

export interface ResolvedModels {
  codeModel: string;
  codeDim: number;
  codeRuntime: 'onnx' | 'ollama';
  nlpModel: string;
  nlpDim: number;
  nlpRuntime: 'onnx' | 'ollama';
}

/**
 * Resolve embedding models based on config, hardware, and Ollama availability.
 *
 * When config value is 'auto', picks the best model the hardware can run:
 * - If Ollama is running with nomic-embed-code → use it (GPU-accelerated)
 * - Otherwise → fall back to Jina v2 (ONNX, CPU)
 */
export async function resolveEmbeddingModels(
  config: { code_model: string; nlp_model: string },
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
): Promise<ResolvedModels> {
  const ollama = await detectOllama();
  const codeModel = resolveCodeModel(config.code_model, hardware, ollama, onLog);
  const nlpModel = resolveNlpModel(config.nlp_model, onLog);

  const codeDim = MODEL_REGISTRY[codeModel]?.dim ?? 768;
  const codeRuntime = MODEL_REGISTRY[codeModel]?.runtime ?? 'onnx';
  const nlpDim = MODEL_REGISTRY[nlpModel]?.dim ?? 384;
  const nlpRuntime = MODEL_REGISTRY[nlpModel]?.runtime ?? 'onnx';

  return { codeModel, codeDim, codeRuntime, nlpModel, nlpDim, nlpRuntime };
}

function resolveCodeModel(
  configured: string,
  hardware: HardwareProfile,
  ollama: OllamaStatus,
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  // Prefer Ollama with nomic-embed-code when available
  if (ollama.running && ollama.hasModel) {
    const info = MODEL_REGISTRY[OLLAMA_MODEL]!;
    onLog?.(`hardware: GPU (${hardware.gpuType ?? 'detected'}) — Ollama running with ${info.description}`);
    return OLLAMA_MODEL;
  }

  // Ollama not available — explain why and fall back
  if (hardware.hasGpu) {
    if (!ollama.running) {
      onLog?.(`hardware: GPU (${hardware.gpuType}) available but Ollama not running — run ./scripts/setup-ollama.sh to enable GPU embeddings`);
    } else {
      onLog?.(`hardware: Ollama running but model ${OLLAMA_MODEL} not found — run: ollama pull ${OLLAMA_MODEL}`);
    }
  } else {
    onLog?.(`hardware: no GPU detected — using ${MODEL_REGISTRY['jinaai/jina-embeddings-v2-base-code']!.description}`);
  }

  return 'jinaai/jina-embeddings-v2-base-code';
}

function resolveNlpModel(
  configured: string,
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  const model = 'Xenova/all-MiniLM-L6-v2';
  onLog?.(`NLP model: ${MODEL_REGISTRY[model]!.description}`);
  return model;
}
