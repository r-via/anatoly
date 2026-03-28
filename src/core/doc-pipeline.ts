// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Pipeline Orchestrator — Story 29.15
 *
 * Wires the standalone doc modules (Stories 29.1-29.14) into the Anatoly
 * pipeline. Two entry points:
 *
 * 1. runDocScaffold() — called during setup phase (after scan)
 *    profile.types → resolveModuleGranularity → resolveDocMappings → scaffoldDocs
 *
 * 2. runDocGeneration() — called between setup and review
 *    loadDocCache → checkDocCache → build contexts → LLM generate → save cache
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ProjectProfile, type ProjectType } from './language-detect.js';
import { scaffoldDocs, type ScaffoldResult } from './doc-scaffolder.js';
import { resolveModuleGranularity, extractModuleName, type ModuleDir } from './module-granularity.js';
import { resolveDocMappings, type SourceDir, type DocMapping } from './doc-mapping.js';
import { assertSafeOutputPath } from './docs-guard.js';
import { loadDocCache, saveDocCache, checkDocCache, updateDocCacheEntry, removeDocCacheEntry, type DocCache, type PageMapping, type CacheResult } from './doc-cache.js';
import { buildPageContext, type SourceFile } from './source-context.js';
import { getDocTokenBudget } from './docs-resolver.js';
import { buildPagePrompt, type PageInfo, type PagePrompt, type DocNeighbor } from './doc-generator.js';
import { collectTypeContext } from './doc-type-context.js';
import type { Task } from '../schemas/task.js';

// --- Public interfaces ---

export interface DocScaffoldResult {
  projectTypes: ProjectType[];
  scaffoldResult: ScaffoldResult;
  docMappings: DocMapping[];
  outputDir: string;
}

export interface DocGenerationResult {
  cacheResult: CacheResult;
  pagesGenerated: number;
  /** Pages stale but deferred because their module was not touched this run */
  pagesDeferred: number;
  pagesRemoved: number;
  totalPages: number;
  prompts: PagePrompt[];
  /** Save updated cache entries for generated pages. Call after LLM writes complete. */
  commitCache: () => void;
  /** Remove a failed page from the pending cache so it regenerates next run. */
  rollbackPage: (pagePath: string) => void;
}

export interface DocPipelineResult {
  scaffold: DocScaffoldResult;
  generation?: DocGenerationResult;
}

// --- Scaffold phase ---

/**
 * Runs the doc scaffolding phase:
 * 1. Reads project types from the unified ProjectProfile
 * 2. Resolves module granularity from scanner tasks
 * 3. Resolves code→doc mappings
 * 4. Scaffolds .anatoly/docs/ with guard
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param packageJson - Parsed `package.json` contents, forwarded to the scaffolder
 *   for metadata extraction (name, description, etc.).
 * @param tasks - Scanner task list used to derive module directories and source mappings.
 * @param docsPath - Relative path to the user-facing docs directory (default `"docs"`);
 *   used by the output-path guard to prevent overwriting user docs.
 * @param profile - Unified project profile providing detected project types.
 * @returns Scaffold result containing project types, generated scaffold structure,
 *   code-to-doc mappings, and the output directory path.
 */
export function runDocScaffold(
  projectRoot: string,
  packageJson: Record<string, unknown>,
  tasks: Task[],
  docsPath = 'docs',
  profile: ProjectProfile,
): DocScaffoldResult {
  const outputDir = resolve(projectRoot, '.anatoly', 'docs');

  // Guard: never write to docs/
  assertSafeOutputPath(outputDir, projectRoot, docsPath);

  // 1. Read project types from profile
  const projectTypes = profile.types;

  // 2. Resolve module granularity from task data
  const moduleDirs = buildModuleDirs(tasks);
  const modulePages = resolveModuleGranularity(moduleDirs);

  // 3. Resolve code→doc mappings
  const sourceDirs = buildSourceDirs(tasks);
  const docMappings = resolveDocMappings(sourceDirs);

  // 4. Scaffold with dynamic module pages (Story 29.16)
  const scaffoldResult = scaffoldDocs(outputDir, projectTypes, packageJson, undefined, modulePages);

  return { projectTypes, scaffoldResult, docMappings, outputDir };
}

// --- Generation phase ---

