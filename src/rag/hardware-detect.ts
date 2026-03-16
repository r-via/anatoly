import { totalmem, cpus } from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
// Embeddings readiness flag (written by setup-embeddings.sh)
// ---------------------------------------------------------------------------

export interface EmbeddingsReadyFlag {
  model: string;
  dim: number;
  device: string;
  python: string;
  setup_at: string;
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
// Embed sidecar detection
// ---------------------------------------------------------------------------

export const SIDECAR_DEFAULT_PORT = 11435;
export const SIDECAR_MODEL = 'nomic-ai/nomic-embed-code';

export interface SidecarStatus {
  running: boolean;
  model?: string;
  device?: string;
  dim?: number;
  port: number;
}

/** Get the sidecar port from env or default. */
export function getSidecarPort(): number {
  const env = process.env.ANATOLY_EMBED_PORT;
  return env ? parseInt(env, 10) : SIDECAR_DEFAULT_PORT;
}

/** Get the sidecar base URL. */
export function getSidecarUrl(): string {
  return `http://127.0.0.1:${getSidecarPort()}`;
}

/**
 * Detect whether the embed sidecar is running.
 * Non-blocking: returns { running: false } on any error.
 */
export async function detectSidecar(): Promise<SidecarStatus> {
  const port = getSidecarPort();
  const status: SidecarStatus = { running: false, port };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${getSidecarUrl()}/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return status;
    const data = await res.json() as { status: string; model?: string; device?: string; dim?: number };
    if (data.status === 'ok') {
      status.running = true;
      status.model = data.model;
      status.device = data.device;
      status.dim = data.dim;
    }
  } catch {
    // Sidecar not running
  }

  return status;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Known embedding model metadata. */
export interface ModelInfo {
  dim: number;
  runtime: 'onnx' | 'sidecar';
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
  [SIDECAR_MODEL]: {
    dim: 3584,
    runtime: 'sidecar',
    description: 'Nomic Embed Code 7B (3584d, sentence-transformers)',
    minMemoryGB: 14,
    requiresGpu: true,
  },
};

export interface ResolvedModels {
  codeModel: string;
  codeDim: number;
  codeRuntime: 'onnx' | 'sidecar';
  nlpModel: string;
  nlpDim: number;
  nlpRuntime: 'onnx' | 'sidecar';
}

/**
 * Resolve embedding models based on config, hardware, and sidecar availability.
 *
 * When config value is 'auto', picks the best model the hardware can run:
 * - If the embed sidecar is running → use it (GPU-accelerated via sentence-transformers)
 * - Otherwise → fall back to Jina v2 (ONNX, CPU)
 */
export async function resolveEmbeddingModels(
  config: { code_model: string; nlp_model: string },
  hardware: HardwareProfile,
  onLog?: (message: string) => void,
): Promise<ResolvedModels> {
  const sidecar = await detectSidecar();
  const codeModel = resolveCodeModel(config.code_model, hardware, sidecar, onLog);
  const nlpModel = resolveNlpModel(config.nlp_model, onLog);

  // Use sidecar-reported dimension if available (more accurate than registry)
  const codeDim = (sidecar.running && sidecar.dim) ? sidecar.dim : (MODEL_REGISTRY[codeModel]?.dim ?? 768);
  const codeRuntime = MODEL_REGISTRY[codeModel]?.runtime ?? 'onnx';
  const nlpDim = MODEL_REGISTRY[nlpModel]?.dim ?? 384;
  const nlpRuntime = MODEL_REGISTRY[nlpModel]?.runtime ?? 'onnx';

  return { codeModel, codeDim, codeRuntime, nlpModel, nlpDim, nlpRuntime };
}

function resolveCodeModel(
  configured: string,
  hardware: HardwareProfile,
  sidecar: SidecarStatus,
  onLog?: (message: string) => void,
): string {
  if (configured !== 'auto') return configured;

  // Prefer embed sidecar when running (GPU-accelerated sentence-transformers)
  if (sidecar.running) {
    onLog?.(`embed sidecar: ${sidecar.model} on ${sidecar.device} (${sidecar.dim}d)`);
    return SIDECAR_MODEL;
  }

  // Sidecar not running — explain and fall back
  if (hardware.hasGpu) {
    onLog?.(`hardware: GPU (${hardware.gpuType}) available but embed sidecar not running — start with: python scripts/embed-server.py`);
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
