/**
 * Pre-downloads the ONNX embedding model at install time.
 * This avoids a surprise download on first `anatoly run`.
 *
 * If the download fails (e.g. no network), the model will be
 * downloaded lazily on first use instead.
 */
async function main() {
  if (process.env.ANATOLY_SKIP_DOWNLOAD === '1') {
    console.log('anatoly: skipping model download (ANATOLY_SKIP_DOWNLOAD=1)');
    return;
  }
  try {
    console.log('anatoly: downloading embedding model all-MiniLM-L6-v2...');
    const { pipeline, env } = await import('@xenova/transformers');
    const cacheDir = env.cacheDir || '~/.cache/huggingface';
    await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log(`anatoly: model ready (cache: ${cacheDir})`);
  } catch (e) {
    console.warn(
      'anatoly: could not pre-download embedding model (will download on first use):',
      e.message,
    );
  }
}

main();
