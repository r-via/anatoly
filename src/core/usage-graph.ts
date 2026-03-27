// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import type { Task } from '../schemas/task.js';
import { contextLogger } from '../utils/log-context.js';
import { resolveAdapter } from './language-adapters.js';

export interface UsageGraph {
  /** "symbolName::filePath" → Set<files that import this symbol from this file> (runtime imports) */
  usages: Map<string, Set<string>>;
  /** "symbolName::filePath" → Set<files that type-only import this symbol from this file> */
  typeOnlyUsages: Map<string, Set<string>>;
  /** "symbolName::filePath" → Set<exported symbol names in the same file that reference this symbol in their body> */
  intraFileRefs: Map<string, Set<string>>;
  /** Files whose language has no import system (SQL, YAML, JSON) — should never be flagged as DEAD */
  noImportFiles: Set<string>;
}

/**
 * Regex patterns for extracting imports from TypeScript source.
 * Matches:
 * - import { A, B as C } from './path'
 * - import Default from './path'
 * - import * as X from './path'
 * - export { A, B } from './path'
 * - import type { A } from './path' (type-only — tracked separately)
 * - export type { A } from './path' (type-only — tracked separately)
 */
const NAMED_IMPORT_RE =
  /import\s+(?!type\s)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const DEFAULT_IMPORT_RE =
  /import\s+(?!type\s)(\w+)\s+from\s+['"]([^'"]+)['"]/g;

const TYPE_NAMED_IMPORT_RE =
  /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const TYPE_REEXPORT_RE =
  /export\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const NAMESPACE_IMPORT_RE =
  /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

const REEXPORT_RE =
  /export\s+(?!type\s)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const STAR_REEXPORT_RE =
  /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

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
 *
 * Parses named, default, namespace, and re-export statements (including
 * type-only variants) and resolves each specifier to a project-relative path.
 * For namespace imports and star re-exports, `allExportsByFile` is used to
 * expand the wildcard into individual symbol entries.
 *
 * @param source - Raw source code of the importing file.
 * @param importerAbsPath - Absolute path of the importing file (used for specifier resolution).
 * @param projectRoot - Absolute path to the project root (for computing relative paths).
 * @param allExportsByFile - Map of project-relative file paths to their exported symbol names;
 *   used to expand namespace (`import * as`) and star (`export *`) imports.
 * @returns Array of resolved import edges, each containing the symbol name, source file,
 *   importer file, and whether the import is type-only.
 */
