// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import type { Task } from '../../schemas/task.js';
import { contextLogger } from '../../utils/log-context.js';
import { resolveAdapter } from './language-adapters.js';
import { detectPythonSourceRoots } from './python-source-roots.js';
import {
  detectTsPathAliases,
  resolveAliasCandidates,
  type TsPathAliasMap,
} from './ts-path-aliases.js';

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

/** Record that `importer` uses `symbol` exported from `sourceFile`. */
function addUsageEdge(
  map: Map<string, Set<string>>,
  symbol: string,
  sourceFile: string,
  importer: string,
): void {
  if (importer === sourceFile) return;
  const key = `${symbol}::${sourceFile}`;
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(importer);
}

/**
 * Resolve an absolute base path (no extension) to a concrete project-relative
 * TypeScript file. Handles: .js → .ts (ESM convention), direct .ts/.tsx, and
 * /index.ts(x) barrels. Returns null when nothing exists on disk.
 */
function resolveTsFile(base: string, projectRoot: string): string | null {
  // Strip .js extension (ESM convention in TS projects)
  if (base.endsWith('.js')) {
    base = base.slice(0, -3);
  }

  // Exact file already on disk (alias targets may carry a .ts/.tsx extension)
  if ((base.endsWith('.ts') || base.endsWith('.tsx')) && existsSync(base)) {
    return relative(projectRoot, base);
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
 * Resolve a relative or path-aliased import specifier to a project-relative
 * file path. Handles relative (`./`, `../`) imports and TypeScript / Vite path
 * aliases (e.g. `@/lib/api`) when an `aliasMap` is supplied.
 * Returns null for node_modules / unresolvable imports.
 */
function resolveImportPath(
  specifier: string,
  importerAbsPath: string,
  projectRoot: string,
  aliasMap?: TsPathAliasMap,
): string | null {
  // Relative imports: resolve against the importer directory.
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = resolve(dirname(importerAbsPath), specifier);
    return resolveTsFile(base, projectRoot);
  }

  // Non-relative: try path aliases before giving up (bare node_modules).
  if (aliasMap && aliasMap.length > 0) {
    for (const candidate of resolveAliasCandidates(specifier, aliasMap)) {
      const resolved = resolveTsFile(candidate, projectRoot);
      if (resolved) return resolved;
    }
  }

  return null;
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
 * Strip comments and string literals from source code to avoid false-positive
 * symbol matches inside documentation or string content.
 * Template literal expressions (`${...}`) are preserved since they contain real code.
 *
 * Known limitation: nested template literals (e.g. `outer ${`inner`}`) are not
 * handled correctly by regex alone — residual content may cause false positives.
 */
/**
 * Replace each template literal with just the contents of its `${...}`
 * interpolations (space-separated), dropping the static text and backticks.
 *
 * This keeps identifier references that live inside interpolations — so a
 * symbol used only as `` `...${doStuff()}...` `` is still seen as referenced
 * (no false DEAD) — while removing static prose that could otherwise be
 * mistaken for a symbol reference (a false USED). The previous regex left any
 * template containing `${` fully intact, so neither property held. Handles
 * nested braces and nested template literals.
 */
export function stripTemplateLiterals(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch !== '`') { out += ch; i++; continue; }

    i++; // skip opening backtick
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }   // escaped char in static text
      if (c === '`') { i++; break; }          // closing backtick
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        let depth = 1;
        let expr = '';
        while (i < n && depth > 0) {
          const e = source[i];
          if (e === '{') depth++;
          else if (e === '}') { depth--; if (depth === 0) { i++; break; } }
          expr += e;
          i++;
        }
        out += ` ${stripTemplateLiterals(expr)} `; // recurse for nested templates
        continue;
      }
      i++; // drop static character
    }
    out += ' '; // separator where the template was
  }
  return out;
}

