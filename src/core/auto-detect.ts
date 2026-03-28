// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Auto-Detect File Discovery — Story 31.4
 *
 * Generates include/exclude glob patterns based on detected languages
 * so that multi-language projects are scanned without manual configuration.
 */

import type { LanguageInfo } from './language-detect.js';

// --- Types ---

export interface AutoDetectResult {
  include: string[];
  exclude: string[];
}

// --- Glob registries ---

/** Include globs per detected language. TypeScript is omitted (handled by default config). */
const LANGUAGE_INCLUDE_GLOBS: Record<string, string[]> = {
  Shell: ['**/*.sh', '**/*.bash'],
  Python: ['**/*.py'],
  YAML: ['**/*.yml', '**/*.yaml'],
  Rust: ['**/*.rs'],
  Go: ['**/*.go'],
  'C#': ['**/*.cs'],
  Java: ['**/*.java'],
  JavaScript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  JSON: ['**/*.json'],
  SQL: ['**/*.sql'],
};

/** Auto-exclude globs per detected language (vendor/build directories). */
const LANGUAGE_EXCLUDE_GLOBS: Record<string, string[]> = {
  Python: ['venv/**', '.venv/**', '__pycache__/**'],
  Rust: ['target/**'],
  'C#': ['bin/**', 'obj/**'],
  Java: ['target/**'],
  JSON: ['package-lock.json', 'node_modules/**/*.json', '**/*.map'],
};

// --- Public API ---

/**
 * Given a list of detected languages, returns include/exclude glob patterns
 * for auto-detecting files of those languages.
 *
 * TypeScript is intentionally excluded — it is already covered by the
 * default `scan.include` configuration.
 *
 * @param languages - Detected languages to generate glob patterns for.
 * @returns Include and exclude glob arrays derived from the language registries.
 */
export function autoDetectGlobs(languages: LanguageInfo[]): AutoDetectResult {
  const includeSet = new Set<string>();
  const excludeSet = new Set<string>();

  for (const lang of languages) {
    const incl = LANGUAGE_INCLUDE_GLOBS[lang.name];
    if (incl) for (const g of incl) includeSet.add(g);
    const excl = LANGUAGE_EXCLUDE_GLOBS[lang.name];
    if (excl) for (const g of excl) excludeSet.add(g);
  }

  return { include: [...includeSet], exclude: [...excludeSet] };
}
