import { MODEL_REGISTRY, getOllamaHost, type ResolvedModels } from './hardware-detect.js';

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
let codeRuntime: 'onnx' | 'ollama' = 'onnx';
let nlpRuntime: 'onnx' | 'ollama' = 'onnx';
let codeDim = MODEL_REGISTRY[DEFAULT_CODE_MODEL]?.dim ?? 768;
let nlpDim = MODEL_REGISTRY[DEFAULT_NLP_MODEL]?.dim ?? 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let codeEmbedderPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nlpEmbedderPromise: Promise<any> | null = null;

let onLog: (message: string) => void = () => {};

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
// Ollama embedding via HTTP API
// ---------------------------------------------------------------------------

async function embedViaOllama(model: string, text: string): Promise<number[]> {
  const host = getOllamaHost();
  const res = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings[0];
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
 * Routes to Ollama or ONNX based on the configured runtime.
 */
export async function embedCode(text: string): Promise<number[]> {
  if (codeRuntime === 'ollama') {
    return embedViaOllama(codeModelId, text);
  }
  const model = await getCodeEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Generate an NLP embedding vector for the given text.
 * Routes to Ollama or ONNX based on the configured runtime.
 */
export async function embedNlp(text: string): Promise<number[]> {
  if (nlpRuntime === 'ollama') {
    return embedViaOllama(nlpModelId, text);
  }
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