/**
 * Runs the doc generation phase:
 * 1. Loads incremental cache
 * 2. Determines which pages need regeneration
 * 3. Builds page contexts and prompts for stale/added pages
 * 4. Returns prompts for LLM execution (caller handles actual SDK calls)
 * 5. Saves updated cache
 *
 * LLM calls are NOT executed here — the caller (run.ts) handles them via
 * the SDK with the global semaphore. This function returns PagePrompt[]
 * that the caller executes and writes to disk.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param scaffoldResult - Output from {@link runDocScaffold}, providing the
 *   scaffold structure, doc mappings, and output directory.
 * @param tasks - Scanner task list used to resolve source files for each page.
 * @param packageJson - Parsed `package.json` contents, forwarded to page prompt
 *   building for project metadata.
 * @param changedFiles - Optional set of file paths that changed since the last
 *   run. When provided, only pages whose source files intersect this set are
 *   regenerated; other stale/added pages are deferred (`pagesDeferred` count).
 *   When omitted, all stale and added pages are regenerated.
 * @returns Generation result with cache status, prompt list for LLM execution,
 *   and counts of generated, deferred, removed, and total pages. Includes
 *   `commitCache` to persist updated hashes after successful LLM writes, and
 *   `rollbackPage` to remove a failed page from the pending cache.
 */
export function runDocGeneration(
  projectRoot: string,
  scaffoldResult: DocScaffoldResult,
  tasks: Task[],
  packageJson: Record<string, unknown>,
  changedFiles?: Set<string>,
): DocGenerationResult {
  const outputDir = scaffoldResult.outputDir;
  const cachePath = join(outputDir, '.cache.json');

  // Load cache
  const cache = loadDocCache(cachePath);

  // Build page mappings from scaffold result
  const pageMappings = buildPageMappings(scaffoldResult, tasks);

  // Compute current source file hashes
  const currentHashes = computeSourceHashes(projectRoot, pageMappings);

  // Check cache
  const cacheResult = checkDocCache(cache, pageMappings, currentHashes);

  // Load README.md as context (read-only, may be stale)
  let readme: string | undefined;
  try {
    readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf-8');
  } catch {
    // No README — that's fine
  }

  // Collect type-specific context once (e.g. CLI --help output)
  const typeContext = collectTypeContext(projectRoot, scaffoldResult.projectTypes, packageJson);

  // Build prompts for stale + added pages.
  // When changedFiles is provided, scope to only pages whose source files
  // intersect with the changed set — avoids regenerating unrelated modules.
  const prompts: PagePrompt[] = [];
  const allStaleOrAdded = [...cacheResult.stale, ...cacheResult.added];
  const pagesToGenerate = changedFiles
    ? allStaleOrAdded.filter(pagePath => {
        const mapping = pageMappings.find(m => m.pagePath === pagePath);
        if (!mapping) return false;
        return mapping.sourceFiles.some(f => changedFiles.has(f));
      })
    : allStaleOrAdded;
  const pagesDeferred = changedFiles
    ? allStaleOrAdded.length - pagesToGenerate.length
    : 0;

  for (const pagePath of pagesToGenerate) {
    const mapping = pageMappings.find(m => m.pagePath === pagePath);
    if (!mapping) continue;

    const sourceFiles = loadSourceFiles(projectRoot, mapping.sourceFiles);
    const pageContext = buildPageContext(pagePath, sourceFiles, { maxTokens: getDocTokenBudget('claude-sonnet-4-6') });
    const pageInfo: PageInfo = {
      path: pagePath,
      title: pagePath.split('/').pop()?.replace('.md', '') ?? pagePath,
      description: `Documentation for ${pagePath}`,
    };
    const allPages = pageMappings.map(m => m.pagePath);
    const neighbors = loadNeighborPages(outputDir, pagePath, allPages);
    const prompt = buildPagePrompt(pageInfo, pageContext, packageJson, { allPages, neighbors, readme, typeContext });
    prompts.push(prompt);
  }

  // Remove deleted pages (with traversal guard — append separator to prevent
  // sibling-directory prefix matches like .anatoly/docs vs .anatoly/docs-backup)
  const resolvedOutputDir = resolve(outputDir) + '/';
  for (const removed of cacheResult.removed) {
    const fullPath = resolve(outputDir, removed);
    if (!fullPath.startsWith(resolvedOutputDir)) continue;
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }

  // Update cache: remove deleted entries and persist immediately (files already unlinked)
  let updatedCache: DocCache = cache;
  for (const removed of cacheResult.removed) {
    updatedCache = removeDocCacheEntry(updatedCache, removed);
  }
  saveDocCache(cachePath, updatedCache);

  // Build pending generation cache entries — NOT saved until caller commits.
  // This prevents LLM failures from permanently suppressing page regeneration.
  let pendingCache = updatedCache;
  for (const pagePath of pagesToGenerate) {
    const mapping = pageMappings.find(m => m.pagePath === pagePath);
    if (!mapping) continue;

    const hashes: Record<string, string> = {};
    for (const sf of mapping.sourceFiles) {
      const hash = currentHashes.get(sf);
      if (hash) hashes[sf] = hash;
    }
    pendingCache = updateDocCacheEntry(pendingCache, pagePath, hashes);
  }

  const totalPages = cacheResult.fresh.length + allStaleOrAdded.length;

  return {
    cacheResult,
    pagesGenerated: pagesToGenerate.length,
    pagesDeferred,
    pagesRemoved: cacheResult.removed.length,
    totalPages,
    prompts,
    commitCache: () => {
      saveDocCache(cachePath, pendingCache);
    },
    rollbackPage: (pagePath: string) => {
      pendingCache = removeDocCacheEntry(pendingCache, pagePath);
    },
  };
}

