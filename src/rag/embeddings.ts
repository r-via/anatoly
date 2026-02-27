export const EMBEDDING_MODEL = 'jinaai/jina-embeddings-v2-base-code';
export const EMBEDDING_DIM = 768;

const MAX_CODE_CHARS = 1500;

let embedder: any = null;
let onLog: (message: string) => void = () => {};

/**
 * Set the log callback for embedding operations.
 * Called during model loading to report progress.
 */
export function setEmbeddingLogger(logger: (message: string) => void): void {
  onLog = logger;
}

/**
 * Lazily initialize the embedding pipeline (singleton).
 * The model is downloaded at postinstall; this just loads it from cache.
 */
async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;
  onLog(`loading embedding model ${EMBEDDING_MODEL}...`);
  const { pipeline } = await import('@xenova/transformers');
  embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
  onLog('embedding model ready');
  return embedder;
}

/**
 * Generate an embedding vector for the given text/code.
 * Returns a normalized float32 array of EMBEDDING_DIM dimensions.
 */
export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

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
