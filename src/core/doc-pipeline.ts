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
 *    detectProjectTypes → resolveModuleGranularity → resolveDocMappings → scaffoldDocs
 *
 * 2. runDocGeneration() — called between setup and review
 *    loadDocCache → checkDocCache → build contexts → LLM generate → save cache
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectProjectTypes, type ProjectType } from './project-type-detector.js';
import { scaffoldDocs, type ScaffoldResult } from './doc-scaffolder.js';
import { resolveModuleGranularity, type ModuleDir } from './module-granularity.js';
import { resolveDocMappings, type SourceDir, type DocMapping } from './doc-mapping.js';
import { assertSafeOutputPath } from './docs-guard.js';
import { loadDocCache, saveDocCache, checkDocCache, updateDocCacheEntry, removeDocCacheEntry, type DocCache, type PageMapping, type CacheResult } from './doc-cache.js';
import { buildPageContext, type SourceFile } from './source-context.js';
import { buildPagePrompt, type PageInfo, type PagePrompt } from './doc-generator.js';
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
  pagesRemoved: number;
  totalPages: number;
  prompts: PagePrompt[];
}

export interface DocPipelineResult {
  scaffold: DocScaffoldResult;
  generation?: DocGenerationResult;
}

// --- Scaffold phase ---

/**
 * Runs the doc scaffolding phase:
 * 1. Detects project types from package.json
 * 2. Resolves module granularity from scanner tasks
 * 3. Resolves code→doc mappings
 * 4. Scaffolds .anatoly/docs/ with guard
 */
