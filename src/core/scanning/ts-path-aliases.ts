// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * A single compiled TypeScript path-alias rule.
 *
 * Built from one `compilerOptions.paths` entry. The matched specifier tail
 * (the part after `prefix`) is appended to each `targetBase` to form a
 * filesystem candidate, which the import resolver then resolves to a concrete
 * `.ts`/`.tsx`/`index.ts` file.
 */
export interface TsPathAlias {
  /** Literal text before the `*`. For non-wildcard aliases, the whole pattern. */
  prefix: string;
  /** Whether the pattern ended with a `*` wildcard. */
  wildcard: boolean;
  /**
   * Absolute target bases (already resolved against the defining config's
   * `baseUrl`). For wildcard rules each base is the directory prefix that
   * precedes the target `*`; the matched tail is appended. For non-wildcard
   * rules each base is the full target path.
   */
  targetBases: string[];
}

export type TsPathAliasMap = readonly TsPathAlias[];

/**
 * Detect TypeScript / Vite path aliases (e.g. `@/lib/api` → `client/src/lib/api`)
 * declared in the project's `tsconfig.json` (and the configs it extends or
 * references, plus the common `tsconfig.app.json` / `tsconfig.base.json` split
 * used by Vite scaffolds).
 *
 * Without this, alias imports are indistinguishable from bare node_modules
 * specifiers, so every symbol imported via `@/...` is wrongly reported as
 * having zero importers (DEAD). This is the dominant false-positive source for
 * the utility axis on any modern front-end project.
 *
 * Implemented with a tolerant JSONC scan rather than the TypeScript compiler
 * API: Anatoly has no `typescript` runtime dependency, and we only need
 * `compilerOptions.baseUrl` + `compilerOptions.paths`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Compiled alias rules (empty when none are declared).
 */
export function detectTsPathAliases(projectRoot: string): TsPathAlias[] {
  const rules: TsPathAlias[] = [];
  const seen = new Set<string>();

  for (const configPath of gatherConfigFiles(projectRoot)) {
    const parsed = readJsonc(configPath);
    if (!parsed) continue;

    const compilerOptions = isRecord(parsed['compilerOptions'])
      ? parsed['compilerOptions']
      : undefined;
    if (!compilerOptions) continue;

    const paths = isRecord(compilerOptions['paths'])
      ? compilerOptions['paths']
      : undefined;
    if (!paths) continue;

    // baseUrl is resolved relative to the directory of the config that
    // declares it (TS semantics). Defaults to that directory.
    const configDir = dirname(configPath);
    const baseUrl = typeof compilerOptions['baseUrl'] === 'string'
      ? compilerOptions['baseUrl']
      : '.';
    const baseDir = resolve(configDir, baseUrl);

    for (const [pattern, targetsValue] of Object.entries(paths)) {
      const targets = toStringArray(targetsValue);
      if (targets.length === 0) continue;

      const rule = compileAliasRule(pattern, targets, baseDir);
      if (!rule) continue;

      // Dedupe identical rules contributed by multiple configs.
      const dedupeKey = `${rule.prefix}|${rule.wildcard}|${rule.targetBases.join(',')}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rules.push(rule);
    }
  }

  return rules;
}

/**
 * Resolve an import specifier against the alias rules to an absolute base path
 * (no extension), or null when no rule matches. The caller is responsible for
 * resolving the base to a concrete `.ts`/`.tsx`/`index.ts` file.
 *
 * The first rule whose prefix matches wins, mirroring TypeScript's
 * first-match-by-declaration-order behaviour closely enough for usage
 * tracking. Returns every candidate base so the resolver can probe each.
 */
export function resolveAliasCandidates(
  specifier: string,
  aliases: TsPathAliasMap,
): string[] {
  for (const rule of aliases) {
    if (rule.wildcard) {
      if (!specifier.startsWith(rule.prefix)) continue;
      const tail = specifier.slice(rule.prefix.length);
      return rule.targetBases.map((base) => (tail ? resolve(base, tail) : base));
    }
    if (specifier === rule.prefix) {
      return [...rule.targetBases];
    }
  }
  return [];
}

/**
 * Collect the tsconfig files worth scanning for aliases: the root
 * `tsconfig.json`, anything it `extends` or `references`, and the common
 * `tsconfig.app.json` / `tsconfig.base.json` split Vite scaffolds use (where
 * the root config carries only references and the aliases live in the app
 * config). Bounded breadth/depth; deduped.
 */
function gatherConfigFiles(projectRoot: string): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']) {
    const p = resolve(projectRoot, name);
    if (existsSync(p)) queue.push(p);
  }

  // Bounded traversal of extends/references chains.
  let budget = 16;
  while (queue.length > 0 && budget-- > 0) {
    const configPath = queue.shift()!;
    if (visited.has(configPath)) continue;
    visited.add(configPath);
    result.push(configPath);

    const parsed = readJsonc(configPath);
    if (!parsed) continue;
    const configDir = dirname(configPath);

    if (typeof parsed['extends'] === 'string') {
      const ext = resolveConfigRef(configDir, parsed['extends']);
      if (ext && !visited.has(ext)) queue.push(ext);
    }

    if (Array.isArray(parsed['references'])) {
      for (const ref of parsed['references']) {
        if (isRecord(ref) && typeof ref['path'] === 'string') {
          const r = resolveConfigRef(configDir, ref['path']);
          if (r && !visited.has(r)) queue.push(r);
        }
      }
    }
  }

  return result;
}

/**
 * Resolve a tsconfig `extends`/`references` path target to a concrete file.
 * Accepts both a direct file path and a directory (TS appends
 * `tsconfig.json`). Bare package specifiers (e.g. `@tsconfig/strictest`) are
 * skipped: they live in node_modules and never carry project path aliases.
 */
function resolveConfigRef(fromDir: string, ref: string): string | null {
  if (!ref.startsWith('.') && !ref.startsWith('/')) return null;
  const direct = resolve(fromDir, ref);
  if (existsSync(direct) && direct.endsWith('.json')) return direct;
  const asFile = direct.endsWith('.json') ? direct : `${direct}.json`;
  if (existsSync(asFile)) return asFile;
  const asDir = resolve(direct, 'tsconfig.json');
  if (existsSync(asDir)) return asDir;
  return null;
}

/** Build a compiled rule from one `paths` entry, or null if unusable. */
function compileAliasRule(
  pattern: string,
  targets: readonly string[],
  baseDir: string,
): TsPathAlias | null {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) {
    // Exact alias: targets are full paths.
    return {
      prefix: pattern,
      wildcard: false,
      targetBases: targets.map((t) => resolve(baseDir, t)),
    };
  }

  // Wildcard alias: only the portion before `*` is the literal prefix; the
  // portion before `*` in each target is the directory base.
  const prefix = pattern.slice(0, starIndex);
  const targetBases: string[] = [];
  for (const t of targets) {
    const ti = t.indexOf('*');
    const targetPrefix = ti === -1 ? t : t.slice(0, ti);
    targetBases.push(resolve(baseDir, targetPrefix));
  }
  return { prefix, wildcard: true, targetBases };
}

/** Read and parse a JSONC file (tsconfig allows comments + trailing commas). */
function readJsonc(path: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(stripJsonc(content));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Strip `//` and block comments and trailing commas from JSONC text. */
function stripJsonc(input: string): string {
  // Remove comments while preserving string contents.
  let out = '';
  let inString = false;
  let stringQuote = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