function extractImports(
  source: string,
  importerAbsPath: string,
  projectRoot: string,
  allExportsByFile: Map<string, Set<string>>,
): Array<{ symbol: string; sourceFile: string; importerFile: string; typeOnly: boolean }> {
  const results: Array<{
    symbol: string;
    sourceFile: string;
    importerFile: string;
    typeOnly: boolean;
  }> = [];

  const importerFile = relative(projectRoot, importerAbsPath);

  /** Helper to extract named symbols from a comma-separated capture group */
  function parseNamedSymbols(
    namesStr: string, specifier: string, typeOnly: boolean,
  ): void {
    const resolved = resolveImportPath(specifier, importerAbsPath, projectRoot);
    if (!resolved) return;
    for (const part of namesStr.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let originalName = trimmed.split(/\s+as\s+/)[0].trim();
      let isTypeOnly = typeOnly;
      // Handle TS 4.5+ inline type modifier: import { type A, B }
      if (originalName.startsWith('type ')) {
        originalName = originalName.slice(5).trim();
        isTypeOnly = true;
      }
      if (originalName) {
        results.push({ symbol: originalName, sourceFile: resolved, importerFile, typeOnly: isTypeOnly });
      }
    }
  }

  // Named imports: import { A, B as C } from './path'
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    parseNamedSymbols(match[1], match[2], false);
  }

  // Type-only named imports: import type { A, B } from './path'
  for (const match of source.matchAll(TYPE_NAMED_IMPORT_RE)) {
    parseNamedSymbols(match[1], match[2], true);
  }

  // Default imports: import X from './path'
  for (const match of source.matchAll(DEFAULT_IMPORT_RE)) {
    if (match[0].includes('{') || match[0].includes('*')) continue;
    const resolved = resolveImportPath(match[2], importerAbsPath, projectRoot);
    if (!resolved) continue;
    results.push({ symbol: 'default', sourceFile: resolved, importerFile, typeOnly: false });
  }

  // Namespace imports: import * as X from './path'
  for (const match of source.matchAll(NAMESPACE_IMPORT_RE)) {
    const resolved = resolveImportPath(match[2], importerAbsPath, projectRoot);
    if (!resolved) continue;
    const exports = allExportsByFile.get(resolved);
    if (exports) {
      for (const sym of exports) {
        results.push({ symbol: sym, sourceFile: resolved, importerFile, typeOnly: false });
      }
    }
  }

  // Re-exports: export { A, B } from './path'
  for (const match of source.matchAll(REEXPORT_RE)) {
    parseNamedSymbols(match[1], match[2], false);
  }

  // Type-only re-exports: export type { A, B } from './path'
  for (const match of source.matchAll(TYPE_REEXPORT_RE)) {
    parseNamedSymbols(match[1], match[2], true);
  }

  // Star re-exports: export * from './path' — all exports of source marked as used
  for (const match of source.matchAll(STAR_REEXPORT_RE)) {
    const resolved = resolveImportPath(match[1], importerAbsPath, projectRoot);
    if (!resolved) continue;
    const exports = allExportsByFile.get(resolved);
    if (exports) {
      for (const sym of exports) {
        results.push({ symbol: sym, sourceFile: resolved, importerFile, typeOnly: false });
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip template literals while preserving interpolation expressions.
 * Static text between backticks is removed; `${...}` expression content is kept
 * so that symbol references inside interpolations remain visible.
 *
 * Known limitation: nested template literals (e.g. `outer ${`inner`}`) are not
 * handled — residual content from inner literals may cause false positives.
 */
function stripTemplateLiterals(source: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '`') {
      i++; // skip opening backtick
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') {
          i += 2; // skip escaped character
        } else if (source[i] === '$' && i + 1 < source.length && source[i + 1] === '{') {
          i += 2; // skip ${
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            if (depth > 0) {
              result.push(source[i]);
            }
            i++;
          }
        } else {
          i++; // skip static character
        }
      }
      if (i < source.length) i++; // skip closing backtick
    } else {
      result.push(source[i]);
      i++;
    }
  }
  return result.join('');
}

/**
 * Strip comments and string literals from source code to avoid false-positive
 * symbol matches inside documentation or string content.
 * Template literal expressions (`${...}`) are preserved since they contain real code.
 */
