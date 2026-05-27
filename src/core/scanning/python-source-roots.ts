// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detect Python source roots declared in `pyproject.toml`, so absolute-import
 * resolution (e.g. `from pkg.mod import x`) finds files under `src/pkg/mod.py`
 * in the standard src-layout. Falls back to a `src/` heuristic when nothing
 * is declared.
 *
 * Returns relative directories (e.g. `''`, `'src'`, `'lib'`). The empty
 * string means "project root" and is always included so the legacy bare
 * layout keeps working.
 *
 * Implemented with focused regex scans rather than a full TOML parser:
 * Anatoly has no runtime TOML dependency, and the patterns we care about
 * (setuptools `packages.find.where`, poetry `packages[].from`, hatch
 * `packages`) are small and well-bounded.
 */
export function detectPythonSourceRoots(projectRoot: string): string[] {
  const roots = new Set<string>(['']);

  const pyprojectPath = join(projectRoot, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    let content: string;
    try {
      content = readFileSync(pyprojectPath, 'utf-8');
    } catch {
      content = '';
    }
    for (const root of extractRootsFromPyproject(content)) {
      roots.add(root);
    }
  }

  // Heuristic fallback: every project that lays code under src/ deserves it,
  // even when pyproject.toml is missing or uses a config we don't parse.
  if (existsSync(join(projectRoot, 'src'))) roots.add('src');

  return Array.from(roots);
}

function extractRootsFromPyproject(content: string): string[] {
  const out = new Set<string>();

  // setuptools: [tool.setuptools.packages.find] where = ["src", "lib"]
  const setuptoolsSection = sliceTable(content, 'tool.setuptools.packages.find');
  if (setuptoolsSection) {
    for (const m of setuptoolsSection.matchAll(/where\s*=\s*\[([^\]]*)\]/g)) {
      for (const v of parseStringArray(m[1] ?? '')) out.add(stripSlash(v));
    }
  }

  // poetry: [tool.poetry] packages = [{include = "X", from = "src"}, ...]
  const poetrySection = sliceTable(content, 'tool.poetry');
  if (poetrySection) {
    const packagesMatch = poetrySection.match(/packages\s*=\s*\[([\s\S]*?)\]/);
    if (packagesMatch) {
      for (const inline of packagesMatch[1]!.matchAll(/\{([^}]*)\}/g)) {
        const fromMatch = inline[1]!.match(/from\s*=\s*["']([^"']+)["']/);
        if (fromMatch) out.add(stripSlash(fromMatch[1]!));
      }
    }
  }

  // hatch: [tool.hatch.build.targets.wheel] packages = ["src/foo", "src/bar"]
  const hatchSection = sliceTable(content, 'tool.hatch.build.targets.wheel');
  if (hatchSection) {
    for (const m of hatchSection.matchAll(/packages\s*=\s*\[([^\]]*)\]/g)) {
      for (const v of parseStringArray(m[1] ?? '')) {
        const top = stripSlash(v).split('/')[0];
        if (top && top !== '.') out.add(top);
      }
    }
  }

  return Array.from(out).filter((r) => r !== '.' && r !== '');
}

/**
 * Return the slice of `content` belonging to the TOML table with the given
 * dotted header (e.g. `tool.setuptools.packages.find`). The slice ends at the
 * next `[table]` header. Returns null when the header is absent.
 *
 * This is enough for our needs: we only read flat key=value entries from
 * known top-level tables. Nested-inline-table handling is the caller's job
 * (e.g. poetry's `packages = [{...}]`).
 */
function sliceTable(content: string, header: string): string | null {
  // Escape regex meta in header dotted-name (only `.` is special here)
  const escaped = header.replace(/\./g, '\\.');
  const re = new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, 'm');
  const match = re.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextMatch = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  return nextMatch ? rest.slice(0, nextMatch.index) : rest;
}

function parseStringArray(inner: string): string[] {
  const out: string[] = [];
  for (const m of inner.matchAll(/["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }
  return out;
}

function stripSlash(s: string): string {
  return s.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}
