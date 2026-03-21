// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Language Detection & Framework Detection — Stories 31.1, 31.2
 *
 * Detects programming languages by file extension distribution
 * and frameworks by project configuration markers.
 */

import { readFileSync } from 'node:fs';
import { extname, basename, join } from 'node:path';
import { getGitTrackedFiles } from '../utils/git.js';

// --- Types ---

export interface LanguageInfo {
  name: string;
  percentage: number;
  fileCount: number;
}

export interface LanguageDistribution {
  languages: LanguageInfo[];
  totalFiles: number;
}

export interface FrameworkInfo {
  id: string;
  name: string;
  language: string;
}

export interface ProjectProfile {
  languages: LanguageDistribution;
  frameworks: FrameworkInfo[];
}

// --- Constants ---

/** Maps file extensions to canonical language names. */
export const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.cs': 'C#',
  '.sql': 'SQL',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.json': 'JSON',
};

/** Maps specific filenames (no extension) to language names. */
export const FILENAME_MAP: Record<string, string> = {
  Dockerfile: 'Docker',
  Makefile: 'Makefile',
  Jenkinsfile: 'Groovy',
};

/** Standard vendor/build directories excluded from language detection. */
export const DEFAULT_EXCLUDES: string[] = [
  'node_modules/',
  'dist/',
  'venv/',
  '.venv/',
  '__pycache__/',
  'target/',
  'bin/',
  'obj/',
];

// --- Framework registry ---

interface FrameworkDef {
  id: string;
  name: string;
  language: string;
  deps: string[];
  suppresses?: string[];
}

const JS_FRAMEWORKS: FrameworkDef[] = [
  { id: 'nextjs', name: 'Next.js', language: 'typescript', deps: ['next'], suppresses: ['react'] },
  { id: 'nuxt', name: 'Nuxt', language: 'typescript', deps: ['nuxt'], suppresses: ['vue'] },
  { id: 'nestjs', name: 'NestJS', language: 'typescript', deps: ['@nestjs/core'] },
  { id: 'react', name: 'React', language: 'typescript', deps: ['react'] },
  { id: 'vue', name: 'Vue', language: 'typescript', deps: ['vue'] },
  { id: 'angular', name: 'Angular', language: 'typescript', deps: ['@angular/core'] },
  { id: 'svelte', name: 'Svelte', language: 'typescript', deps: ['svelte'] },
  { id: 'express', name: 'Express', language: 'typescript', deps: ['express'] },
  { id: 'fastify', name: 'Fastify', language: 'typescript', deps: ['fastify'] },
  { id: 'hono', name: 'Hono', language: 'typescript', deps: ['hono'] },
  { id: 'prisma', name: 'Prisma', language: 'typescript', deps: ['prisma', '@prisma/client'] },
  { id: 'drizzle', name: 'Drizzle', language: 'typescript', deps: ['drizzle-orm'] },
];

const PY_FRAMEWORKS: FrameworkDef[] = [
  { id: 'django', name: 'Django', language: 'python', deps: ['django'] },
  { id: 'fastapi', name: 'FastAPI', language: 'python', deps: ['fastapi'] },
  { id: 'flask', name: 'Flask', language: 'python', deps: ['flask'] },
];

const RUST_FRAMEWORKS: FrameworkDef[] = [
  { id: 'actix', name: 'Actix Web', language: 'rust', deps: ['actix-web'] },
  { id: 'rocket', name: 'Rocket', language: 'rust', deps: ['rocket'] },
  { id: 'axum', name: 'Axum', language: 'rust', deps: ['axum'] },
];

const GO_FRAMEWORKS: FrameworkDef[] = [
  { id: 'gin', name: 'Gin', language: 'go', deps: ['github.com/gin-gonic/gin'] },
  { id: 'echo', name: 'Echo', language: 'go', deps: ['github.com/labstack/echo'] },
  { id: 'fiber', name: 'Fiber', language: 'go', deps: ['github.com/gofiber/fiber'] },
];

