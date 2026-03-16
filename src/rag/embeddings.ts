import { MODEL_REGISTRY, getSidecarUrl, type ResolvedModels } from './hardware-detect.js';

// ---------------------------------------------------------------------------
// Defaults (used when configureModels() has not been called)
// ---------------------------------------------------------------------------

const DEFAULT_CODE_MODEL = 'jinaai/jina-embeddings-v2-base-code';
const DEFAULT_NLP_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** @deprecated Use getCodeDim() / getNlpDim() for dynamic dimensions. */
export const EMBEDDING_DIM = 768;

/** @deprecated Use getCodeModelId() instead. */
export const EMBEDDING_MODEL = DEFAULT_CODE_MODEL;

const MAX_CODE_CHARS = 1500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let codeModelId = DEFAULT_CODE_MODEL;
let nlpModelId = DEFAULT_NLP_MODEL;
let codeRuntime: 'onnx' | 'sidecar' = 'onnx';
let nlpRuntime: 'onnx' | 'sidecar' = 'onnx';
let codeDim = MODEL_REGISTRY[DEFAULT_CODE_MODEL]?.dim ?? 768;
let nlpDim = MODEL_REGISTRY[DEFAULT_NLP_MODEL]?.dim ?? 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let codeEmbedderPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nlpEmbedderPromise: Promise<any> | null = null;

let onLog: (message: string) => void = () => {};
let sidecarFallbackWarned = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Set the log callback for embedding operations.
 * Called during model loading to report progress.
 */
export function setEmbeddingLogger(logger: (message: string) => void): void {
  onLog = logger;
}

/**
 * Configure which models to use for code and NLP embedding.
 * Must be called before any embed calls. Resets cached model instances.
 */
export function configureModels(resolved: ResolvedModels): void {
  codeModelId = resolved.codeModel;
  nlpModelId = resolved.nlpModel;
  codeRuntime = resolved.codeRuntime;
  nlpRuntime = resolved.nlpRuntime;
  codeDim = resolved.codeDim;
  nlpDim = resolved.nlpDim;

  // Reset cached embedders so new models are loaded
  codeEmbedderPromise = null;
  nlpEmbedderPromise = null;
  onnxFallbackPromise = null;
  sidecarFallbackWarned = false;
}

/** Current code embedding model ID. */
export function getCodeModelId(): string {
  return codeModelId;
}

/** Current NLP embedding model ID. */
export function getNlpModelId(): string {
  return nlpModelId;
}

/** Dimension of the code embedding model's output vectors. */
export function getCodeDim(): number {
  return codeDim;
}

/** Dimension of the NLP embedding model's output vectors. */
export function getNlpDim(): number {
  return nlpDim;
}

// ---------------------------------------------------------------------------
// Sidecar embedding via HTTP API (sentence-transformers)
// ---------------------------------------------------------------------------

async function embedViaSidecar(text: string): Promise<number[]> {
  const url = getSidecarUrl();
  const res = await fetch(`${url}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text }),
  });

  if (!res.ok) {
    throw new Error(`embed sidecar failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { embedding: number[] };
  return data.embedding;
}

/** Embed via ONNX (Jina fallback). Always uses Jina regardless of codeModelId. */
let onnxFallbackPromise: Promise<any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
async function embedViaOnnx(text: string): Promise<number[]> {
  if (!onnxFallbackPromise) {
    onnxFallbackPromise = loadOnnxModel(DEFAULT_CODE_MODEL);
  }
  const model = await onnxFallbackPromise;
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

// ---------------------------------------------------------------------------
// ONNX model loading (lazy singletons per model type)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOnnxModel(modelId: string): Promise<any> {
  onLog(`loading ONNX embedding model ${modelId}...`);
  const { pipeline } = await import('@xenova/transformers');
  const model = await pipeline('feature-extraction', modelId);
  onLog(`embedding model ready: ${modelId}`);
  return model;
}

/**
 * Get the code embedding model (lazy singleton, ONNX only).
 * Caches the promise to prevent concurrent callers from loading twice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCodeEmbedder(): Promise<any> {
  if (!codeEmbedderPromise) {
    codeEmbedderPromise = loadOnnxModel(codeModelId);
  }
  return codeEmbedderPromise;
}

/**
 * Get the NLP embedding model (lazy singleton, ONNX only).
 * Reuses the code embedder if both models are the same.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNlpEmbedder(): Promise<any> {
  if (nlpModelId === codeModelId) {
    return getCodeEmbedder();
  }
  if (!nlpEmbedderPromise) {
    nlpEmbedderPromise = loadOnnxModel(nlpModelId);
  }
  return nlpEmbedderPromise;
}

// ---------------------------------------------------------------------------
// Embedding functions
// ---------------------------------------------------------------------------

/**
 * Generate a code embedding vector for the given text.
 * Routes to sidecar when available; falls back to ONNX on any sidecar error.
 */
export async function embedCode(text: string): Promise<number[]> {
  if (codeRuntime === 'sidecar') {
    try {
      return await embedViaSidecar(text);
    } catch (err) {
      if (!sidecarFallbackWarned) {
        onLog(`embed sidecar failed, falling back to ONNX: ${(err as Error).message}`);
        sidecarFallbackWarned = true;
      }
      return embedViaOnnx(text);
    }
  }
  return embedViaOnnx(text);
}

/**
 * Generate an NLP embedding vector for the given text.
 * Uses ONNX (NLP model is always ONNX — sidecar is code-only).
 */
export async function embedNlp(text: string): Promise<number[]> {
  const model = await getNlpEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Generate an embedding vector for the given text/code.
 * @deprecated Use embedCode() or embedNlp() for explicit model selection.
 */
export async function embed(text: string): Promise<number[]> {
  return embedCode(text);
}

// ---------------------------------------------------------------------------
// Text builders
// ---------------------------------------------------------------------------

/**
 * Build the code text to embed for a function.
 * Prefixes with name and signature, then includes the source body
 * (truncated to ~1500 chars to stay within the model's effective window).
 */
export function buildEmbedCode(name: string, signature: string, sourceBody: string): string {
  let body = sourceBody;
  if (body.length > MAX_CODE_CHARS) {
    body = body.slice(0, MAX_CODE_CHARS) + '\n// ... truncated';
  }
  return `// ${name}\n${signature}\n${body}`;
}

/**
 * Build natural language text to embed for a function's NLP summary.
 * Combines the summary, key concepts, and behavioral profile into a
 * semantically rich text representation optimized for NLP similarity.
 */
export function buildEmbedNlp(
  name: string,
  summary: string,
  keyConcepts: string[],
  behavioralProfile: string,
): string {
  const parts: string[] = [];
  parts.push(`Function: ${name}`);
  if (summary) parts.push(`Purpose: ${summary}`);
  if (keyConcepts.length > 0) parts.push(`Concepts: ${keyConcepts.join(', ')}`);
  if (behavioralProfile) parts.push(`Behavior: ${behavioralProfile}`);
  return parts.join('\n');
}
