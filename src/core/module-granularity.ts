// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Module Granularity Resolution — Story 29.4
 *
 * Determines whether to create file-level or directory-level doc pages
 * for the 05-Modules/ section based on LOC counts per source directory.
 *
 * Rules (from typescript-documentation.md):
 * - 3+ files >= 200 LOC → directory-level (one page for the directory)
 * - 1-2 files >= 200 LOC → file-level (one page per qualifying file)
 * - 0 files >= 200 LOC → skip (no pages)
 */

const LOC_THRESHOLD = 200;
const DIR_LEVEL_FILE_COUNT = 3;

export interface FileInfo {
  name: string;
  loc: number;
}

export interface ModuleDir {
  name: string;
  files: FileInfo[];
}

export interface ModulePage {
  path: string;
  title: string;
  description: string;
  section: string;
  hint: string;
}

/**
 * Resolves which 05-Modules/ pages to create based on LOC granularity rules.
 *
 * Applies three granularity tiers per directory:
 * - 0 files >= 200 LOC → skip (no pages emitted)
 * - 1–2 files >= 200 LOC → file-level (one page per qualifying file)
 * - 3+ files >= 200 LOC → directory-level (single page for the directory)
 *
 * Pages are sorted alphabetically by path and assigned zero-padded numeric
 * prefixes (01-, 02-, ...) for deterministic ordering in the output section.
 *
 * @param modules - Source directories with their file LOC counts.
 * @returns Sorted array of `ModulePage` entries with numbered path prefixes.
 */
export function resolveModuleGranularity(modules: ModuleDir[]): ModulePage[] {
  const pages: ModulePage[] = [];

  for (const mod of modules) {
    const qualifying = mod.files.filter(f => f.loc >= LOC_THRESHOLD);

    if (qualifying.length === 0) {
      continue;
    }

    if (qualifying.length >= DIR_LEVEL_FILE_COUNT) {
      // Directory-level: single page for the entire module
      pages.push({
        path: `05-Modules/${toKebabCase(mod.name)}.md`,
        title: mod.name,
        description: `Module ${mod.name} — ${qualifying.length} files, directory-level reference`,
        section: 'Modules',
        hint: `Document the ${mod.name} module: its purpose, key exports, and internal architecture.\n     Cover the main files and how they interact.`,
      });
    } else {
      // File-level: one page per qualifying file
      for (const file of qualifying) {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const kebab = toKebabCase(baseName);
        pages.push({
          path: `05-Modules/${kebab}.md`,
          title: baseName,
          description: `${baseName} — ${file.loc} LOC, file-level reference`,
          section: 'Modules',
          hint: `Document the ${baseName} module: its exports, parameters, and usage examples.\n     Include at least one code example.`,
        });
      }
    }
  }

  // Sort alphabetically and assign numbered prefixes (01-, 02-, ...)
  pages.sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 0; i < pages.length; i++) {
    const prefix = String(i + 1).padStart(2, '0');
    const filename = pages[i].path.split('/').pop()!;
    pages[i].path = `05-Modules/${prefix}-${filename}`;
  }

  return pages;
}

/**
 * Extract a module/directory name from a task file path.
 *
 * Handles two common layouts:
 * - Standard: `src/core/file.ts`  → `"core"` (first dir after `src/`)
 * - Workspace: `crate-name/src/file.rs` → `"crate-name"` (dir before `src/`)
 *
 * Returns `null` when no meaningful module directory can be determined
 * (e.g. files directly in `src/` with no parent crate directory).
 */
export function extractModuleName(filePath: string): string | null {
  const parts = filePath.split('/');
  const srcIdx = parts.indexOf('src');

  if (srcIdx >= 0) {
    // Standard layout: src/<module>/file.ext → return <module>
    const afterSrc = srcIdx + 1;
    if (afterSrc < parts.length - 1) {
      return parts[afterSrc];
    }
    // Workspace layout: <crate>/src/file.ext → return <crate>
    if (srcIdx > 0) {
      return parts[srcIdx - 1];
    }
    // File directly in src/ (e.g. src/main.rs) — no meaningful module
    return null;
  }

  // No src/ found — use first directory if deep enough (e.g. lib/utils/file.ts → "lib")
  if (parts.length >= 3) {
    return parts[0];
  }

  return null;
}

/** Convert a PascalCase or camelCase string to kebab-case. */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
