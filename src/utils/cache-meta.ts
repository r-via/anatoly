// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheMeta {
  schema: number;
  prompt_hash: string; // 'sha256:...'
  model_id: string;
  created_at: string; // ISO-8601 UTC
  anatoly_version: string;
}

export interface CacheFile<T> {
  _meta: CacheMeta;
  data: T;
}

// ---------------------------------------------------------------------------
// Version helper
// ---------------------------------------------------------------------------

let _version: string | undefined;

function getAnatolyVersion(): string {
  if (_version) return _version;
  try {
    // Read version from package.json at build time isn't available via import.meta,
    // so we read it lazily from the closest package.json.
    const pkgPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    _version = pkg.version ?? 'unknown';
  } catch {
    _version = 'unknown';
  }
  return _version!;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Strip trailing whitespace from each line. */
function normalize(text: string): string {
  return text.replace(/[^\S\n]+$/gm, '');
}

// ---------------------------------------------------------------------------
// computePromptHash
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash over schema version, model ID, system prompt,
 * and user template. Trailing whitespace per line is normalised away so that
 * insignificant formatting changes don't bust the cache.
 */
export function computePromptHash(args: {
  schemaVersion: number;
  modelId: string;
  systemPrompt: string;
  userTemplate: string;
}): string {
  const h = createHash('sha256');
  h.update(String(args.schemaVersion));
  h.update('\0');
  h.update(args.modelId);
  h.update('\0');
  h.update(normalize(args.systemPrompt));
  h.update('\0');
  h.update(normalize(args.userTemplate));
  return `sha256:${h.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// loadCacheWithMeta
// ---------------------------------------------------------------------------

/**
 * Load a cache file and validate its `_meta` header against expected schema
 * and prompt hash. Returns `data` on hit, `null` on any miss (file missing,
 * corrupt JSON, schema mismatch, hash mismatch). Never throws.
 */
export function loadCacheWithMeta<T>(
  path: string,
  expected: { schema: number; promptHash: string },
): T | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile<T>;

    if (!parsed._meta) return null;
    if (parsed._meta.schema !== expected.schema) return null;
    if (parsed._meta.prompt_hash !== expected.promptHash) return null;

    return parsed.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// writeCacheWithMeta
// ---------------------------------------------------------------------------

/**
 * Atomically write a cache file with `_meta` header. Creates parent
 * directories if they don't exist.
 */
export function writeCacheWithMeta<T>(
  path: string,
  data: T,
  meta: Omit<CacheMeta, 'created_at' | 'anatoly_version'>,
): void {
  const fullMeta: CacheMeta = {
    ...meta,
    created_at: new Date().toISOString(),
    anatoly_version: getAnatolyVersion(),
  };

  const payload: CacheFile<T> = { _meta: fullMeta, data };
  const content = JSON.stringify(payload, null, 2);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}
