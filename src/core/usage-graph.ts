import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { Task } from '../schemas/task.js';

export interface UsageGraph {
  /** "symbolName::filePath" → Set<files that import this symbol from this file> */
  usages: Map<string, Set<string>>;
}

/**
 * Regex patterns for extracting imports from TypeScript source.
 * Matches:
 * - import { A, B as C } from './path'
 * - import Default from './path'
 * - import * as X from './path'
 * - export { A, B } from './path'
 * Ignores:
 * - import type { ... } from '...' (type-only, no runtime usage)
 * - export type { ... } from '...'
 */
const NAMED_IMPORT_RE =
  /import\s+(?!type\s)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const DEFAULT_IMPORT_RE =
  /import\s+(?!type\s)(\w+)\s+from\s+['"]([^'"]+)['"]/g;

const NAMESPACE_IMPORT_RE =
  /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

const REEXPORT_RE =
  /export\s+(?!type\s)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Resolve a relative import specifier to a project-relative file path.
 * Handles: .js → .ts, bare → .ts or /index.ts.
 * Returns null for node_modules or unresolvable imports.
 */
function resolveImportPath(
  specifier: string,
  importerAbsPath: string,
  projectRoot: string,
): string | null {
  // Skip node_modules / bare specifiers
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }

  const importerDir = dirname(importerAbsPath);
  let base = resolve(importerDir, specifier);

  // Strip .js extension (ESM convention in TS projects)
  if (base.endsWith('.js')) {
    base = base.slice(0, -3);
  }

  // Try direct .ts / .tsx
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(base + ext)) {
      return relative(projectRoot, base + ext);
    }
  }

  // Try /index.ts / /index.tsx
  for (const ext of ['/index.ts', '/index.tsx']) {
    if (existsSync(base + ext)) {
      return relative(projectRoot, base + ext);
    }
  }

  return null;
}

/**
 * Extract import relationships from a single file's source code.
 */
function extractImports(
  source: string,
  importerAbsPath: string,
  projectRoot: string,
  allExportsByFile: Map<string, Set<string>>,
): Array<{ symbol: string; sourceFile: string; importerFile: string }> {
  const results: Array<{
    symbol: string;
    sourceFile: string;
    importerFile: string;
  }> = [];

  const importerFile = relative(projectRoot, importerAbsPath);

  // Named imports: import { A, B as C } from './path'
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const names = match[1];
    const specifier = match[2];
    const resolved = resolveImportPath(specifier, importerAbsPath, projectRoot);
    if (!resolved) continue;

    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle "A as B" — the original name is what matters for usage tracking
      const originalName = trimmed.split(/\s+as\s+/)[0].trim();
      if (originalName) {
        results.push({
          symbol: originalName,
          sourceFile: resolved,
          importerFile,
        });
      }
    }
  }

  // Default imports: import X from './path'
  for (const match of source.matchAll(DEFAULT_IMPORT_RE)) {
    const specifier = match[2];
    // Skip if this is actually a namespace or named import (already handled)
    if (match[0].includes('{') || match[0].includes('*')) continue;
    const resolved = resolveImportPath(specifier, importerAbsPath, projectRoot);
    if (!resolved) continue;
    results.push({
      symbol: 'default',
      sourceFile: resolved,
      importerFile,
    });
  }

  // Namespace imports: import * as X from './path'
  for (const match of source.matchAll(NAMESPACE_IMPORT_RE)) {
    const specifier = match[2];
    const resolved = resolveImportPath(specifier, importerAbsPath, projectRoot);
    if (!resolved) continue;

    // Count all exports of the source file as used
    const exports = allExportsByFile.get(resolved);
    if (exports) {
      for (const sym of exports) {
        results.push({
          symbol: sym,
          sourceFile: resolved,
          importerFile,
        });
      }
    }
  }

  // Re-exports: export { A, B } from './path'
  for (const match of source.matchAll(REEXPORT_RE)) {
    const names = match[1];
    const specifier = match[2];
    const resolved = resolveImportPath(specifier, importerAbsPath, projectRoot);
    if (!resolved) continue;

    for (const part of names.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const originalName = trimmed.split(/\s+as\s+/)[0].trim();
      if (originalName) {
        results.push({
          symbol: originalName,
          sourceFile: resolved,
          importerFile,
        });
      }
    }
  }

  return results;
}

/**
 * Build an export map from tasks: filePath → Set<exported symbol names>.
 */
function buildExportMap(tasks: Task[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const task of tasks) {
    const exports = new Set<string>();
    for (const sym of task.symbols) {
      if (sym.exported) {
        exports.add(sym.name);
      }
    }
    if (exports.size > 0) {
      map.set(task.file, exports);
    }
  }
  return map;
}

/**
 * Build a usage graph by scanning all import statements across the project.
 * Runs in a single local pass (no API calls).
 *
 * @param projectRoot - Absolute path to the project root
 * @param tasks - All scanned tasks (for export information and file list)
 * @returns UsageGraph mapping "symbol::file" → Set<importer files>
 */
export function buildUsageGraph(
  projectRoot: string,
  tasks: Task[],
): UsageGraph {
  const usages = new Map<string, Set<string>>();
  const allExportsByFile = buildExportMap(tasks);

  for (const task of tasks) {
    const absPath = resolve(projectRoot, task.file);
    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const imports = extractImports(
      source,
      absPath,
      projectRoot,
      allExportsByFile,
    );

    for (const imp of imports) {
      // Don't count self-imports
      if (imp.importerFile === imp.sourceFile) continue;

      const key = `${imp.symbol}::${imp.sourceFile}`;
      let set = usages.get(key);
      if (!set) {
        set = new Set<string>();
        usages.set(key, set);
      }
      set.add(imp.importerFile);
    }
  }

  return { usages };
}

/**
 * Get the list of files that import a specific symbol from a specific file.
 */
export function getSymbolUsage(
  graph: UsageGraph,
  symbolName: string,
  filePath: string,
): string[] {
  const key = `${symbolName}::${filePath}`;
  const set = graph.usages.get(key);
  return set ? [...set].sort() : [];
}