function stripCommentsAndStrings(source: string): string {
  const noComments = source
    // Remove single-line comments
    .replace(/\/\/.*$/gm, '')
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Template literals: keep ${...} interpolations, drop static text.
  return stripTemplateLiterals(noComments)
    // Remove double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Remove single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

/**
 * Build intra-file reference graph: for each symbol, find which *exported*
 * symbols in the same file reference it in their body. This enables transitive
 * usage detection — if symbol A is imported externally and references symbol B
 * in its body, B is transitively alive.
 *
 * Candidates (the referenced symbol B) span ALL symbols, so a non-exported
 * private helper called by a used public function is recognised as alive.
 * Referencers (A) are restricted to exported symbols so liveness is always
 * anchored on a binding whose own usage is decidable from cross-file edges —
 * which keeps the relation sound (never invents a false USED).
 */
function buildIntraFileGraph(
  projectRoot: string,
  tasks: Task[],
): Map<string, Set<string>> {
  const intra = new Map<string, Set<string>>();

  for (const task of tasks) {
    const exported = task.symbols.filter((s) => s.exported);
    // Need at least one exported anchor (a referencer) and a second symbol to
    // be the candidate. Files with a single symbol cannot have intra-file refs.
    if (exported.length < 1 || task.symbols.length < 2) continue;

    const absPath = resolve(projectRoot, task.file);
    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = source.split('\n');

    for (const candidate of task.symbols) {
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
  pythonSourceRoots?: readonly string[],
): string | null {
  const importerDir = dirname(importerRelPath);
  const importerExt = extname(importerRelPath);

  // Bash source: relative path (./lib/helpers.sh)
  if (importType === 'source' || importerExt === '.sh') {
    const resolved = join(importerDir, importSource);
    return taskFileSet.has(resolved) ? resolved : null;
  }

  // Python: module name → file path. Tries, in order:
  //   1. Each declared source root (pyproject.toml: setuptools / poetry /
  //      hatch + `src/` heuristic) — covers the standard src-layout where
  //      code lives under `src/<pkg>/...` but imports are written as
  //      absolute `<pkg>.module`.
  //   2. Relative to the importer directory (legacy bare-layout edges).
  //   3. As a package under the importer directory (`__init__.py`).
  if (importerExt === '.py') {
    const modulePath = importSource.replace(/\./g, '/');
    const roots = pythonSourceRoots && pythonSourceRoots.length > 0
      ? pythonSourceRoots
      : [''];
    for (const root of roots) {
      const base = root ? join(root, modulePath) : modulePath;
      const fileCandidate = base + '.py';
      if (taskFileSet.has(fileCandidate)) return fileCandidate;
      const pkgCandidate = join(base, '__init__.py');
      if (taskFileSet.has(pkgCandidate)) return pkgCandidate;
    }
    const relCandidate = join(importerDir, modulePath + '.py');
    if (taskFileSet.has(relCandidate)) return relCandidate;
    const relPkgCandidate = join(importerDir, modulePath, '__init__.py');
    if (taskFileSet.has(relPkgCandidate)) return relPkgCandidate;
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
 * @param tasks - All scanned audit tasks (contribute exports + imports).
 * @param importerOnlyTasks - Optional extra tasks (e.g. test files) whose
 *   imports are added to the graph but whose exports are NOT registered.
 *   Used so that symbols imported only by tests are not falsely flagged
 *   DEAD because `.anatoly.yml scan.exclude` removes tests from the audit
 *   set. The importer task's file path appears in the importer list returned
 *   by `getSymbolUsage`, which is exactly what tier-1 / utility evaluators
 *   need to flip DEAD → USED.
 * @returns UsageGraph mapping "symbol::file" → Set<importer files>
 */
export function buildUsageGraph(
  projectRoot: string,
  tasks: Task[],
  importerOnlyTasks: Task[] = [],
): UsageGraph {
  const startTime = Date.now();
  const usages = new Map<string, Set<string>>();
  const typeOnlyUsages = new Map<string, Set<string>>();
  const noImportFiles = new Set<string>();
  // Exports come from the audited tasks only — importer-only tasks (tests)
  // must not introduce phantom export targets.
  const allExportsByFile = buildExportMap(tasks);

  // Iterate audit tasks + importer-only tasks together for the import pass.
  const allImporters = importerOnlyTasks.length > 0 ? [...tasks, ...importerOnlyTasks] : tasks;

  // Build set of all known task files for non-TS import resolution
  const taskFileSet = new Set<string>(allImporters.map((t) => t.file));

  // Build Rust workspace crate map for cross-crate import resolution
  const hasRustFiles = allImporters.some((t) => extname(t.file) === '.rs');
  const rustCrateMap = hasRustFiles ? buildRustCrateMap(projectRoot, taskFileSet) : undefined;

  // Detect Python source roots once per build so src-layout absolute imports
  // (`from pkg.mod import x` → `src/pkg/mod.py`) resolve. Skipped when no
  // Python file is in the audit set.
  const hasPythonFiles = allImporters.some((t) => extname(t.file) === '.py');
  const pythonSourceRoots = hasPythonFiles ? detectPythonSourceRoots(projectRoot) : undefined;

  // Detect TypeScript / Vite path aliases once per build so non-relative
  // specifiers (`@/lib/api` → `client/src/lib/api.ts`) resolve. Without this,
  // alias imports look like bare node_modules specifiers and every aliased
  // import target is falsely flagged DEAD. Skipped when no TS file is present.
  const hasTsFiles = allImporters.some((t) => {
    const e = extname(t.file);
    return e === '.ts' || e === '.tsx';
  });
  const tsPathAliases = hasTsFiles ? detectTsPathAliases(projectRoot) : undefined;

  for (const task of allImporters) {
    const ext = extname(task.file);
    const language = task.language ?? resolveAdapter(ext)?.languageId;

    // No-import-system files: skip import extraction
    if (language && NO_IMPORT_LANGUAGES.has(language)) {
      noImportFiles.add(task.file);
      continue;
    }

    const isTs = ext === '.ts' || ext === '.tsx';

    if (isTs) {
      const importerAbs = resolve(projectRoot, task.file);

      if (task.imports_enriched) {
        // Precise per-symbol edges from AST-extracted imports (no regex).
        for (const ref of task.imports ?? []) {
          const resolved = resolveImportPath(ref.source, importerAbs, projectRoot, tsPathAliases);
          if (!resolved || resolved === task.file) continue;
          const targetMap = ref.typeOnly ? typeOnlyUsages : usages;
          if (ref.namespace) {
            // `import * as X` / `export * from` → consumes all of the target's exports.
            const exports = allExportsByFile.get(resolved);
            if (exports) for (const sym of exports) addUsageEdge(targetMap, sym, resolved, task.file);
          } else if (ref.symbols) {
            for (const sym of ref.symbols) addUsageEdge(targetMap, sym, resolved, task.file);
          }
          // A bare ref (side-effect `import './x'`) contributes no symbol edge.
        }
      } else {
        // Un-enriched: a pre-enrichment cache or a no-grammar (heuristic) parse.
        // Fall back to COARSE module-level expansion — mark every export of the
        // resolved target used. This over-marks USED (never produces a false
        // DEAD) and self-heals once the file is re-scanned with AST enrichment.
        let refs = task.imports;
        if (!refs) {
          const adapter = resolveAdapter(ext);
          if (!adapter) continue;
          let source: string;
          try {
            source = readFileSync(importerAbs, 'utf-8');
          } catch {
            continue;
          }
          refs = adapter.extractImports(source);
        }
        for (const ref of refs) {
          const resolved = resolveImportPath(ref.source, importerAbs, projectRoot, tsPathAliases);
          if (!resolved || resolved === task.file) continue;
          const exports = allExportsByFile.get(resolved);
          if (exports) for (const sym of exports) addUsageEdge(usages, sym, resolved, task.file);
        }
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
        const resolvedFile = resolveNonTsImportPath(ref.source, ref.type, task.file, taskFileSet, rustCrateMap, pythonSourceRoots);
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

/**
 * Invert the runtime-usage edges to answer the FORWARD question: which symbols
 * does `importerFile` import, and from which project files? Returns
 * `sourceFile → Set<symbolName>`. Type-only usages are excluded on purpose —
 * the caller (correction's imported-interface context) hydrates each entry from
 * RAG *function* cards, which exist for runtime functions/methods/hooks, not for
 * imported types. Self-edges are skipped. The graph already resolved every
 * import specifier to a concrete file when it built the reverse edges, so this
 * needs no path resolver of its own.
 */
export function getImportedSymbolsBySource(
  graph: UsageGraph,
  importerFile: string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, importers] of graph.usages) {
    if (!importers.has(importerFile)) continue;
    const sep = key.lastIndexOf('::');
    if (sep < 0) continue;
    const symbol = key.slice(0, sep);
    const sourceFile = key.slice(sep + 2);
    if (!symbol || !sourceFile || sourceFile === importerFile) continue;
    let set = out.get(sourceFile);
    if (!set) {
      set = new Set<string>();
      out.set(sourceFile, set);
    }
    set.add(symbol);
  }
  return out;
}

/**
 * Transitive runtime importers of a symbol, chasing through barrel re-exports.
 *
 * A direct importer that ITSELF re-exports the symbol (other files import the
 * same name from it) is a barrel; its own importers are the real consumers and
 * are folded in, recursively. Returns the union of every file that reaches the
 * symbol (barrels included — harmless when the question is "how many clients"),
 * sorted, excluding the source file. Cycle-safe.
 *
 * Use this wherever the EXACT client count matters — chiefly the
 * over-abstraction "≤1 importer" signal: plain {@link getSymbolUsage} counts
 * only DIRECT importers, so a class consumed by N files through a barrel
 * (`export { X } from './X'`) looks like a single-client abstraction and is
 * mis-flagged OVER. (For mere alive/dead questions, getSymbolUsage suffices: a
 * barrel re-export already yields ≥1 direct importer.)
 *
 * Limitation: keys are symbol-name-based, so a re-export and a distinct local
 * binding sharing a name in the same barrel are not disambiguated (rare).
 */
export function getTransitiveImporters(
  graph: UsageGraph,
  symbolName: string,
  sourceFile: string,
): string[] {
  const result = new Set<string>();
  const visited = new Set<string>([sourceFile]);
  const queue: string[] = [sourceFile];
  while (queue.length > 0) {
    const src = queue.shift()!;
    for (const importer of getSymbolUsage(graph, symbolName, src)) {
      result.add(importer);
      // `importer` re-exports the symbol (others import it from there) → barrel.
      if (!visited.has(importer) && graph.usages.has(`${symbolName}::${importer}`)) {
        visited.add(importer);
        queue.push(importer);
      }
    }
  }
  result.delete(sourceFile);
  return [...result].sort();
}

/** Merge two importer lists into a sorted, de-duplicated list. */
function mergeUsage(a: string[], b: string[]): string[] {
  if (b.length === 0) return a;
  return [...new Set([...a, ...b])].sort();
}

/**
 * Pure utility-axis verdict from the usage graph alone — no LLM call.
 *
 * Returns:
 * - `USED` when the symbol has runtime, type-only, or transitive importers
 * - `DEAD` when the symbol is exported with zero importers of any kind
 * - `null` for non-exported symbols (graph alone cannot decide; needs
 *   intra-file analysis or LLM)
 *
 * Shared between the `utility` axis evaluator (which uses it as a fast
 * pre-LLM resolver) and triage (which uses it to give skipped files an
 * accurate utility verdict instead of a blanket `USED`).
 */
export function resolveExportedSymbolUtility(
  sym: { name: string; exported: boolean; is_default?: boolean },
  graph: UsageGraph,
  ownFile: string,
): { value: 'USED' | 'DEAD'; confidence: number; detail: string } | null {
  if (!sym.exported) return null;

  // Default exports are imported under the synthetic name `default`, so a
  // default-exported symbol must also count importers recorded under that key.
  const importers = mergeUsage(
    getSymbolUsage(graph, sym.name, ownFile),
    sym.is_default ? getSymbolUsage(graph, 'default', ownFile) : [],
  );
  if (importers.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: `Runtime-imported by ${importers.length} file${importers.length > 1 ? 's' : ''}: ${importers.join(', ')}`,
    };
  }

  const typeImporters = mergeUsage(
    getTypeOnlySymbolUsage(graph, sym.name, ownFile),
    sym.is_default ? getTypeOnlySymbolUsage(graph, 'default', ownFile) : [],
  );
  if (typeImporters.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: `Type-only imported by ${typeImporters.length} file${typeImporters.length > 1 ? 's' : ''}: ${typeImporters.join(', ')}`,
    };
  }

  const transitiveRefs = getTransitiveUsage(graph, sym.name, ownFile);
  if (transitiveRefs.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: `Transitively used by ${transitiveRefs.join(', ')}`,
    };
  }

  return {
    value: 'DEAD',
    confidence: 95,
    detail: 'Exported but imported by 0 files',
  };
}

/**
 * Pure utility-axis verdict for a NON-exported symbol from the usage graph
 * alone — no LLM call.
 *
 * Returns `USED` when the symbol is referenced in its own file by an exported
 * symbol that has cross-file importers (one-hop transitive liveness anchored on
 * a definitely-used referencer). This is sound — a private helper called by a
 * used public function is itself used — and never yields a false USED.
 *
 * Returns `null` otherwise: a non-exported symbol with no live in-file
 * referencer cannot be proven dead from the graph alone (it may be referenced
 * by another local binding the one-hop relation does not chase, or only inside
 * expressions the lightweight scan misses), so the decision is left to the LLM.
 *
 * Complements {@link resolveExportedSymbolUtility} (which returns null for
 * non-exported symbols); together they cover the auto-resolvable cases.
 */
export function resolveNonExportedSymbolUtility(
  sym: { name: string; exported: boolean },
  graph: UsageGraph,
  ownFile: string,
): { value: 'USED'; confidence: number; detail: string } | null {
  if (sym.exported) return null;

  const liveRefs = getTransitiveUsage(graph, sym.name, ownFile);
  if (liveRefs.length > 0) {
    return {
      value: 'USED',
      confidence: 90,
      detail: `Referenced in-file by ${liveRefs.join(', ')} (which ${liveRefs.length > 1 ? 'are' : 'is'} imported by other files)`,
    };
  }

  return null;
}
