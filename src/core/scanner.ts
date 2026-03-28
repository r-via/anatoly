// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { glob } from 'tinyglobby';
import { Parser, Language } from 'web-tree-sitter';
import type { Config } from '../schemas/config.js';
import type { Task, SymbolInfo, CoverageData } from '../schemas/task.js';
import type { Progress, FileProgress } from '../schemas/progress.js';
import { computeFileHash, toOutputName, atomicWriteJson, readProgress } from '../utils/cache.js';
import { getGitTrackedFiles } from '../utils/git.js';
import { detectLanguages, detectProjectProfile, classifyFile } from './language-detect.js';
import type { FrameworkInfo } from './language-detect.js';
import { autoDetectGlobs } from './auto-detect.js';
import { resolveAdapter, heuristicParse, type ImportRef } from './language-adapters.js';
import { contextLogger } from '../utils/log-context.js';

const esmRequire = createRequire(import.meta.url);

let parserInstance: Parser | null = null;
const languageCache = new Map<string, Language>();

function getWasmCacheDir(): string {
  return join(homedir(), '.cache', 'anatoly', 'wasm');
}

async function getParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  await Parser.init();
  parserInstance = new Parser();
  return parserInstance;
}

/**
 * Resolve a WASM grammar file path, downloading from npm (via unpkg) if not
 * already installed or cached locally.
 *
 * @param wasmModule - npm-style path like "tree-sitter-bash/tree-sitter-bash.wasm"
 */
