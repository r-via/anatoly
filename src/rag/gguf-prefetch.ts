// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Download GGUF embedding models (advanced tier) into `~/.anatoly/models/`
 * with SHA-256 integrity verification.
 *
 * Fires structured progress events that the CLI layer translates into a
 * progress bar or linear log depending on the environment.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { GGUF_CODE_MODEL_FILE, GGUF_NLP_MODEL_FILE } from './hardware-detect.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured progress event emitted during GGUF model prefetch. */
export type GgufPrefetchProgress =
  | { kind: 'verify'; filename: string; status: 'ok' | 'mismatch' | 'missing' }
  | { kind: 'progress'; filename: string; downloadedMB: number; totalMB: number; percent: number }
  | { kind: 'done'; filename: string }
  | { kind: 'error'; filename: string; error: Error };

export interface GgufPrefetchOptions {
  /** Override models directory (default: `~/.anatoly/models`). Useful for tests. */
  modelsDir?: string;
  /** Called for every progress event. No-op if omitted. */
  onProgress?: (ev: GgufPrefetchProgress) => void;
}

// ---------------------------------------------------------------------------
// GGUF model definitions
// ---------------------------------------------------------------------------

export interface GgufModelDef {
  filename: string;
  hfRepo: string;
  sha256: string;
}

/** The two GGUF models downloaded for the advanced tier. */
export const GGUF_MODELS: readonly GgufModelDef[] = [
  {
    filename: GGUF_CODE_MODEL_FILE,
    hfRepo: 'nomic-ai/nomic-embed-code-GGUF',
    sha256: 'f234c58a5be4c5e89f71e3b7131150a568b9618d32a34ebb625e9c0f6e0be9fb',
  },
  {
    filename: GGUF_NLP_MODEL_FILE,
    hfRepo: 'Qwen/Qwen3-Embedding-8B-GGUF',
    sha256: '022d33b4e2d97ef09a74feb13ef368cb7ca3a610ea2fb3e107199fa72c226e78',
  },
] as const;

/** Default models directory. */
export function defaultModelsDir(): string {
  return resolve(homedir(), '.anatoly', 'models');
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

/**
 * Verify a GGUF file's SHA-256 hash using streaming reads (safe for
 * multi-GB files). If the file exists but the hash doesn't match, the
 * file is deleted so it can be re-downloaded.
 *
 * @returns `true` if the file exists and the hash matches.
 */
export async function verifyGgufFile(filePath: string, expectedSha256: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  const hash = await new Promise<string>((resolve, reject) => {
    const hasher = createHash('sha256');
    const rs = createReadStream(filePath);
    rs.on('data', (chunk: Buffer) => hasher.update(chunk));
    rs.on('end', () => resolve(hasher.digest('hex')));
    rs.on('error', reject);
  });

  if (hash === expectedSha256) return true;

  // Mismatch — delete the corrupt file
  unlinkSync(filePath);
  return false;
}

// ---------------------------------------------------------------------------
// Download a single file
// ---------------------------------------------------------------------------

/**
 * Download a single GGUF file from HuggingFace into `targetPath`.
 * Creates parent directories as needed.
 *
 * @throws on HTTP error or write failure.
 */
export async function downloadGgufFile(
  hfRepo: string,
  filename: string,
  targetPath: string,
  onProgress?: (ev: GgufPrefetchProgress) => void,
): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true });

  const url = `https://huggingface.co/${hfRepo}/resolve/main/${filename}`;
  const resp = await fetch(url, { redirect: 'follow' });

  if (!resp.ok) {
    throw new Error(`GGUF download failed: HTTP ${resp.status} for ${url}`);
  }

  const totalBytes = parseInt(resp.headers.get('content-length') ?? '0', 10);
  const totalMB = totalBytes / (1024 * 1024);
  let downloadedBytes = 0;

  const ws = createWriteStream(targetPath);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body for GGUF download');

  let success = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Write chunk to disk
      await new Promise<void>((resolve, reject) => {
        const canContinue = ws.write(value, (err) => {
          if (err) reject(err);
          else if (canContinue) resolve();
        });
        if (!canContinue) {
          ws.once('drain', resolve);
        }
      });

      downloadedBytes += value.length;
      const downloadedMB = downloadedBytes / (1024 * 1024);
      const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

      onProgress?.({
        kind: 'progress',
        filename,
        downloadedMB: Math.round(downloadedMB * 10) / 10,
        totalMB: Math.round(totalMB * 10) / 10,
        percent: Math.round(percent * 10) / 10,
      });
    }
    success = true;
  } finally {
    await new Promise<void>((resolve) => ws.end(resolve));
    // Remove partial file on failure so it isn't mistaken for a valid download
    if (!success) {
      try { unlinkSync(targetPath); } catch { /* already removed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Prefetch all GGUF models
// ---------------------------------------------------------------------------

/**
 * Download both GGUF embedding models for the advanced tier.
 *
 * - If a model file already exists with a valid SHA-256, it is skipped.
 * - If a model file exists with an invalid SHA-256, it is deleted and re-downloaded.
 * - If the download fails, an error event is emitted but the function
 *   continues with the next model. The caller decides whether to fall back.
 */
export async function prefetchGgufModels(opts?: GgufPrefetchOptions): Promise<void> {
  const modelsDir = opts?.modelsDir ?? defaultModelsDir();
  const emit = opts?.onProgress ?? (() => {});

  mkdirSync(modelsDir, { recursive: true });

  for (const model of GGUF_MODELS) {
    const targetPath = resolve(modelsDir, model.filename);

    // Verify existing file
    if (existsSync(targetPath)) {
      const ok = await verifyGgufFile(targetPath, model.sha256);
      emit({ kind: 'verify', filename: model.filename, status: ok ? 'ok' : 'mismatch' });
      if (ok) {
        emit({ kind: 'done', filename: model.filename });
        continue;
      }
      // File deleted by verifyGgufFile — fall through to download
    } else {
      emit({ kind: 'verify', filename: model.filename, status: 'missing' });
    }

    // Download
    try {
      await downloadGgufFile(model.hfRepo, model.filename, targetPath, emit);

      // Post-download SHA-256 verification (FR7)
      const postOk = await verifyGgufFile(targetPath, model.sha256);
      if (!postOk) {
        emit({
          kind: 'error',
          filename: model.filename,
          error: new Error('Post-download SHA-256 verification failed'),
        });
        continue;
      }

      emit({ kind: 'done', filename: model.filename });
    } catch (err) {
      emit({
        kind: 'error',
        filename: model.filename,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