function stripCommentsAndStrings(source: string): string {
  let result = source
    // Remove single-line comments
    .replace(/\/\/.*$/gm, '')
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip template literal static parts, preserving ${...} expression content
  result = stripTemplateLiterals(result);
  return result
    // Remove double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Remove single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

/**
 * Build intra-file reference graph: for each exported symbol, find which
 * other exported symbols in the same file reference it in their body.
 * This enables transitive usage detection — if symbol A is imported
 * externally and references symbol B in its body, B is transitively alive.
 */
function buildIntraFileGraph(
  projectRoot: string,
  tasks: Task[],
): Map<string, Set<string>> {
  const intra = new Map<string, Set<string>>();

  for (const task of tasks) {
    const exported = task.symbols.filter((s) => s.exported);
    if (exported.length < 2) continue;

    const absPath = resolve(projectRoot, task.file);
    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = source.split('\n');

    for (const candidate of exported) {
      for (const referencer of exported) {
        if (candidate.name === referencer.name) continue;

        const rawBody = lines.slice(referencer.line_start - 1, referencer.line_end).join('\n');
        const body = stripCommentsAndStrings(rawBody);
        const re = new RegExp(`\\b${escapeRegExp(candidate.name)}\\b`);
        if (re.test(body)) {
          const key = `${candidate.name}::${task.file}`;
          let set = intra.get(key);
          if (!set) {
            set = new Set<string>();
            intra.set(key, set);
          }
          set.add(referencer.name);
        }
      }
    }
  }

  return intra;
}

/** Languages with no import system — symbols should never be flagged as DEAD. */
const NO_IMPORT_LANGUAGES = new Set(['sql', 'yaml', 'json']);

/**
 * Cargo workspace crate map: crate_name (underscored) → project-relative source directory.
 * E.g. "rustguard_core" → "rustguard-core/src"
 */
type RustCrateMap = Map<string, string>;

/**
 * Build a mapping of Rust workspace crate names to their source directories.
 * Reads the root Cargo.toml for [workspace] members, then each member's Cargo.toml
 * for [package] name. Crate names have hyphens converted to underscores (Rust convention).
 *
 * Also detects the importer's own crate source directory for `crate::` resolution
 * in workspace members (where `src/` is relative to the member, not the project root).
 */
function buildRustCrateMap(
  projectRoot: string,
  taskFileSet: Set<string>,
): RustCrateMap {
  const crateMap: RustCrateMap = new Map();

  const rootCargoPath = join(projectRoot, 'Cargo.toml');
  let rootCargo: string;
  try {
    rootCargo = readFileSync(rootCargoPath, 'utf-8');
  } catch {
    return crateMap;
  }

  // Extract workspace members from [workspace] section
  // Handles: members = ["crate-a", "crate-b"] (single or multi-line)
  const membersMatch = rootCargo.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersMatch) {
    // Not a workspace — check if it's a single crate with [package]
    const nameMatch = rootCargo.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      const crateName = nameMatch[1].replace(/-/g, '_');
      crateMap.set(crateName, 'src');
    }
    return crateMap;
  }

  const memberPatterns = membersMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0);

  // Expand glob patterns (e.g. "crates/*") into actual directories
  const memberStrings: string[] = [];
  for (const pattern of memberPatterns) {
    if (pattern.includes('*')) {
      const parentDir = pattern.replace(/\/?\*.*$/, '');
      const absParent = join(projectRoot, parentDir);
      try {
        const entries = readdirSync(absParent, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            memberStrings.push(join(parentDir, entry.name));
          }
        }
      } catch {
        // Parent dir doesn't exist — skip
      }
    } else {
      memberStrings.push(pattern);
    }
  }

  for (const memberDir of memberStrings) {
    const memberCargoPath = join(projectRoot, memberDir, 'Cargo.toml');
    let memberCargo: string;
    try {
      memberCargo = readFileSync(memberCargoPath, 'utf-8');
    } catch {
      continue;
    }

    const nameMatch = memberCargo.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
    if (!nameMatch) continue;

    const crateName = nameMatch[1].replace(/-/g, '_');
    const srcDir = join(memberDir, 'src');
    // Verify this directory has files in our task set
    const hasSources = [...taskFileSet].some((f) => f.startsWith(srcDir + '/') || f === srcDir);
    if (hasSources || existsSync(join(projectRoot, srcDir))) {
      crateMap.set(crateName, srcDir);
    }
  }

  return crateMap;
}

/**
 * Determine the workspace member source directory for a given Rust file.
 * E.g. "rustguard-core/src/noise.rs" → "rustguard-core/src"
 */
function getRustCrateSrcDir(
  importerRelPath: string,
  crateMap: RustCrateMap,
): string {
  for (const srcDir of crateMap.values()) {
    if (importerRelPath.startsWith(srcDir + '/')) {
      return srcDir;
    }
  }
  // Fallback: assume top-level src/
  return 'src';
}

/**
 * Try to resolve a Rust module path (array of segments) relative to a source directory.
 * Handles both file modules (foo.rs) and directory modules (foo/mod.rs).
 */
function resolveRustModulePath(
  parts: string[],
  srcDir: string,
  taskFileSet: Set<string>,
): string | null {
  for (let len = parts.length; len >= 1; len--) {
    const candidate = srcDir + '/' + parts.slice(0, len).join('/') + '.rs';
    if (taskFileSet.has(candidate)) return candidate;
    const modCandidate = srcDir + '/' + parts.slice(0, len).join('/') + '/mod.rs';
    if (taskFileSet.has(modCandidate)) return modCandidate;
  }
  return null;
}

