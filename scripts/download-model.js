/**
 * Pre-downloads the ONNX embedding models at install time.
 * This avoids a surprise download on first `anatoly run`.
 *
 * Downloads both the code embedding model (Jina) and the NLP
 * embedding model (MiniLM) used in dual-embedding mode.
 *
 * If the download fails (e.g. no network), the models will be
 * downloaded lazily on first use instead.
 */
async function main() {
  if (process.env.ANATOLY_SKIP_DOWNLOAD === '1') {
    console.log('anatoly: skipping model download (ANATOLY_SKIP_DOWNLOAD=1)');
    return;
  }

  // Keep in sync with defaults in src/rag/embeddings.ts
  const models = [
    'jinaai/jina-embeddings-v2-base-code',
    'Xenova/all-MiniLM-L6-v2',
  ];

  try {
    const { pipeline, env } = await import('@xenova/transformers');
    const cacheDir = env.cacheDir || '~/.cache/huggingface';

    for (const model of models) {
      console.log(`anatoly: downloading embedding model ${model}...`);
      await pipeline('feature-extraction', model);
      console.log(`anatoly: model ready: ${model} (cache: ${cacheDir})`);
    }
  } catch (e) {
    console.warn(
      'anatoly: could not pre-download embedding models (will download on first use):',
      e.message,
    );
  }
}

main();
