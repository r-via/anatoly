// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProgressSchema } from '../schemas/progress.js';
import type { Progress } from '../schemas/progress.js';

/**
 * Compute SHA-256 hash of a file's content.
 *
 * @param filePath - Absolute or relative path to the file to hash.
 * @returns A 64-character lowercase hex-encoded SHA-256 digest string.
 */
export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Convert a source file path to the output filename convention.
 * Example: "src/utils/format.ts" → "src-utils-format"
 *
 * @param filePath - Source file path (forward or backslash separators).
 * @returns The path with its extension stripped and separators replaced by dashes.
 */
export function toOutputName(filePath: string): string {
  return filePath
    .replace(/\.[^.]+$/, '') // Remove extension
    .replace(/[/\\]/g, '-'); // Slashes → dashes
}

/**
 * Atomically write a JSON file (tmp + rename) to prevent corruption.
 * Creates parent directories if they do not exist.
 *
 * @param filePath - Destination path for the JSON file.
 * @param data - Value to serialize via `JSON.stringify`.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already renamed or cleaned */ }
  }
}

/**
 * Read progress.json if it exists, return null otherwise.
 * Returns null on missing file, malformed JSON, or schema validation failure.
 *
 * @param progressPath - Absolute path to the progress JSON file.
 * @returns Parsed and validated {@link Progress} object, or `null` on any failure.
 */
export function readProgress(progressPath: string): Progress | null {
  try {
    const content = readFileSync(progressPath, 'utf-8');
    const result = ProgressSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
