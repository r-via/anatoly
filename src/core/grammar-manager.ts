// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Dynamic Grammar Manager — Story 31.5
 *
 * Downloads and caches tree-sitter WASM grammars on first use so the npm
 * package stays lightweight. TypeScript/TSX grammars are bundled and never
 * go through this manager.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// --- Types ---

export interface GrammarRegistryEntry {
  npmPackage: string;
  wasmFile: string;
  version: string;
}

interface ManifestEntry {
  version: string;
  sha256: string;
  downloadedAt: string;
}

export interface GrammarStats {
  cached: number;
  downloaded: string[];
}

/**
 * Handle for resolving tree-sitter WASM grammars by language identifier.
 *
 * Use {@link createGrammarManager} to obtain an instance. The `resolve` method
 * returns the absolute filesystem path to the cached `.wasm` file, downloading
 * it on first access, or `null` if the language is not in the registry or the
 * download fails.
 */
export interface GrammarManager {
  resolve(languageId: string): Promise<string | null>;
  stats(): GrammarStats;
}

// --- Registry ---

/** Tier 1 language grammars — downloaded on demand from jsdelivr CDN. */
export const GRAMMAR_REGISTRY: Record<string, GrammarRegistryEntry> = {
  bash: { npmPackage: 'tree-sitter-bash', wasmFile: 'tree-sitter-bash.wasm', version: '0.23.3' },
  python: { npmPackage: 'tree-sitter-python', wasmFile: 'tree-sitter-python.wasm', version: '0.23.4' },
  rust: { npmPackage: 'tree-sitter-rust', wasmFile: 'tree-sitter-rust.wasm', version: '0.23.2' },
  go: { npmPackage: 'tree-sitter-go', wasmFile: 'tree-sitter-go.wasm', version: '0.23.4' },
  java: { npmPackage: 'tree-sitter-java', wasmFile: 'tree-sitter-java.wasm', version: '0.23.4' },
  csharp: { npmPackage: 'tree-sitter-c-sharp', wasmFile: 'tree-sitter-c_sharp.wasm', version: '0.23.3' },
  sql: { npmPackage: 'tree-sitter-sql', wasmFile: 'tree-sitter-sql.wasm', version: '0.3.6' },
  yaml: { npmPackage: 'tree-sitter-yaml', wasmFile: 'tree-sitter-yaml.wasm', version: '0.6.1' },
  json: { npmPackage: 'tree-sitter-json', wasmFile: 'tree-sitter-json.wasm', version: '0.24.8' },
};

const GRAMMARS_DIR = '.anatoly/grammars';

// --- Helpers ---

function loadManifest(path: string): Record<string, ManifestEntry> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

// --- Public API ---

/**
 * Creates a {@link GrammarManager} that lazily downloads and caches tree-sitter
 * WASM grammars under `<projectRoot>/.anatoly/grammars/`.
 *
 * On first call to `resolve(languageId)`, the grammar is fetched from the
 * jsdelivr CDN and written to disk alongside an integrity manifest. Subsequent
 * calls return the cached path without a network request.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param fetcher - Optional HTTP fetcher function used to download WASM files.
 *   Defaults to Node's global `fetch()`. Inject a custom implementation for
 *   testing or to route through a proxy.
 * @returns A {@link GrammarManager} instance with `resolve` and `stats` methods.
 */
export function createGrammarManager(
  projectRoot: string,
  fetcher?: (url: string) => Promise<Buffer | null>,
): GrammarManager {
  const grammarsDir = join(projectRoot, GRAMMARS_DIR);
  const manifestPath = join(grammarsDir, 'manifest.json');
  const tracked = { cached: 0, downloaded: [] as string[] };

  async function resolve(languageId: string): Promise<string | null> {
    const entry = GRAMMAR_REGISTRY[languageId];
    if (!entry) return null;

    const wasmPath = join(grammarsDir, entry.wasmFile);

    // Check cache
    if (existsSync(wasmPath)) {
      tracked.cached++;
      return wasmPath;
    }

    // Download from CDN
    const url = `https://cdn.jsdelivr.net/npm/${entry.npmPackage}@${entry.version}/${entry.wasmFile}`;

    try {
      mkdirSync(grammarsDir, { recursive: true });
      const effectiveFetcher = fetcher ?? defaultFetcher;
      const buffer = await effectiveFetcher(url);
      if (!buffer) return null;

      writeFileSync(wasmPath, buffer);

      // Compute integrity hash and update manifest
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const manifest = loadManifest(manifestPath);
      manifest[languageId] = {
        version: entry.version,
        sha256,
        downloadedAt: new Date().toISOString().split('T')[0],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      tracked.downloaded.push(entry.wasmFile);
      return wasmPath;
    } catch {
      // Clean up partial download
      if (existsSync(wasmPath)) {
        try { unlinkSync(wasmPath); } catch { /* best-effort cleanup */ }
      }
      return null;
    }
  }

  return {
    resolve,
    stats: () => ({ cached: tracked.cached, downloaded: [...tracked.downloaded] }),
  };
}

/** Default fetcher using Node's global fetch(). */
async function defaultFetcher(url: string): Promise<Buffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
