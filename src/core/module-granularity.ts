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
 * - 3+ files > 200 LOC → directory-level (one page for the directory)
 * - 1-2 files > 200 LOC → file-level (one page per qualifying file)
 * - 0 files > 200 LOC → skip (no pages)
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

  return pages;
}

/** Convert a PascalCase or camelCase string to kebab-case. */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