export function runDocScaffold(
  projectRoot: string,
  packageJson: Record<string, unknown>,
  tasks: Task[],
  docsPath = 'docs',
): DocScaffoldResult {
  const outputDir = resolve(projectRoot, '.anatoly', 'docs');

  // Guard: never write to docs/
  assertSafeOutputPath(outputDir, projectRoot, docsPath);

  // 1. Detect project types
  const projectTypes = detectProjectTypes(packageJson);

  // 2. Resolve module granularity from task data
  const moduleDirs = buildModuleDirs(tasks);
  const modulePages = resolveModuleGranularity(moduleDirs);

  // 3. Resolve code→doc mappings
  const sourceDirs = buildSourceDirs(tasks, projectRoot);
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
 */
export function runDocGeneration(
  projectRoot: string,
  scaffoldResult: DocScaffoldResult,
  tasks: Task[],
  packageJson: Record<string, unknown>,
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

  // Build prompts for stale + added pages
  const prompts: PagePrompt[] = [];
  const pagesToGenerate = [...cacheResult.stale, ...cacheResult.added];

  for (const pagePath of pagesToGenerate) {
    const mapping = pageMappings.find(m => m.pagePath === pagePath);
    if (!mapping) continue;

    const sourceFiles = loadSourceFiles(projectRoot, mapping.sourceFiles);
    const pageContext = buildPageContext(pagePath, sourceFiles);
    const pageInfo: PageInfo = {
      path: pagePath,
      title: pagePath.split('/').pop()?.replace('.md', '') ?? pagePath,
      description: `Documentation for ${pagePath}`,
    };
    const allPages = pageMappings.map(m => m.pagePath);
    const prompt = buildPagePrompt(pageInfo, pageContext, packageJson, { allPages });
    prompts.push(prompt);
  }

  // Remove deleted pages (with traversal guard)
  for (const removed of cacheResult.removed) {
    const fullPath = resolve(outputDir, removed);
    if (!fullPath.startsWith(resolve(outputDir))) continue;
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }

  // Update cache: remove deleted entries
  let updatedCache: DocCache = cache;
  for (const removed of cacheResult.removed) {
    updatedCache = removeDocCacheEntry(updatedCache, removed);
  }

  // Update cache: add/refresh entries for pages that will be generated
  for (const pagePath of pagesToGenerate) {
    const mapping = pageMappings.find(m => m.pagePath === pagePath);
    if (!mapping) continue;

    const hashes: Record<string, string> = {};
    for (const sf of mapping.sourceFiles) {
      const hash = currentHashes.get(sf);
      if (hash) hashes[sf] = hash;
    }
    updatedCache = updateDocCacheEntry(updatedCache, pagePath, hashes);
  }

  // Save cache
  saveDocCache(cachePath, updatedCache);

  const totalPages = cacheResult.fresh.length + pagesToGenerate.length;

  return {
    cacheResult,
    pagesGenerated: pagesToGenerate.length,
    pagesRemoved: cacheResult.removed.length,
    totalPages,
    prompts,
  };
}

// --- Internal helpers ---

/**
 * Builds ModuleDir[] from scanner tasks by grouping files by directory.
 */
function buildModuleDirs(tasks: Task[]): ModuleDir[] {
  const dirMap = new Map<string, { name: string; loc: number }[]>();

  for (const task of tasks) {
    const parts = task.file.split('/');
    if (parts.length < 2) continue;

    // Use the first directory under src/ (or the first directory if no src/)
    const srcIdx = parts.indexOf('src');
    const dirIdx = srcIdx >= 0 ? srcIdx + 1 : 0;
    if (dirIdx >= parts.length - 1) continue;

    const dirName = parts[dirIdx];
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
 * Builds SourceDir[] from scanner tasks for doc mapping.
 * Populates filePatterns by scanning file content for framework markers
 * so that the framework detection strategy in resolveDocMappings is reachable.
 */
function buildSourceDirs(tasks: Task[], projectRoot: string): SourceDir[] {
  const dirMap = new Map<string, { totalLoc: number; files: string[] }>();

  for (const task of tasks) {
    const parts = task.file.split('/');
    if (parts.length < 2) continue;

    const srcIdx = parts.indexOf('src');
    const dirIdx = srcIdx >= 0 ? srcIdx + 1 : 0;
    if (dirIdx >= parts.length - 1) continue;

    const dirName = parts[dirIdx];
    const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));

    const existing = dirMap.get(dirName) ?? { totalLoc: 0, files: [] };
    existing.totalLoc += maxLine;
    existing.files.push(task.file);
    dirMap.set(dirName, existing);
  }

  return Array.from(dirMap.entries()).map(([name, { totalLoc, files }]) => {
    const dir: SourceDir = { name, totalLoc };
    const patterns = detectFilePatterns(projectRoot, files);
    if (patterns.length > 0) dir.filePatterns = patterns;
    return dir;
  });
}

const DETECTABLE_PATTERNS = ['@Controller()', 'express.Router()', '@Injectable()'];

/**
 * Scans file content for known framework patterns (decorators, router calls).
 * Short-circuits once all patterns are found.
 */
function detectFilePatterns(projectRoot: string, files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    try {
      const content = readFileSync(resolve(projectRoot, file), 'utf-8');
      for (const pattern of DETECTABLE_PATTERNS) {
        if (content.includes(pattern)) found.add(pattern);
      }
    } catch {
      // Skip unreadable files
    }
    if (found.size === DETECTABLE_PATTERNS.length) break;
  }
  return Array.from(found);
}

/**
 * Builds page-to-source-file mappings for cache checking.
 */
function buildPageMappings(
  scaffoldResult: DocScaffoldResult,
  tasks: Task[],
): PageMapping[] {
  const mappings: PageMapping[] = [];

  // For each doc mapping, find the source files that map to it
  for (const dm of scaffoldResult.docMappings) {
    const sourceFiles = tasks
      .filter(t => {
        const parts = t.file.split('/');
        const srcIdx = parts.indexOf('src');
        const dirIdx = srcIdx >= 0 ? srcIdx + 1 : 0;
        return dirIdx < parts.length - 1 && parts[dirIdx] === dm.sourceDir;
      })
      .map(t => t.file);

    if (sourceFiles.length > 0) {
      mappings.push({ pagePath: dm.docPage, sourceFiles });
    }
  }

  // Add all scaffolded pages (both newly created and existing) that have no source mapping.
  // These are base pages (Overview, Installation, Architecture, etc.) that describe the
  // project globally — use package.json as their source so they are cached and never
  // incorrectly removed by the cache's "removed" detection.
  for (const page of scaffoldResult.scaffoldResult.allPages) {
    if (page === 'index.md') continue;
    if (!mappings.some(m => m.pagePath === page)) {
      mappings.push({ pagePath: page, sourceFiles: ['package.json'] });
    }
  }

  return mappings;
}

/**
 * Computes SHA-256 hashes for all source files referenced by page mappings.
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
 * Loads source files with their content and symbols for page context building.
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
