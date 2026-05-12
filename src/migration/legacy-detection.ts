// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Detect legacy `.anatoly/` layout from pre-Epic-52 versions and generate
 * shell commands for the user to run to migrate to the new layout.
 *
 * Legacy paths checked:
 *   - <root>/.anatoly/pricing.json         (→ cache/pricing.json)
 *   - <root>/.anatoly/sources/             (→ shared/pricing/sources/)
 *   - <root>/.anatoly/grammars/            (→ shared/grammars/)
 *   - <root>/.anatoly/cache/refinement-cache.json (→ cache/refinements/)
 *   - <root>/.anatoly/correction-memory.json      (removed)
 *   - ~/.cache/anatoly/wasm/               (removed)
 *   - ~/.anatoly/models/*.gguf             (→ shared/models/gguf/)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LegacyLayoutResult {
  /** Whether any legacy paths were found. */
  detected: boolean;
  /** List of legacy paths that exist. */
  paths: string[];
  /** Shell commands to run for migration (only if detected). */
  instructions?: string;
}

export interface DetectLegacyOptions {
  /** Override home directory for testing. */
  home?: string;
}

/**
 * Check for the existence of legacy `.anatoly/` layout paths.
 *
 * @param root - Project root directory.
 * @param opts - Options (e.g. home override for testing).
 * @returns Detection result with paths found and migration instructions.
 */
export function detectLegacyLayout(root: string, opts?: DetectLegacyOptions): LegacyLayoutResult {
  const paths: string[] = [];
  const home = opts?.home ?? homedir();

  // Project-level legacy paths
  const projectLegacy = [
    join(root, '.anatoly', 'pricing.json'),
    join(root, '.anatoly', 'sources'),
    join(root, '.anatoly', 'grammars'),
    join(root, '.anatoly', 'cache', 'refinement-cache.json'),
    join(root, '.anatoly', 'correction-memory.json'),
  ];

  for (const p of projectLegacy) {
    if (existsSync(p)) paths.push(p);
  }

  // User-wide legacy paths
  const wasmCache = join(home, '.cache', 'anatoly', 'wasm');
  if (existsSync(wasmCache)) paths.push(wasmCache);

  // Legacy GGUF models at ~/.anatoly/models/*.gguf (not under shared/)
  const legacyModels = join(home, '.anatoly', 'models');
  if (existsSync(legacyModels)) {
    try {
      const ggufFiles = readdirSync(legacyModels).filter((f) => f.endsWith('.gguf'));
      if (ggufFiles.length > 0) {
        paths.push(legacyModels);
      }
    } catch {
      // permission denied or other error — skip
    }
  }

  if (paths.length === 0) {
    return { detected: false, paths };
  }

  return {
    detected: true,
    paths,
    instructions: generateMigrationInstructions(root, paths, home),
  };
}

/**
 * Generate human-readable shell commands to migrate from legacy layout.
 */
function generateMigrationInstructions(root: string, paths: string[], home: string): string {
  const lines: string[] = [];

  lines.push('# ─── Anatoly: legacy layout detected ───');
  lines.push('# Run these commands to migrate to the new shared layout:');
  lines.push('');

  // Required: remove obsolete cache files
  lines.push('# Required: remove obsolete cache files');

  const hasProjectCache = paths.some(
    (p) => p.includes(join('.anatoly', 'cache')) || p.includes(join('.anatoly', 'pricing.json')),
  );
  const hasSources = paths.some((p) => p.includes(join('.anatoly', 'sources')));
  const hasGrammars = paths.some((p) => p.includes(join('.anatoly', 'grammars')));
  const hasCorrectionMemory = paths.some((p) => p.includes('correction-memory.json'));
  const hasWasmCache = paths.some((p) => p.includes(join('.cache', 'anatoly', 'wasm')));
  const hasLegacyModels = paths.some((p) => p === join(home, '.anatoly', 'models'));

  const rmDirs: string[] = [];
  const rmFiles: string[] = [];

  if (hasProjectCache) rmDirs.push(`${root}/.anatoly/cache`);
  if (hasSources) rmDirs.push(`${root}/.anatoly/sources`);
  if (hasGrammars) rmDirs.push(`${root}/.anatoly/grammars`);
  if (rmDirs.length > 0) lines.push(`rm -rf ${rmDirs.join(' ')}`);

  if (hasProjectCache) rmFiles.push(`${root}/.anatoly/pricing.json`);
  if (hasCorrectionMemory) rmFiles.push(`${root}/.anatoly/correction-memory.json`);
  if (rmFiles.length > 0) lines.push(`rm -f ${rmFiles.join(' ')}`);

  if (hasWasmCache) lines.push(`rm -rf ~/.cache/anatoly/wasm`);

  // Optional: preserve big artifacts
  if (hasLegacyModels) {
    lines.push('');
    lines.push('# Optional: preserve big artifacts (saves re-download)');
    lines.push('mkdir -p ~/.anatoly/shared/models/{gguf,hf-cache}');
    lines.push('mv ~/.anatoly/models/*.gguf ~/.anatoly/shared/models/gguf/ 2>/dev/null || true');
    lines.push('rmdir ~/.anatoly/models 2>/dev/null || true');
  }

  // Optional: preserve human-validated state
  lines.push('');
  lines.push('# Optional: preserve human-validated state');
  lines.push(`mkdir -p ${root}/.anatoly/state`);
  lines.push(
    `mv ${root}/.anatoly/deliberation-memory.json ${root}/.anatoly/state/ 2>/dev/null || true`,
  );
  lines.push(
    `mv ${root}/.anatoly/calibration.json ${root}/.anatoly/state/ 2>/dev/null || true`,
  );
  lines.push('');
  lines.push('# Then re-run anatoly. Bootstrap will recreate ~/.anatoly/ structure and symlinks automatically.');

  return lines.join('\n');
}