async function resolveWasmPath(wasmModule: string): Promise<string> {
  const log = contextLogger();
  const wasmFile = wasmModule.split('/').pop()!;

  // 1. Try bundled package (e.g. tree-sitter-typescript shipped with anatoly)
  try {
    const resolved = esmRequire.resolve(wasmModule);
    log.debug({ grammar: wasmFile, source: 'bundled' }, 'Loaded tree-sitter grammar');
    return resolved;
  } catch {
    // not bundled, continue
  }

  // 2. Check local cache
  const cacheDir = getWasmCacheDir();
  const cachedPath = join(cacheDir, wasmFile);
  if (existsSync(cachedPath)) {
    log.debug({ grammar: wasmFile, source: 'cache' }, 'Loaded tree-sitter grammar');
    return cachedPath;
  }

  // 3. Download from npm package via unpkg CDN
  const url = `https://unpkg.com/${wasmModule}`;
  process.stderr.write(`[scan] Downloading grammar: ${wasmFile} …\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachedPath, buffer);
  process.stderr.write(`[scan] Cached grammar: ${wasmFile} (${(buffer.length / 1024).toFixed(0)} KB)\n`);
  return cachedPath;
}

async function loadLanguage(wasmModule: string): Promise<Language> {
  const cached = languageCache.get(wasmModule);
  if (cached) return cached;
  const wasmPath = await resolveWasmPath(wasmModule);
  const lang = await Language.load(wasmPath);
  languageCache.set(wasmModule, lang);
  return lang;
}

export interface ParseResult {
  symbols: SymbolInfo[];
  imports: ImportRef[];
}

/**
 * Parse a source file and extract symbols + imports using the appropriate language adapter.
 * Falls back to heuristic parsing for files with no registered adapter or
 * when grammar loading fails (e.g. network offline).
 *
 * @param filePath - Relative file path used to determine the language adapter
 *                   via its extension.
 * @param source - Raw source code content of the file.
 * @returns Extracted symbols and imports; empty arrays if parsing fails entirely.
 */
export async function parseFile(
  filePath: string,
  source: string,
): Promise<ParseResult> {
  const ext = extname(filePath);
  const adapter = resolveAdapter(ext);

  if (!adapter) {
    return { symbols: heuristicParse(source, filePath), imports: [] };
  }

  // Adapters without a WASM module (e.g. JSON, YAML) use heuristic extraction only
  if (!adapter.wasmModule) {
    return { symbols: heuristicParse(source, filePath), imports: adapter.extractImports(source) };
  }

  const parser = await getParser();
  let lang: Language;
  try {
    lang = await loadLanguage(adapter.wasmModule);
  } catch {
    // Grammar unavailable (download failed, network offline) — fall back to heuristic
    return { symbols: heuristicParse(source, filePath), imports: adapter.extractImports(source) };
  }
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return { symbols: [], imports: [] };

  const symbols = adapter.extractSymbols(tree.rootNode);
  const imports = adapter.extractImportsFromAst
    ? adapter.extractImportsFromAst(tree.rootNode)
    : adapter.extractImports(source);

  return { symbols, imports };
}

/**
 * Resolve the primary framework for a file based on its language and the project profile.
 * TypeScript files also match JavaScript-ecosystem frameworks (Next.js, Express, etc.).
 *
 * @param _filePath - Relative path of the file (reserved for future per-file overrides).
 * @param language - Detected language name (e.g. "TypeScript"), or null if unknown.
 * @param frameworks - Framework descriptors from the project profile.
 * @returns The matched framework id (e.g. "nextjs"), or undefined if none matches.
 */
function resolveFramework(
  _filePath: string,
  language: string | null,
  frameworks: FrameworkInfo[],
): string | undefined {
  if (!language || frameworks.length === 0) return undefined;
  // TypeScript files belong to the JavaScript ecosystem
  const matchLangs = language === 'TypeScript' ? ['TypeScript', 'JavaScript'] : [language];
  const match = frameworks.find((f) => matchLangs.includes(f.language));
  return match?.id;
}

/**
 * Collect files matching the config patterns.
 * When `scan.auto_detect` is true (default), auto-detected language globs
 * are merged with configured patterns so multi-language projects are scanned
 * without manual configuration.
 * Filters out files ignored by .gitignore when inside a git repo.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Resolved project configuration with scan include/exclude patterns.
 * @returns Deduplicated, sorted array of relative file paths matching the patterns.
 */
export async function collectFiles(
  projectRoot: string,
  config: Config,
): Promise<string[]> {
  let includePatterns = config.scan.include;
  let excludePatterns = config.scan.exclude;

  if (config.scan.auto_detect) {
    const distribution = detectLanguages(projectRoot);
    const auto = autoDetectGlobs(distribution.languages);
    if (auto.include.length > 0) {
      includePatterns = [...new Set([...includePatterns, ...auto.include])];
    }
    if (auto.exclude.length > 0) {
      excludePatterns = [...new Set([...excludePatterns, ...auto.exclude])];
    }
  }

  const files: string[] = [];

  const matched = await glob(includePatterns, {
    cwd: projectRoot,
    ignore: excludePatterns,
  });
  files.push(...matched);

  // Filter out .gitignore'd files
  const tracked = getGitTrackedFiles(projectRoot);
  const filtered = tracked
    ? files.filter((f) => tracked.has(f))
    : files;

  // Deduplicate and sort for deterministic output
  const result = [...new Set(filtered)].sort();
  const excluded = files.length - result.length;
  contextLogger().debug(
    { matched: files.length, excluded, final: result.length },
    'collectFiles complete',
  );
  return result;
}

/**
 * Istanbul coverage JSON per-file entry.
 * Keys in `s`, `f`, `b` are string indices; values are hit counts.
 */
interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, unknown>;
  s: Record<string, number>;
  fnMap: Record<string, unknown>;
  f: Record<string, number>;
  branchMap: Record<string, unknown>;
  b: Record<string, number[]>;
}

type IstanbulCoverageMap = Record<string, IstanbulFileCoverage>;

/**
 * Load Istanbul/Vitest/Jest coverage-final.json and return a map
 * from relative file paths to CoverageData.
 * Returns null if coverage is disabled, file is missing, or unreadable.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Resolved project configuration with coverage settings.
 * @returns Map of relative file paths to aggregated coverage metrics, or null
 *          when coverage is disabled, the report file is missing, or JSON is malformed.
 */
export function loadCoverage(
  projectRoot: string,
  config: Config,
): Map<string, CoverageData> | null {
  if (!config.coverage.enabled) return null;

  const coveragePath = resolve(projectRoot, config.coverage.report_path);
  if (!existsSync(coveragePath)) return null;

  let raw: IstanbulCoverageMap;
  try {
    raw = JSON.parse(readFileSync(coveragePath, 'utf-8')) as IstanbulCoverageMap;
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const coverageMap = new Map<string, CoverageData>();

  for (const [key, entry] of Object.entries(raw)) {
    // Normalize path to be relative to projectRoot
    const filePath = entry.path ?? key;
    const relPath = filePath.startsWith('/')
      ? relative(projectRoot, filePath)
      : filePath;

    const statementsTotal = Object.keys(entry.s ?? {}).length;
    const statementsCovered = Object.values(entry.s ?? {}).filter(
      (v) => v > 0,
    ).length;

    const functionsTotal = Object.keys(entry.f ?? {}).length;
    const functionsCovered = Object.values(entry.f ?? {}).filter(
      (v) => v > 0,
    ).length;

    const branchEntries = Object.values(entry.b ?? {});
    const branchesTotal = branchEntries.reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    const branchesCovered = branchEntries.reduce(
      (sum, arr) => sum + arr.filter((v) => v > 0).length,
      0,
    );

    // Lines: count unique line numbers from statementMap
    const lineSet = new Set<number>();
    const coveredLineSet = new Set<number>();
    for (const [stmtKey, loc] of Object.entries(entry.statementMap ?? {})) {
      const locObj = loc as { start: { line: number }; end: { line: number } };
      for (let l = locObj.start.line; l <= locObj.end.line; l++) {
        lineSet.add(l);
        if (((entry.s ?? {})[stmtKey] ?? 0) > 0) {
          coveredLineSet.add(l);
        }
      }
    }

    coverageMap.set(relPath, {
      statements_total: statementsTotal,
      statements_covered: statementsCovered,
      branches_total: branchesTotal,
      branches_covered: branchesCovered,
      functions_total: functionsTotal,
      functions_covered: functionsCovered,
      lines_total: lineSet.size,
      lines_covered: coveredLineSet.size,
    });
  }

  return coverageMap;
}

export interface ScannedFileInfo {
  file: string;
  hash: string;
  symbolCount: number;
}

export interface ScanResult {
  filesScanned: number;
  filesCached: number;
  filesNew: number;
  /** Per-file info for structured logging (file_discovered events) */
  files?: ScannedFileInfo[];
}

/**
 * Scan the project: collect files, parse each via AST or heuristic extraction,
 * compute content hashes, generate per-file `.task.json`, and update the
 * central `progress.json` cache.
 *
 * Files whose hash and evaluated axes are unchanged since the last run are
 * marked CACHED and skipped, avoiding redundant parsing.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Resolved project configuration (scan patterns, coverage settings, etc.).
 * @param requestedAxes - When provided, a cached file is only reused if every
 *                        requested axis was already evaluated in the previous run.
 * @returns Summary counts (scanned, cached, new) and optional per-file detail.
 */
export async function scanProject(
  projectRoot: string,
  config: Config,
  requestedAxes?: string[],
): Promise<ScanResult> {
  const anatolyDir = resolve(projectRoot, '.anatoly');
  const tasksDir = join(anatolyDir, 'tasks');
  const progressPath = join(anatolyDir, 'cache', 'progress.json');

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(anatolyDir, 'cache'), { recursive: true });

  // Load existing progress
  const existingProgress = readProgress(progressPath);
  const now = new Date().toISOString();

  const progress: Progress = {
    version: 1,
    started_at: existingProgress?.started_at ?? now,
    files: {},
  };

  const files = await collectFiles(projectRoot, config);
  const coverageMap = loadCoverage(projectRoot, config);
  const profile = detectProjectProfile(projectRoot);
  const scannedFiles: ScannedFileInfo[] = [];
  let filesCached = 0;
  let filesNew = 0;
  let astErrors = 0;

  for (const relPath of files) {
    const absPath = resolve(projectRoot, relPath);
    const hash = computeFileHash(absPath);

    // Check if file is unchanged (CACHED)
    const existing = existingProgress?.files[relPath];
    const axesCovered = !requestedAxes ||
      (existing?.axes && requestedAxes.every((a) => existing.axes!.includes(a)));
    if (
      existing &&
      existing.hash === hash &&
      (existing.status === 'DONE' || existing.status === 'CACHED') &&
      axesCovered
    ) {
      progress.files[relPath] = {
        file: relPath,
        hash,
        status: 'CACHED',
        updated_at: now,
        axes: existing.axes,
      };
      scannedFiles.push({ file: relPath, hash, symbolCount: 0 });
      filesCached++;
      continue;
    }

    // Parse and generate task
    const source = readFileSync(absPath, 'utf-8');
    const ext = extname(relPath);
    const adapter = resolveAdapter(ext);
    const parseMethod = adapter?.wasmModule ? 'ast' : 'heuristic';
    const detectedLang = classifyFile(relPath);

    let symbols: SymbolInfo[];
    let imports: ImportRef[] = [];
    try {
      const result = await parseFile(relPath, source);
      symbols = result.symbols;
      imports = result.imports;
    } catch (err) {
      contextLogger().warn({ file: relPath, err }, 'AST parse error, skipping symbols');
      symbols = [];
      astErrors++;
    }

    const task: Task = {
      version: 1,
      file: relPath,
      hash,
      symbols,
      ...(imports.length > 0 ? { imports } : {}),
      language: detectedLang?.toLowerCase() ?? 'unknown',
      parse_method: parseMethod as 'ast' | 'heuristic',
      scanned_at: now,
    };

    // Attach framework from project profile
    const fw = resolveFramework(relPath, detectedLang, profile.frameworks);
    if (fw) task.framework = fw;

    // Attach coverage data if available
    const fileCoverage = coverageMap?.get(relPath);
    if (fileCoverage) {
      task.coverage = fileCoverage;
    }

    const taskFileName = `${toOutputName(relPath)}.task.json`;
    atomicWriteJson(join(tasksDir, taskFileName), task);

    progress.files[relPath] = {
      file: relPath,
      hash,
      status: 'PENDING',
      updated_at: now,
    } satisfies FileProgress;

    scannedFiles.push({ file: relPath, hash, symbolCount: symbols.length });
    filesNew++;
  }

  // Write progress atomically
  atomicWriteJson(progressPath, progress);

  contextLogger().debug(
    { filesScanned: files.length, filesCached, filesNew, astErrors },
    'scan summary',
  );

  return {
    filesScanned: files.length,
    filesCached,
    filesNew,
    files: scannedFiles,
  };
}
