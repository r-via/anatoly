// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { MODEL_REGISTRY, GGUF_CODE_PORT, GGUF_NLP_PORT, type ResolvedModels } from './hardware-detect.js';
import { ensureModel } from './docker-gguf.js';

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
let codeRuntime: 'onnx' | 'gguf' = 'onnx';
let nlpRuntime: 'onnx' | 'gguf' = 'onnx';
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
  onnxFallbackPromise = null;
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

// ---------------------------------------------------------------------------
// GGUF Docker embedding via HTTP API (llama.cpp server-cuda)
// ---------------------------------------------------------------------------

const MAX_GGUF_CHARS = 8000;

async function embedViaGguf(text: string, port: number, retries = 2): Promise<number[]> {
  // Truncate to avoid OOM in llama.cpp container
  if (text.length > MAX_GGUF_CHARS) {
    text = text.slice(0, MAX_GGUF_CHARS);
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
      });

      if (!res.ok) {
        throw new Error(`GGUF container failed (${res.status}): ${await res.text()}`);
      }

      const data = await res.json() as unknown;

      // llama.cpp returns: [{index: 0, embedding: [[...floats...]]}]
      if (Array.isArray(data) && data[0]?.embedding) {
        const emb = data[0].embedding;
        // embedding is [[...floats...]] (nested) or [...floats...]
        return Array.isArray(emb[0]) ? emb[0] : emb;
      }
      // Older format: {results: [{embedding: [...]}]}
      const obj = data as { results?: Array<{ embedding: number[][] | number[] }>; embedding?: number[][] | number[] };
      if (obj.results?.[0]?.embedding) {
        const emb = obj.results[0].embedding;
        return Array.isArray(emb[0]) ? emb[0] as number[] : emb as number[];
      }
      if (obj.embedding) {
        const emb = obj.embedding;
        return Array.isArray(emb[0]) ? emb[0] as number[] : emb as number[];
      }
      throw new Error('GGUF container returned unexpected response format');
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('embedViaGguf: unreachable');
}

/**
 * Embed multiple texts in a single HTTP request to GGUF (llama.cpp batch API).
 * Returns one embedding vector per input text. Same quality as single requests
 * but reduces HTTP overhead from N requests to 1.
 */
async function embedBatchViaGguf(texts: string[], port: number, retries = 2): Promise<number[][]> {
  const truncated = texts.map((t) => t.length > MAX_GGUF_CHARS ? t.slice(0, MAX_GGUF_CHARS) : t);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: truncated }),
      });

      if (!res.ok) {
        throw new Error(`GGUF container failed (${res.status}): ${await res.text()}`);
      }

      const data = await res.json() as unknown;

      // llama.cpp returns: [{index: 0, embedding: [[...]]}, {index: 1, embedding: [[...]]}]
      if (Array.isArray(data)) {
        // Sort by index to ensure correct order
        const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return sorted.map((item) => {
          const emb = item.embedding;
          return Array.isArray(emb[0]) ? emb[0] : emb;
        });
      }
      throw new Error('GGUF batch returned unexpected response format');
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('embedBatchViaGguf: unreachable');
}

/**
 * Embed multiple code texts in a single batch request.
 * Falls back to sequential embedCode() for ONNX runtime.
 */
export async function embedCodeBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (codeRuntime === 'gguf') {
    await ensureModel('code');
    return embedBatchViaGguf(texts, GGUF_CODE_PORT);
  }
  // ONNX fallback: sequential
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedViaOnnx(text));
  }
  return results;
}

/**
 * Embed multiple NLP texts in a single batch request.
 * Falls back to sequential embedNlp() for ONNX runtime.
 */
export async function embedNlpBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (nlpRuntime === 'gguf') {
    await ensureModel('nlp');
    return embedBatchViaGguf(texts, GGUF_NLP_PORT);
  }
  // ONNX fallback: sequential
  const results: number[][] = [];
  for (const text of texts) {
    const model = await getNlpEmbedder();
    const output = await model(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }
  return results;
}

/**
 * Generate a code embedding vector for the given text.
 * Routes to GGUF Docker or ONNX based on configured runtime.
 */
export async function embedCode(text: string): Promise<number[]> {
  if (codeRuntime === 'gguf') {
    await ensureModel('code');
    return embedViaGguf(text, GGUF_CODE_PORT);
  }
  return embedViaOnnx(text);
}

/**
 * Generate an NLP embedding vector for the given text.
 * Routes to GGUF Docker or ONNX based on configured runtime.
 */
export async function embedNlp(text: string): Promise<number[]> {
  if (nlpRuntime === 'gguf') {
    await ensureModel('nlp');
    return embedViaGguf(text, GGUF_NLP_PORT);
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
