// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { createRequire } from 'node:module';
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
import { resolveAdapter, heuristicParse } from './language-adapters.js';
import { contextLogger } from '../utils/log-context.js';

const esmRequire = createRequire(import.meta.url);

let parserInstance: Parser | null = null;
const languageCache = new Map<string, Language>();

async function getParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  await Parser.init();
  parserInstance = new Parser();
  return parserInstance;
}

async function loadLanguage(wasmModule: string): Promise<Language> {
  const cached = languageCache.get(wasmModule);
  if (cached) return cached;
  const wasmPath = esmRequire.resolve(wasmModule);
  const lang = await Language.load(wasmPath);
  languageCache.set(wasmModule, lang);
  return lang;
}

/**
 * Parse a source file and extract symbols using the appropriate language adapter.
 * Falls back to heuristic parsing for files with no registered adapter.
 */
export async function parseFile(
  filePath: string,
  source: string,
): Promise<SymbolInfo[]> {
  const ext = extname(filePath);
  const adapter = resolveAdapter(ext);

  if (!adapter) {
    return heuristicParse(source);
  }

  const parser = await getParser();
  const lang = await loadLanguage(adapter.wasmModule);
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return [];
  return adapter.extractSymbols(tree.rootNode);
}

/**
 * Resolve the primary framework for a file based on its language and the project profile.
 * TypeScript files also match JavaScript-ecosystem frameworks (Next.js, Express, etc.).
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
        if ((entry.s[stmtKey] ?? 0) > 0) {
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

export interface ScanResult {
  filesScanned: number;
  filesCached: number;
  filesNew: number;
}

/**
 * Scan the project: parse AST, compute hashes, generate .task.json, update progress.json.
 */
export async function scanProject(
  projectRoot: string,
  config: Config,
  /** When provided, the cache validates that all requested axes were previously evaluated */
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
      filesCached++;
      continue;
    }

    // Parse and generate task
    const source = readFileSync(absPath, 'utf-8');
    const ext = extname(relPath);
    const adapter = resolveAdapter(ext);
    const parseMethod = adapter ? 'ast' : 'heuristic';
    const detectedLang = classifyFile(relPath);

    let symbols: SymbolInfo[];
    try {
      symbols = await parseFile(relPath, source);
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
  };
}
