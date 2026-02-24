import type { FunctionCard } from './types.js';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

let embedder: any = null;

/**
 * Lazily initialize the embedding pipeline (singleton).
 * The model is downloaded at postinstall; this just loads it from cache.
 */
async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;
  const { pipeline } = await import('@xenova/transformers');
  embedder = await pipeline('feature-extraction', EMBEDDING_MODEL);
  return embedder;
}

/**
 * Generate an embedding vector for the given text.
 * Returns a normalized float32 array of EMBEDDING_DIM dimensions.
 */
export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Generate embeddings for multiple texts in sequence.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

/**
 * Build the text to embed for a FunctionCard.
 * Kept concise to maximize signal on 384 dimensions.
 */
export function buildEmbedText(card: FunctionCard): string {
  return `${card.name} ${card.signature}\n${card.summary}\n${card.keyConcepts.join(' ')}`;
}