/**
 * Resolve a non-TypeScript import path to a project-relative file path.
 * Handles Bash source paths, Python module names, and Rust crate paths
 * (including cross-crate workspace imports).
 */
function resolveNonTsImportPath(
  importSource: string,
  importType: string,
  importerRelPath: string,
  taskFileSet: Set<string>,
  rustCrateMap?: RustCrateMap,
): string | null {
  const importerDir = dirname(importerRelPath);
  const importerExt = extname(importerRelPath);

  // Bash source: relative path (./lib/helpers.sh)
  if (importType === 'source' || importerExt === '.sh') {
    const resolved = join(importerDir, importSource);
    return taskFileSet.has(resolved) ? resolved : null;
  }

  // Python: module name → file path
  if (importerExt === '.py') {
    const modulePath = importSource.replace(/\./g, '/');
    // Try relative to importer directory first
    const relCandidate = join(importerDir, modulePath + '.py');
    if (taskFileSet.has(relCandidate)) return relCandidate;
    // Try relative to project root
    const rootCandidate = modulePath + '.py';
    if (taskFileSet.has(rootCandidate)) return rootCandidate;
    // Try as package
    const pkgCandidate = join(importerDir, modulePath, '__init__.py');
    if (taskFileSet.has(pkgCandidate)) return pkgCandidate;
    return null;
  }

  // Rust: handle crate::, super::, self::, and cross-crate workspace imports
  if (importerExt === '.rs') {
    const crateSrcDir = rustCrateMap
      ? getRustCrateSrcDir(importerRelPath, rustCrateMap)
      : 'src';

    // crate:: — resolve relative to the crate's own src directory
    if (importSource.startsWith('crate::')) {
      const parts = importSource.slice('crate::'.length).split('::');
      return resolveRustModulePath(parts, crateSrcDir, taskFileSet);
    }

    // super:: — resolve relative to parent module directory (supports chained super::super::)
    if (importSource.startsWith('super::')) {
      let remaining = importSource;
      let baseDir = importerDir;
      while (remaining.startsWith('super::')) {
        remaining = remaining.slice('super::'.length);
        baseDir = dirname(baseDir);
      }
      const parts = remaining.split('::').filter(Boolean);
      return resolveRustModulePath(parts, baseDir, taskFileSet);
    }

    // self:: — resolve relative to current module directory
    if (importSource.startsWith('self::')) {
      const parts = importSource.slice('self::'.length).split('::');
      return resolveRustModulePath(parts, importerDir, taskFileSet);
    }

    // Cross-crate workspace import: use other_crate::module::symbol
    if (rustCrateMap) {
      const topSegment = importSource.split('::')[0];
      const targetSrcDir = rustCrateMap.get(topSegment);
      if (targetSrcDir) {
        const parts = importSource.split('::').slice(1);
        if (parts.length > 0) {
          return resolveRustModulePath(parts, targetSrcDir, taskFileSet);
        }
        // Direct crate import — try lib.rs
        const libRs = targetSrcDir + '/lib.rs';
        if (taskFileSet.has(libRs)) return libRs;
      }
    }

    return null;
  }

  return null;
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
  const startTime = Date.now();
  const usages = new Map<string, Set<string>>();
  const typeOnlyUsages = new Map<string, Set<string>>();
  const noImportFiles = new Set<string>();
  const allExportsByFile = buildExportMap(tasks);

  // Build set of all known task files for non-TS import resolution
  const taskFileSet = new Set<string>(tasks.map((t) => t.file));

  // Build Rust workspace crate map for cross-crate import resolution
  const hasRustFiles = tasks.some((t) => extname(t.file) === '.rs');
  const rustCrateMap = hasRustFiles ? buildRustCrateMap(projectRoot, taskFileSet) : undefined;

  for (const task of tasks) {
    const ext = extname(task.file);
    const language = task.language ?? resolveAdapter(ext)?.languageId;

    // No-import-system files: skip import extraction
    if (language && NO_IMPORT_LANGUAGES.has(language)) {
      noImportFiles.add(task.file);
      continue;
    }

    const isTs = ext === '.ts' || ext === '.tsx';

    // Only read file from disk when needed (TS fine-grained path or fallback)
    if (isTs) {
      const absPath = resolve(projectRoot, task.file);
      let source: string;
      try {
        source = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }
      // TypeScript: fine-grained per-symbol import tracking
      const imports = extractImports(
        source,
        absPath,
        projectRoot,
        allExportsByFile,
      );

      for (const imp of imports) {
        if (imp.importerFile === imp.sourceFile) continue;

        const key = `${imp.symbol}::${imp.sourceFile}`;
        const targetMap = imp.typeOnly ? typeOnlyUsages : usages;
        let set = targetMap.get(key);
        if (!set) {
          set = new Set<string>();
          targetMap.set(key, set);
        }
        set.add(imp.importerFile);
      }
    } else {
      // Non-TS: use persisted imports from scan phase, fall back to regex extraction
      let importRefs = task.imports;
      if (!importRefs) {
        const adapter = resolveAdapter(ext);
        if (!adapter) continue;
        let source: string;
        try {
          source = readFileSync(resolve(projectRoot, task.file), 'utf-8');
        } catch { continue; }
        importRefs = adapter.extractImports(source);
      }

      for (const ref of importRefs) {
        const resolvedFile = resolveNonTsImportPath(ref.source, ref.type, task.file, taskFileSet, rustCrateMap);
        if (!resolvedFile || resolvedFile === task.file) continue;

        const exports = allExportsByFile.get(resolvedFile);
        if (exports) {
          for (const sym of exports) {
            const key = `${sym}::${resolvedFile}`;
            let set = usages.get(key);
            if (!set) {
              set = new Set<string>();
              usages.set(key, set);
            }
            set.add(task.file);
          }
        }
      }
    }
  }

  // Count orphan symbols (exported but never imported by any file)
  let totalExports = 0;
  let orphanCount = 0;
  for (const [file, exports] of allExportsByFile) {
    for (const sym of exports) {
      totalExports++;
      const key = `${sym}::${file}`;
      if (!usages.has(key) && !typeOnlyUsages.has(key)) {
        orphanCount++;
      }
    }
  }

  const intraFileRefs = buildIntraFileGraph(projectRoot, tasks);

  contextLogger().debug(
    {
      files: tasks.length,
      runtimeImports: usages.size,
      typeImports: typeOnlyUsages.size,
      intraFileRefs: intraFileRefs.size,
      totalExports,
      orphanCount,
      rustWorkspaceCrates: rustCrateMap?.size ?? 0,
      durationMs: Date.now() - startTime,
    },
    'usage graph built',
  );

  return { usages, typeOnlyUsages, intraFileRefs, noImportFiles };
}

/**
 * Get the list of files that runtime-import a specific symbol from a specific file.
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

/**
 * Get the list of files that type-only import a specific symbol from a specific file.
 */
export function getTypeOnlySymbolUsage(
  graph: UsageGraph,
  symbolName: string,
  filePath: string,
): string[] {
  const key = `${symbolName}::${filePath}`;
  const set = graph.typeOnlyUsages.get(key);
  return set ? [...set].sort() : [];
}

/**
 * Get exported symbols in the same file that reference the given symbol in their body.
 * Only returns referencers that are themselves alive (imported by other files).
 */
export function getTransitiveUsage(
  graph: UsageGraph,
  symbolName: string,
  filePath: string,
): string[] {
  const key = `${symbolName}::${filePath}`;
  const refs = graph.intraFileRefs.get(key);
  if (!refs) return [];
  return [...refs].filter((ref) => {
    const refKey = `${ref}::${filePath}`;
    return graph.usages.has(refKey) || graph.typeOnlyUsages.has(refKey);
  }).sort();
}
