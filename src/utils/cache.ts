// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProgressSchema } from '../schemas/progress.js';
import type { Progress } from '../schemas/progress.js';

/**
 * Normalise content for hashing: convert all line-ending variants to `\n`.
 * Ensures cross-platform parity (Windows CRLF / old-Mac CR / Unix LF).
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Compute SHA-256 hash of a file's content with line-ending normalisation.
 * Files with CRLF vs LF produce identical hashes.
 */
export function computeFileHash(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(normalizeLineEndings(raw)).digest('hex');
}

/**
 * Compute SHA-256 hash of a string content with line-ending normalisation.
 * Used for content-addressable cache keys (shared reviews, NLP summaries).
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeLineEndings(content)).digest('hex');
}

/**
 * Convert a source file path to the output filename convention.
 * Example: "src/utils/format.ts" → "src-utils-format"
 */
export function toOutputName(filePath: string): string {
  return filePath
    .replace(/\.[^.]+$/, '') // Remove extension
    .replace(/[/\\]/g, '-'); // Slashes → dashes
}

/**
 * Atomically write a JSON file (tmp + rename) to prevent corruption.
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
