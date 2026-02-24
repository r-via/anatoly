/**
 * Pre-downloads the ONNX embedding model at install time.
 * This avoids a surprise download on first `anatoly run --enable-rag`.
 *
 * If the download fails (e.g. no network), the model will be
 * downloaded lazily on first use instead.
 */
async function main() {
  try {
    const { pipeline } = await import('@xenova/transformers');
    await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('anatoly: embedding model all-MiniLM-L6-v2 downloaded');
  } catch (e) {
    console.warn(
      'anatoly: could not pre-download embedding model (will download on first use):',
      e.message,
    );
  }
}

main();
