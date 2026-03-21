// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Language Detection by Extension Distribution — Story 31.1
 *
 * Detects programming languages present in a project by scanning
 * file extensions of git-tracked files.
 */

import { extname, basename } from 'node:path';
import { getGitTrackedFiles } from '../utils/git.js';

// --- Types ---

export interface LanguageInfo {
  name: string;
  percentage: number;
  fileCount: number;
}

export interface LanguageDistribution {
  languages: LanguageInfo[];
  totalFiles: number;
}

// --- Constants ---

/** Maps file extensions to canonical language names. */
export const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.cs': 'C#',
  '.sql': 'SQL',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.json': 'JSON',
};

/** Maps specific filenames (no extension) to language names. */
export const FILENAME_MAP: Record<string, string> = {
  Dockerfile: 'Docker',
  Makefile: 'Makefile',
  Jenkinsfile: 'Groovy',
};

/** Standard vendor/build directories excluded from language detection. */
export const DEFAULT_EXCLUDES: string[] = [
  'node_modules/',
  'dist/',
  'venv/',
  '.venv/',
  '__pycache__/',
  'target/',
  'bin/',
  'obj/',
];

// --- Public API ---

/**
 * Classify a file path to its programming language.
 * Returns null if the language is not recognized.
 */
export function classifyFile(filePath: string): string | null {
  const ext = extname(filePath);
  if (ext && EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }
  const name = basename(filePath);
  return FILENAME_MAP[name] ?? null;
}

/**
 * Build a language distribution from a list of file paths.
 * Filters out languages below 1% of total files.
 */
export function buildDistribution(files: string[]): LanguageDistribution {
  const counts = new Map<string, number>();
  for (const file of files) {
    const lang = classifyFile(file);
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }

  const rawTotal = Array.from(counts.values()).reduce((sum, c) => sum + c, 0);
  if (rawTotal === 0) {
    return { languages: [], totalFiles: 0 };
  }

  // Filter out languages below 1% threshold (raw percentage before rounding)
  const filtered = Array.from(counts.entries()).filter(
    ([, count]) => count / rawTotal >= 0.01,
  );

  // Recalculate totalFiles from remaining languages
  const totalFiles = filtered.reduce((sum, [, count]) => sum + count, 0);

  const languages: LanguageInfo[] = filtered
    .map(([name, fileCount]) => ({
      name,
      percentage: Math.round((fileCount / totalFiles) * 100),
      fileCount,
    }))
    .sort((a, b) => b.percentage - a.percentage || a.name.localeCompare(b.name));

  return { languages, totalFiles };
}

/**
 * Detect programming languages in a project by scanning git-tracked file extensions.
 * Excludes standard vendor/build directories.
 */
export function detectLanguages(
  projectRoot: string,
  excludes?: string[],
): LanguageDistribution {
  const gitFiles = getGitTrackedFiles(projectRoot);
  if (!gitFiles) {
    return { languages: [], totalFiles: 0 };
  }

  const allExcludes = [...DEFAULT_EXCLUDES, ...(excludes ?? [])];
  const filteredFiles = Array.from(gitFiles).filter(
    (filePath) => !isExcluded(filePath, allExcludes),
  );

  return buildDistribution(filteredFiles);
}

// --- Internal helpers ---

function isExcluded(filePath: string, excludes: string[]): boolean {
  const segments = filePath.split('/');
  return excludes.some((excl) => {
    const dir = excl.endsWith('/') ? excl.slice(0, -1) : excl;
    return segments.includes(dir);
  });
}
