import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Progress } from '../schemas/progress.js';

/**
 * Compute SHA-256 hash of a file's content.
 */
export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a string.
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmpPath, filePath);
}

/**
 * Read progress.json if it exists, return null otherwise.
 */
export function readProgress(progressPath: string): Progress | null {
  try {
    const content = readFileSync(progressPath, 'utf-8');
    return JSON.parse(content) as Progress;
  } catch {
    return null;
  }
}