// --- Internal helpers ---

/**
 * Builds {@link ModuleDir} entries from scanner tasks by grouping files per
 * directory. Each task is assigned to a directory via {@link extractModuleName},
 * and the LOC estimate for each file is derived from the maximum `line_end`
 * across its symbols.
 *
 * @param tasks - Scanner task list; each task represents a source file with
 *   its detected symbols.
 * @returns Array of module directories, each containing the directory name
 *   and its constituent files with estimated LOC.
 */
function buildModuleDirs(tasks: Task[]): ModuleDir[] {
  const dirMap = new Map<string, { name: string; loc: number }[]>();

  for (const task of tasks) {
    const dirName = extractModuleName(task.file);
    if (!dirName) continue;

    const parts = task.file.split('/');
    const fileName = parts[parts.length - 1];

    // Estimate LOC from symbol line ranges
    const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));

    const existing = dirMap.get(dirName) ?? [];
    existing.push({ name: fileName, loc: maxLine });
    dirMap.set(dirName, existing);
  }

  return Array.from(dirMap.entries()).map(([name, files]) => ({ name, files }));
}

/**
 * Builds {@link SourceDir} entries from scanner tasks for doc mapping.
 * Framework detection is now handled by the unified {@link ProjectProfile},
 * so `filePatterns` are no longer populated here. Each directory's `totalLoc`
 * is the sum of per-file LOC estimates (max `line_end` across symbols).
 *
 * @param tasks - Scanner task list; each task represents a source file with
 *   its detected symbols.
 * @returns Array of source directories with aggregated LOC totals, suitable
 *   for consumption by {@link resolveDocMappings}.
 */
function buildSourceDirs(tasks: Task[]): SourceDir[] {
  const dirMap = new Map<string, number>();

  for (const task of tasks) {
    const dirName = extractModuleName(task.file);
    if (!dirName) continue;

    const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));
    dirMap.set(dirName, (dirMap.get(dirName) ?? 0) + maxLine);
  }

  return Array.from(dirMap.entries()).map(([name, totalLoc]) => ({ name, totalLoc }));
}

/**
 * Builds page-to-source-file mappings for cache checking.
 *
 * For each doc mapping produced by the scaffold phase, collects the scanner
 * task files that belong to that source directory. Catch-all doc-mapping
 * entries are skipped when a module-granularity page already covers the same
 * module name to avoid duplicate pages. Scaffolded pages that have no source
 * mapping (e.g. Overview, Installation) are assigned `package.json` as their
 * synthetic source so the cache treats them as valid and never marks them
 * as removed.
 *
 * @param scaffoldResult - Output from {@link runDocScaffold} containing doc
 *   mappings, scaffold structure, and the list of all pages.
 * @param tasks - Scanner task list providing the source file inventory.
 * @returns Array of page mappings linking each doc page to its source files.
 */
function buildPageMappings(
  scaffoldResult: DocScaffoldResult,
  tasks: Task[],
): PageMapping[] {
  const mappings: PageMapping[] = [];

  // Build a set of module base-names already covered by module-granularity pages
  // (e.g. "05-Modules/02-core.md" → "core"). Doc-mapping catch-all entries that
  // target the same module name (e.g. "05-Modules/core.md") must be skipped to
  // avoid duplicate pages for the same source directory.
  const moduleGranularityNames = new Set<string>();
  for (const page of scaffoldResult.scaffoldResult.allPages) {
    if (page.startsWith('05-Modules/')) {
      // Strip section prefix + optional numeric prefix: "05-Modules/02-core.md" → "core"
      const filename = page.split('/').pop()!;
      const baseName = filename.replace(/^\d+-/, '').replace(/\.md$/, '');
      moduleGranularityNames.add(baseName);
    }
  }

  // For each doc mapping, find the source files that map to it
  for (const dm of scaffoldResult.docMappings) {
    // Skip catch-all doc-mapping entries that duplicate a module-granularity page
    if (dm.strategy === 'catch-all' && dm.docPage.startsWith('05-Modules/')) {
      const filename = dm.docPage.split('/').pop()!;
      const baseName = filename.replace(/\.md$/, '');
      if (moduleGranularityNames.has(baseName)) continue;
    }
    const sourceFiles = tasks
      .filter(t => extractModuleName(t.file) === dm.sourceDir)
      .map(t => t.file);

    if (sourceFiles.length > 0) {
      mappings.push({ pagePath: dm.docPage, sourceFiles });
    }
  }

  // Add all scaffolded pages (both newly created and existing) that have no source mapping.
  // These are base pages (Overview, Installation, Architecture, etc.) that describe the
  // project globally. They use an empty source list so they are only regenerated on
  // bootstrap or explicit `anatoly docs update` — never during incremental runs.
  for (const page of scaffoldResult.scaffoldResult.allPages) {
    if (page === 'index.md') continue;
    if (!mappings.some(m => m.pagePath === page)) {
      mappings.push({ pagePath: page, sourceFiles: [] });
    }
  }

  return mappings;
}