const CSHARP_FRAMEWORKS: FrameworkDef[] = [
  { id: 'aspnet', name: 'ASP.NET', language: 'csharp', deps: ['Microsoft.AspNetCore'] },
];

const JAVA_FRAMEWORKS: FrameworkDef[] = [
  { id: 'spring', name: 'Spring', language: 'java', deps: ['org.springframework'] },
];

const NEXT_CONFIG_PATTERNS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];

// --- Public API ---

/**
 * Classify a file path to its programming language.
 * Returns null if the language is not recognized.
 */
export function classifyFile(filePath: string): string | null {
  const ext = extname(filePath);
  if (ext && EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }
  const name = basename(filePath);
  return FILENAME_MAP[name] ?? null;
}

/**
 * Build a language distribution from a list of file paths.
 * Filters out languages below 1% of total files.
 */
export function buildDistribution(files: string[]): LanguageDistribution {
  const counts = new Map<string, number>();
  for (const file of files) {
    const lang = classifyFile(file);
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }

  const rawTotal = Array.from(counts.values()).reduce((sum, c) => sum + c, 0);
  if (rawTotal === 0) {
    return { languages: [], totalFiles: 0 };
  }

  // Filter out languages below 1% threshold (raw percentage before rounding)
  const filtered = Array.from(counts.entries()).filter(
    ([, count]) => count / rawTotal >= 0.01,
  );

  // Recalculate totalFiles from remaining languages
  const totalFiles = filtered.reduce((sum, [, count]) => sum + count, 0);

  const languages: LanguageInfo[] = filtered
    .map(([name, fileCount]) => ({
      name,
      percentage: Math.round((fileCount / totalFiles) * 100),
      fileCount,
    }))
    .sort((a, b) => b.percentage - a.percentage || a.name.localeCompare(b.name));

  return { languages, totalFiles };
}

/**
 * Detect programming languages in a project by scanning git-tracked file extensions.
 * Excludes standard vendor/build directories.
 */
export function detectLanguages(
  projectRoot: string,
  excludes?: string[],
): LanguageDistribution {
  const gitFiles = getGitTrackedFiles(projectRoot);
  if (!gitFiles) {
    return { languages: [], totalFiles: 0 };
  }

  const allExcludes = [...DEFAULT_EXCLUDES, ...(excludes ?? [])];
  const filteredFiles = Array.from(gitFiles).filter(
    (filePath) => !isExcluded(filePath, allExcludes),
  );

  return buildDistribution(filteredFiles);
}

/**
 * Detect project profile: languages + frameworks.
 * Calls detectLanguages() then reads config files for detected languages.
 */
export function detectProjectProfile(projectRoot: string): ProjectProfile {
  const gitFiles = getGitTrackedFiles(projectRoot);
  const filteredFiles = gitFiles
    ? Array.from(gitFiles).filter((f) => !isExcluded(f, DEFAULT_EXCLUDES))
    : [];
  const languages = buildDistribution(filteredFiles);
  const frameworks = detectFrameworks(projectRoot, languages, gitFiles);
  return { languages, frameworks };
}

/**
 * Format language distribution for CLI display.
 * Returns "TypeScript 85% · Shell 10%" or "" if empty.
 */
export function formatLanguageLine(languages: LanguageInfo[]): string {
  return languages.map((l) => `${l.name} ${l.percentage}%`).join(' \u00b7 ');
}

/**
 * Format detected frameworks for CLI display.
 * Returns "Next.js · Prisma" or "" if empty.
 */
export function formatFrameworkLine(frameworks: FrameworkInfo[]): string {
  return frameworks.map((f) => f.name).join(' \u00b7 ');
}

// --- Internal helpers ---

function isExcluded(filePath: string, excludes: string[]): boolean {
  const segments = filePath.split('/');
  return excludes.some((excl) => {
    const dir = excl.endsWith('/') ? excl.slice(0, -1) : excl;
    return segments.includes(dir);
  });
}

