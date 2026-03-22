// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Code → Documentation Mapping — Story 29.5
 *
 * Maps source directories to documentation pages using a fallback strategy:
 * 1. Convention matching (known directory names)
 * 2. Synonym matching (directory name synonyms)
 * 3. Framework detection (file content patterns)
 * 4. Catch-all (05-Modules/{dir-name}.md)
 *
 * Directories with < 200 LOC total are skipped.
 */

const LOC_THRESHOLD = 200;

export interface SourceDir {
  name: string;
  totalLoc: number;
  filePatterns?: string[];
}

export interface DocMapping {
  sourceDir: string;
  docPage: string;
  strategy: 'convention' | 'synonym' | 'framework' | 'catch-all';
}

// --- Convention table: known dir names → doc pages ---
const CONVENTIONS: Record<string, string> = {
  routes: '04-API-Reference/04-REST-Endpoints.md',
  controllers: '04-API-Reference/04-REST-Endpoints.md',
  middleware: '04-API-Reference/05-Middleware.md',
  commands: '04-API-Reference/04-CLI-Reference.md',
  components: '05-Modules/Components.md',
  hooks: '05-Modules/Hooks.md',
  stores: '05-Modules/Stores.md',
  styles: '05-Modules/Styles.md',
  models: '05-Modules/Models.md',
  services: '05-Modules/Services.md',
  validators: '05-Modules/Validators.md',
  dtos: '05-Modules/DTOs.md',
  migrations: '05-Modules/Migrations.md',
};

// --- Synonym table: alternative names → canonical names ---
const SYNONYMS: Record<string, string> = {
  api: 'routes',
  handlers: 'controllers',
  entities: 'models',
  composables: 'hooks',
};

// --- Framework detection patterns → doc pages ---
const FRAMEWORK_PATTERNS: Array<{ pattern: string; docPage: string }> = [
  { pattern: '@Controller()', docPage: '04-API-Reference/04-REST-Endpoints.md' },
  { pattern: 'express.Router()', docPage: '04-API-Reference/04-REST-Endpoints.md' },
  { pattern: '@Injectable()', docPage: '05-Modules/Services.md' },
];

/**
 * Maps source directories to documentation pages using the fallback strategy.
 * Only directories with >= 200 LOC total are considered.
 */
export function resolveDocMappings(dirs: SourceDir[]): DocMapping[] {
  const mappings: DocMapping[] = [];

  for (const dir of dirs) {
    if (dir.totalLoc < LOC_THRESHOLD) continue;

    const mapping = resolveOne(dir);
    if (mapping) {
      mappings.push(mapping);
    }
  }

  return mappings;
}

function resolveOne(dir: SourceDir): DocMapping | null {
  const name = dir.name.toLowerCase();

  // 1. Convention matching
  const conventionPage = CONVENTIONS[name];
  if (conventionPage) {
    return { sourceDir: dir.name, docPage: conventionPage, strategy: 'convention' };
  }

  // 2. Synonym matching
  const canonical = SYNONYMS[name];
  if (canonical) {
    const synonymPage = CONVENTIONS[canonical];
    if (synonymPage) {
      return { sourceDir: dir.name, docPage: synonymPage, strategy: 'synonym' };
    }
  }

  // 3. Framework detection
  if (dir.filePatterns && dir.filePatterns.length > 0) {
    for (const fp of FRAMEWORK_PATTERNS) {
      if (dir.filePatterns.includes(fp.pattern)) {
        return { sourceDir: dir.name, docPage: fp.docPage, strategy: 'framework' };
      }
    }
  }

  // 4. Catch-all: 05-Modules/{dir-name}.md (kebab-case for safe paths)
  const safeName = dir.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
  return { sourceDir: dir.name, docPage: `05-Modules/${safeName}.md`, strategy: 'catch-all' };
}