/**
 * Computes SHA-256 hashes for all source files referenced by page mappings.
 * Files are deduplicated before hashing so each file is read at most once.
 * Missing or unreadable files are silently skipped (e.g. recently deleted).
 *
 * @param projectRoot - Absolute path to the project root, used to resolve
 *   relative source file paths.
 * @param pageMappings - Page-to-source-file mappings from which the full set
 *   of source files is extracted.
 * @returns Map from relative source file path to its hex-encoded SHA-256 hash.
 */
function computeSourceHashes(
  projectRoot: string,
  pageMappings: PageMapping[],
): Map<string, string> {
  const hashes = new Map<string, string>();
  const allFiles = new Set<string>();

  for (const mapping of pageMappings) {
    for (const sf of mapping.sourceFiles) {
      allFiles.add(sf);
    }
  }

  for (const file of allFiles) {
    const fullPath = resolve(projectRoot, file);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');
      hashes.set(file, hash);
    } catch {
      // File may have been deleted — skip
    }
  }

  return hashes;
}

/**
 * Loads source files with their content for page context building.
 * Each returned {@link SourceFile} carries the file content and an empty
 * `symbols` array (symbol data is not needed at this stage). Unreadable
 * files are silently skipped.
 *
 * @param projectRoot - Absolute path to the project root, used to resolve
 *   relative file paths.
 * @param filePaths - Relative paths of source files to load.
 * @returns Array of loaded source files with their content.
 */
function loadSourceFiles(projectRoot: string, filePaths: string[]): SourceFile[] {
  const files: SourceFile[] = [];

  for (const filePath of filePaths) {
    const fullPath = resolve(projectRoot, filePath);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      files.push({ path: filePath, content, symbols: [] });
    } catch {
      // Skip unreadable files
    }
  }

  return files;
}

/**
 * Loads existing doc pages from the same section as context for cross-referencing.
 * Only includes pages that already have real content (not scaffold-only).
 * Scaffold-only pages are detected by the presence of a `<!-- SCAFFOLDING` marker
 * combined with fewer than 200 characters of non-comment, non-heading text.
 * The `index.md` page is always included for TOC awareness.
 *
 * @param outputDir - Absolute path to the `.anatoly/docs/` output directory
 *   where generated doc pages reside.
 * @param currentPage - Relative path of the page being generated (excluded
 *   from the neighbor list to avoid self-reference).
 * @param allPages - Complete list of scaffolded page paths to scan for
 *   same-section neighbors.
 * @returns Array of neighbor pages with their content, suitable for providing
 *   cross-reference context to the LLM prompt.
 */
function loadNeighborPages(outputDir: string, currentPage: string, allPages: string[]): DocNeighbor[] {
  const neighbors: DocNeighbor[] = [];
  const currentSection = currentPage.split('/')[0]; // e.g. "05-Modules"

  // Include index.md
  const indexPath = join(outputDir, 'index.md');
  if (existsSync(indexPath)) {
    neighbors.push({ path: 'index.md', content: readFileSync(indexPath, 'utf-8') });
  }

  // Include same-section pages that already have generated content
  for (const page of allPages) {
    if (page === currentPage || page === 'index.md') continue;
    const section = page.split('/')[0];
    if (section !== currentSection) continue;

    const fullPath = join(outputDir, page);
    if (!existsSync(fullPath)) continue;

    const content = readFileSync(fullPath, 'utf-8');
    // Skip scaffold-only pages (only have hints, no real content)
    if (content.includes('<!-- SCAFFOLDING') && content.replace(/<!--[\s\S]*?-->/g, '').replace(/^#+\s.*/gm, '').trim().length < 200) {
      continue;
    }
    neighbors.push({ path: page, content });
  }

  return neighbors;
}