function detectFrameworks(
  projectRoot: string,
  languages: LanguageDistribution,
  gitFiles: Set<string> | null,
): FrameworkInfo[] {
  const langNames = new Set(languages.languages.map((l) => l.name));
  const detected: FrameworkInfo[] = [];

  // JS/TS frameworks from package.json
  if (langNames.has('TypeScript') || langNames.has('JavaScript')) {
    const pkgJson = safeReadJson(join(projectRoot, 'package.json'));
    if (pkgJson) {
      const deps = collectDependencyNames(pkgJson);
      for (const fw of JS_FRAMEWORKS) {
        if (fw.deps.some((d) => deps.has(d))) {
          detected.push({ id: fw.id, name: fw.name, language: fw.language });
        }
      }
    }
    // AC 31.2.3: next.config.* at root
    if (!detected.some((f) => f.id === 'nextjs') && gitFiles) {
      const hasNextConfig = NEXT_CONFIG_PATTERNS.some((name) =>
        gitFiles.has(name),
      );
      if (hasNextConfig) {
        detected.push({ id: 'nextjs', name: 'Next.js', language: 'typescript' });
      }
    }
  }

  // Python frameworks from requirements.txt / pyproject.toml
  if (langNames.has('Python')) {
    const reqContent = safeReadFile(join(projectRoot, 'requirements.txt'));
    const pyprojectContent = safeReadFile(join(projectRoot, 'pyproject.toml'));
    for (const fw of PY_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(reqContent, d) || containsDep(pyprojectContent, d))) {
        detected.push({ id: fw.id, name: fw.name, language: fw.language });
      }
    }
  }

  // Rust frameworks from Cargo.toml
  if (langNames.has('Rust')) {
    const cargoContent = safeReadFile(join(projectRoot, 'Cargo.toml'));
    for (const fw of RUST_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(cargoContent, d))) {
        detected.push({ id: fw.id, name: fw.name, language: fw.language });
      }
    }
  }

  // Go frameworks from go.mod
  if (langNames.has('Go')) {
    const goModContent = safeReadFile(join(projectRoot, 'go.mod'));
    for (const fw of GO_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(goModContent, d))) {
        detected.push({ id: fw.id, name: fw.name, language: fw.language });
      }
    }
  }

  // C# frameworks from *.csproj
  if (langNames.has('C#') && gitFiles) {
    const csprojFile = Array.from(gitFiles).find((f) => f.endsWith('.csproj'));
    if (csprojFile) {
      const content = safeReadFile(join(projectRoot, csprojFile));
      for (const fw of CSHARP_FRAMEWORKS) {
        if (fw.deps.some((d) => containsDep(content, d))) {
          detected.push({ id: fw.id, name: fw.name, language: fw.language });
        }
      }
    }
  }

  // Java frameworks from pom.xml
  if (langNames.has('Java')) {
    const pomContent = safeReadFile(join(projectRoot, 'pom.xml'));
    for (const fw of JAVA_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(pomContent, d))) {
        detected.push({ id: fw.id, name: fw.name, language: fw.language });
      }
    }
  }

  return applySuppression(detected);
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function safeReadJson(path: string): Record<string, unknown> | null {
  const content = safeReadFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectDependencyNames(pkgJson: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkgJson[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return names;
}

function containsDep(content: string | null, dep: string): boolean {
  if (!content) return false;
  return content.includes(dep);
}

function applySuppression(detected: FrameworkInfo[]): FrameworkInfo[] {
  const detectedIds = new Set(detected.map((f) => f.id));
  const suppressed = new Set<string>();

  for (const fw of JS_FRAMEWORKS) {
    if (fw.suppresses && detectedIds.has(fw.id)) {
      for (const s of fw.suppresses) {
        suppressed.add(s);
      }
    }
  }

  return detected.filter((f) => !suppressed.has(f.id));
}
