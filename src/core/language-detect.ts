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

export type ProjectType =
  | 'Frontend'
  | 'Backend API'
  | 'ORM'
  | 'CLI'
  | 'Library'
  | 'Monorepo';

export type FrameworkCategory =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'orm'
  | 'cli'
  | 'testing'
  | 'auth';

export type ProjectCapability =
  | 'rest-api'
  | 'graphql-api'
  | 'ssr'
  | 'spa'
  | 'orm'
  | 'cli'
  | 'monorepo'
  | 'auth'
  | 'testing'
  | 'containerized';

export interface FrameworkInfo {
  id: string;
  name: string;
  language: string;
  category: FrameworkCategory;
}

export interface ProjectProfile {
  languages: LanguageDistribution;
  frameworks: FrameworkInfo[];
  /** High-level project types derived from frameworks + manifest signals. */
  types: ProjectType[];
  /** Granular capabilities derived from frameworks + file presence. */
  capabilities: ProjectCapability[];
  /** Primary language (highest percentage). Null if no code files. */
  primaryLanguage: string | null;
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
  category: FrameworkCategory;
  deps: string[];
  configFiles?: string[];
  suppresses?: string[];
  impliesTypes: ProjectType[];
  impliesCapabilities: ProjectCapability[];
}

const JS_FRAMEWORKS: FrameworkDef[] = [
  { id: 'nextjs', name: 'Next.js', language: 'typescript', category: 'fullstack', deps: ['next'], suppresses: ['react'], impliesTypes: ['Frontend', 'Backend API'], impliesCapabilities: ['ssr', 'spa', 'rest-api'] },
  { id: 'nuxt', name: 'Nuxt', language: 'typescript', category: 'fullstack', deps: ['nuxt'], suppresses: ['vue'], impliesTypes: ['Frontend', 'Backend API'], impliesCapabilities: ['ssr', 'spa', 'rest-api'] },
  { id: 'nestjs', name: 'NestJS', language: 'typescript', category: 'backend', deps: ['@nestjs/core'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'react', name: 'React', language: 'typescript', category: 'frontend', deps: ['react'], impliesTypes: ['Frontend'], impliesCapabilities: ['spa'] },
  { id: 'vue', name: 'Vue', language: 'typescript', category: 'frontend', deps: ['vue'], impliesTypes: ['Frontend'], impliesCapabilities: ['spa'] },
  { id: 'angular', name: 'Angular', language: 'typescript', category: 'frontend', deps: ['@angular/core'], impliesTypes: ['Frontend'], impliesCapabilities: ['spa'] },
  { id: 'svelte', name: 'Svelte', language: 'typescript', category: 'frontend', deps: ['svelte'], impliesTypes: ['Frontend'], impliesCapabilities: ['spa'] },
  { id: 'solid', name: 'Solid.js', language: 'typescript', category: 'frontend', deps: ['solid-js'], impliesTypes: ['Frontend'], impliesCapabilities: ['spa'] },
  { id: 'express', name: 'Express', language: 'typescript', category: 'backend', deps: ['express'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'fastify', name: 'Fastify', language: 'typescript', category: 'backend', deps: ['fastify'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'hono', name: 'Hono', language: 'typescript', category: 'backend', deps: ['hono'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'koa', name: 'Koa', language: 'typescript', category: 'backend', deps: ['koa'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'hapi', name: 'Hapi', language: 'typescript', category: 'backend', deps: ['@hapi/hapi'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'prisma', name: 'Prisma', language: 'typescript', category: 'orm', deps: ['prisma', '@prisma/client'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'drizzle', name: 'Drizzle', language: 'typescript', category: 'orm', deps: ['drizzle-orm'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'typeorm', name: 'TypeORM', language: 'typescript', category: 'orm', deps: ['typeorm'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'sequelize', name: 'Sequelize', language: 'typescript', category: 'orm', deps: ['sequelize'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'knex', name: 'Knex', language: 'typescript', category: 'orm', deps: ['knex'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'mikro-orm', name: 'MikroORM', language: 'typescript', category: 'orm', deps: ['@mikro-orm/core'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'commander', name: 'Commander', language: 'typescript', category: 'cli', deps: ['commander'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'yargs', name: 'Yargs', language: 'typescript', category: 'cli', deps: ['yargs'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'clipanion', name: 'Clipanion', language: 'typescript', category: 'cli', deps: ['clipanion'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'cac', name: 'Cac', language: 'typescript', category: 'cli', deps: ['cac'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'vitest', name: 'Vitest', language: 'typescript', category: 'testing', deps: ['vitest'], impliesTypes: [], impliesCapabilities: ['testing'] },
  { id: 'jest', name: 'Jest', language: 'typescript', category: 'testing', deps: ['jest'], impliesTypes: [], impliesCapabilities: ['testing'] },
  { id: 'passport', name: 'Passport', language: 'typescript', category: 'auth', deps: ['passport'], impliesTypes: [], impliesCapabilities: ['auth'] },
];

const PY_FRAMEWORKS: FrameworkDef[] = [
  { id: 'django', name: 'Django', language: 'python', category: 'fullstack', deps: ['django'], impliesTypes: ['Frontend', 'Backend API'], impliesCapabilities: ['rest-api', 'ssr', 'orm'] },
  { id: 'fastapi', name: 'FastAPI', language: 'python', category: 'backend', deps: ['fastapi'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'flask', name: 'Flask', language: 'python', category: 'backend', deps: ['flask'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'sqlalchemy', name: 'SQLAlchemy', language: 'python', category: 'orm', deps: ['sqlalchemy', 'SQLAlchemy'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'click', name: 'Click', language: 'python', category: 'cli', deps: ['click'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'typer', name: 'Typer', language: 'python', category: 'cli', deps: ['typer'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
  { id: 'pytest', name: 'Pytest', language: 'python', category: 'testing', deps: ['pytest'], impliesTypes: [], impliesCapabilities: ['testing'] },
];

const RUST_FRAMEWORKS: FrameworkDef[] = [
  { id: 'actix', name: 'Actix Web', language: 'rust', category: 'backend', deps: ['actix-web'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'rocket', name: 'Rocket', language: 'rust', category: 'backend', deps: ['rocket'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'axum', name: 'Axum', language: 'rust', category: 'backend', deps: ['axum'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'diesel', name: 'Diesel', language: 'rust', category: 'orm', deps: ['diesel'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'sea-orm', name: 'SeaORM', language: 'rust', category: 'orm', deps: ['sea-orm'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'clap', name: 'Clap', language: 'rust', category: 'cli', deps: ['clap'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
];

const GO_FRAMEWORKS: FrameworkDef[] = [
  { id: 'gin', name: 'Gin', language: 'go', category: 'backend', deps: ['github.com/gin-gonic/gin'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'echo', name: 'Echo', language: 'go', category: 'backend', deps: ['github.com/labstack/echo'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'fiber', name: 'Fiber', language: 'go', category: 'backend', deps: ['github.com/gofiber/fiber'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'gorm', name: 'GORM', language: 'go', category: 'orm', deps: ['gorm.io/gorm'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'cobra', name: 'Cobra', language: 'go', category: 'cli', deps: ['github.com/spf13/cobra'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
];

const CSHARP_FRAMEWORKS: FrameworkDef[] = [
  { id: 'aspnet', name: 'ASP.NET', language: 'csharp', category: 'backend', deps: ['Microsoft.AspNetCore'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'ef-core', name: 'Entity Framework', language: 'csharp', category: 'orm', deps: ['Microsoft.EntityFrameworkCore'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
];

const JAVA_FRAMEWORKS: FrameworkDef[] = [
  { id: 'spring', name: 'Spring', language: 'java', category: 'fullstack', deps: ['org.springframework'], impliesTypes: ['Backend API'], impliesCapabilities: ['rest-api'] },
  { id: 'hibernate', name: 'Hibernate', language: 'java', category: 'orm', deps: ['org.hibernate'], impliesTypes: ['ORM'], impliesCapabilities: ['orm'] },
  { id: 'picocli', name: 'Picocli', language: 'java', category: 'cli', deps: ['picocli'], impliesTypes: ['CLI'], impliesCapabilities: ['cli'] },
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
  const types = deriveTypes(frameworks, projectRoot, gitFiles);
  const capabilities = deriveCapabilities(frameworks, gitFiles);
  const primaryLanguage = languages.languages.length > 0 ? languages.languages[0].name : null;
  return { languages, frameworks, types, capabilities, primaryLanguage };
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
          detected.push(toFrameworkInfo(fw));
        }
      }
    }
    // AC 31.2.3: next.config.* at root
    if (!detected.some((f) => f.id === 'nextjs') && gitFiles) {
      const hasNextConfig = NEXT_CONFIG_PATTERNS.some((name) =>
        gitFiles.has(name),
      );
      if (hasNextConfig) {
        detected.push(toFrameworkInfo(JS_FRAMEWORKS.find(f => f.id === 'nextjs')!));
      }
    }
  }

  // Python frameworks from requirements.txt / pyproject.toml
  if (langNames.has('Python')) {
    const reqContent = safeReadFile(join(projectRoot, 'requirements.txt'));
    const pyprojectContent = safeReadFile(join(projectRoot, 'pyproject.toml'));
    for (const fw of PY_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(reqContent, d) || containsDep(pyprojectContent, d))) {
        detected.push(toFrameworkInfo(fw));
      }
    }
  }

  // Rust frameworks from Cargo.toml
  if (langNames.has('Rust')) {
    const cargoContent = safeReadFile(join(projectRoot, 'Cargo.toml'));
    for (const fw of RUST_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(cargoContent, d))) {
        detected.push(toFrameworkInfo(fw));
      }
    }
  }

  // Go frameworks from go.mod
  if (langNames.has('Go')) {
    const goModContent = safeReadFile(join(projectRoot, 'go.mod'));
    for (const fw of GO_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(goModContent, d))) {
        detected.push(toFrameworkInfo(fw));
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
          detected.push(toFrameworkInfo(fw));
        }
      }
    }
  }

  // Java frameworks from pom.xml
  if (langNames.has('Java')) {
    const pomContent = safeReadFile(join(projectRoot, 'pom.xml'));
    for (const fw of JAVA_FRAMEWORKS) {
      if (fw.deps.some((d) => containsDep(pomContent, d))) {
        detected.push(toFrameworkInfo(fw));
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

function toFrameworkInfo(def: FrameworkDef): FrameworkInfo {
  return { id: def.id, name: def.name, language: def.language, category: def.category };
}

/** All framework registries for lookup during derivation. */
const ALL_FRAMEWORK_DEFS: FrameworkDef[] = [
  ...JS_FRAMEWORKS, ...PY_FRAMEWORKS, ...RUST_FRAMEWORKS,
  ...GO_FRAMEWORKS, ...CSHARP_FRAMEWORKS, ...JAVA_FRAMEWORKS,
];

function deriveTypes(
  frameworks: FrameworkInfo[],
  projectRoot: string,
  gitFiles: Set<string> | null,
): ProjectType[] {
  const types = new Set<ProjectType>();

  // From frameworks
  for (const fw of frameworks) {
    const def = ALL_FRAMEWORK_DEFS.find(d => d.id === fw.id);
    if (def) {
      for (const t of def.impliesTypes) types.add(t);
    }
  }

  // Monorepo from manifest
  const pkgJson = safeReadJson(join(projectRoot, 'package.json'));
  if (pkgJson) {
    const ws = pkgJson['workspaces'];
    if (ws != null && !(Array.isArray(ws) && ws.length === 0)) {
      types.add('Monorepo');
    }
    // CLI from bin field (even without a CLI framework)
    const bin = pkgJson['bin'];
    const hasBin = typeof bin === 'string' ? bin.length > 0 : (bin != null && typeof bin === 'object' && Object.keys(bin as Record<string, unknown>).length > 0);
    if (hasBin && !types.has('CLI')) {
      types.add('CLI');
    }
  }

  // Go CLI detection from main.go pattern
  if (gitFiles && !types.has('CLI')) {
    if (gitFiles.has('main.go') || gitFiles.has('cmd/main.go')) {
      // Only if no backend framework detected — bare Go binary is likely a CLI
      if (!types.has('Backend API')) types.add('CLI');
    }
  }

  // Fallback
  if (types.size === 0) types.add('Library');

  return Array.from(types);
}

function deriveCapabilities(
  frameworks: FrameworkInfo[],
  gitFiles: Set<string> | null,
): ProjectCapability[] {
  const caps = new Set<ProjectCapability>();

  // From frameworks
  for (const fw of frameworks) {
    const def = ALL_FRAMEWORK_DEFS.find(d => d.id === fw.id);
    if (def) {
      for (const c of def.impliesCapabilities) caps.add(c);
    }
  }

  // From file presence
  if (gitFiles) {
    if (gitFiles.has('Dockerfile') || gitFiles.has('docker-compose.yml') || gitFiles.has('docker-compose.yaml')) {
      caps.add('containerized');
    }
    for (const f of gitFiles) {
      if (f.endsWith('.graphql') || f === 'schema.graphql') {
        caps.add('graphql-api');
        break;
      }
    }
  }

  return Array.from(caps);
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
