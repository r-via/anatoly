// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { embed as aiEmbed, embedMany as aiEmbedMany } from 'ai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { MODEL_REGISTRY, type ResolvedModels } from './hardware-detect.js';
import { getVercelEmbeddingModel } from './sdk-embedding.js';

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
let codeRuntime: 'onnx' | 'sdk' = 'onnx';
let nlpRuntime: 'onnx' | 'sdk' = 'onnx';
let codeDim = MODEL_REGISTRY[DEFAULT_CODE_MODEL]?.dim ?? 768;
let nlpDim = MODEL_REGISTRY[DEFAULT_NLP_MODEL]?.dim ?? 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let codeEmbedderPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nlpEmbedderPromise: Promise<any> | null = null;

// SDK model instances (populated by configureModels when runtime is 'sdk')
let codeSdkModel: EmbeddingModelV3 | null = null;
let nlpSdkModel: EmbeddingModelV3 | null = null;

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
  codeRuntime = resolved.codeRuntime === 'gguf' ? 'sdk' : resolved.codeRuntime;
  nlpRuntime = resolved.nlpRuntime === 'gguf' ? 'sdk' : resolved.nlpRuntime;
  codeDim = resolved.codeDim;
  nlpDim = resolved.nlpDim;

  // Reset cached embedders
  codeEmbedderPromise = null;
  nlpEmbedderPromise = null;
  onnxFallbackPromise = null;
  codeSdkModel = null;
  nlpSdkModel = null;

  // Instantiate SDK models when runtime is 'sdk'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (resolved as any)._config;
  if (codeRuntime === 'sdk' && config) {
    codeSdkModel = getVercelEmbeddingModel('code', codeModelId, config);
  }
  if (nlpRuntime === 'sdk' && config) {
    nlpSdkModel = getVercelEmbeddingModel('nlp', nlpModelId, config);
  }
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
  onLog(`loading ONNX embedding model ${modelId} (first time: ~50-150 MB download from HuggingFace, cached locally afterwards)...`);
  const { pipeline } = await import('@huggingface/transformers');

  // Throttle per-file progress so we surface the download without flooding logs.
  const lastBucket = new Map<string, number>();

  const model = await pipeline('feature-extraction', modelId, {
    progress_callback: (info: unknown) => {
      const evt = info as { status?: string; file?: string; progress?: number };
      if (!evt.file) return;
      if (evt.status === 'initiate') {
        onLog(`  ↓ ${evt.file} (starting…)`);
      } else if (evt.status === 'progress' && typeof evt.progress === 'number') {
        const bucket = Math.floor(evt.progress / 10) * 10;
        if (bucket > 0 && bucket < 100 && (lastBucket.get(evt.file) ?? -1) < bucket) {
          lastBucket.set(evt.file, bucket);
          onLog(`  ↓ ${evt.file}: ${bucket}%`);
        }
      } else if (evt.status === 'done') {
        onLog(`  ✓ ${evt.file}`);
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
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
// SDK embedding helpers (Vercel AI SDK)
// ---------------------------------------------------------------------------

/**
 * Embed a single text via the Vercel AI SDK.
 */
async function embedViaSdk(text: string, model: EmbeddingModelV3): Promise<number[]> {
  const { embedding } = await aiEmbed({ model, value: text });
  return embedding;
}

/**
 * Embed multiple texts via the Vercel AI SDK.
 */
async function embedBatchViaSdk(texts: string[], model: EmbeddingModelV3): Promise<number[][]> {
  const { embeddings } = await aiEmbedMany({ model, values: texts });
  return embeddings;
}

// ---------------------------------------------------------------------------
// Embedding functions
// ---------------------------------------------------------------------------

/**
 * Embed multiple code texts in a single batch request.
 * Uses SDK embedMany for 'sdk' runtime, sequential ONNX for 'onnx'.
 */
export async function embedCodeBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (codeRuntime === 'sdk' && codeSdkModel) {
    return embedBatchViaSdk(texts, codeSdkModel);
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
 * Uses SDK embedMany for 'sdk' runtime, sequential ONNX for 'onnx'.
 */
export async function embedNlpBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (nlpRuntime === 'sdk' && nlpSdkModel) {
    return embedBatchViaSdk(texts, nlpSdkModel);
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
 * Routes to SDK or ONNX based on configured runtime.
 */
export async function embedCode(text: string): Promise<number[]> {
  if (codeRuntime === 'sdk' && codeSdkModel) {
    return embedViaSdk(text, codeSdkModel);
  }
  return embedViaOnnx(text);
}

/**
 * Generate an NLP embedding vector for the given text.
 * Routes to SDK or ONNX based on configured runtime.
 */
export async function embedNlp(text: string): Promise<number[]> {
  if (nlpRuntime === 'sdk' && nlpSdkModel) {
    return embedViaSdk(text, nlpSdkModel);
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
