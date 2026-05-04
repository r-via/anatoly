// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Prefetch lite ONNX embedding models into the HuggingFace cache so the
 * first `anatoly run` doesn't surprise users with a download mid-pipeline.
 *
 * Fires structured progress events that the CLI layer translates into a
 * spinner or linear log depending on the environment.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured progress event emitted during model prefetch. */
export type PrefetchProgress =
  | { kind: 'initiate'; modelId: string; file: string }
  | { kind: 'progress'; modelId: string; file: string; percent: number }
  | { kind: 'done'; modelId: string }
  | { kind: 'error'; modelId: string; error: Error };

export interface PrefetchOptions {
  /** Called for every progress event. No-op if omitted. */
  onProgress?: (ev: PrefetchProgress) => void;
}

// ---------------------------------------------------------------------------
// Model IDs
// ---------------------------------------------------------------------------

/** The two lite ONNX model IDs downloaded during prefetch. */
export const LITE_MODEL_IDS = [
  'jinaai/jina-embeddings-v2-base-code',
  'Xenova/all-MiniLM-L6-v2',
] as const;

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

/**
 * Download both lite ONNX embedding models (Jina v2 + MiniLM-L6) into the
 * HuggingFace cache (`~/.cache/huggingface/`).
 *
 * - If models are already cached, `pipeline()` resolves instantly.
 * - On network failure the error is reported via `onProgress` but the
 *   function does **not** throw — the run continues and models will be
 *   retried lazily at embedding time.
 */
export async function prefetchLiteModels(opts?: PrefetchOptions): Promise<void> {
  const emit = opts?.onProgress ?? (() => {});

  for (const modelId of LITE_MODEL_IDS) {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      await pipeline('feature-extraction', modelId, {
        progress_callback: (info: unknown) => {
          const evt = info as { status?: string; file?: string; progress?: number };
          if (!evt.file) return;
          if (evt.status === 'initiate') {
            emit({ kind: 'initiate', modelId, file: evt.file });
          } else if (evt.status === 'progress' && typeof evt.progress === 'number') {
            emit({ kind: 'progress', modelId, file: evt.file, percent: evt.progress });
          }
          // 'done' per-file is noisy; we emit a single 'done' per model below.
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      emit({ kind: 'done', modelId });
    } catch (err) {
      emit({
        kind: 'error',
        modelId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
