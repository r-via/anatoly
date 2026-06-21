// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

/**
 * Map of Go package import paths to the project-relative `.go` source files
 * that make up each package. A Go `import "<module>/<dir>"` pulls in an entire
 * directory of files, so the usage graph resolves a package path to every file
 * in that directory, not a single module file.
 */
export type GoPackageMap = Map<string, string[]>;

const MODULE_RE = /^\s*module\s+(\S+)/m;

/**
 * Build a Go import-path -> package-files map for the project.
 *
 * Go imports are full module paths (`github.com/me/proj/internal/util`). To
 * resolve them to files we (1) discover every `go.mod` by walking up from each
 * Go file's directory (supporting nested / multi-module layouts) and read its
 * declared `module <path>` prefix, then (2) attribute each `.go` file to the
 * deepest enclosing module and key it under `<modulePath>[/<dirRelToModule>]`.
 * Files sharing a directory form one package, so the value is the list of every
 * `.go` file in that directory.
 *
 * Stdlib / third-party imports (`fmt`, `github.com/spf13/cobra`) never match a
 * discovered module prefix, so they produce no entry and therefore no edge —
 * exactly the desired behaviour (we never claim to consume code we cannot see).
 */
export function buildGoPackageMap(
  projectRoot: string,
  taskFiles: Iterable<string>,
): GoPackageMap {
  const goFiles: string[] = [];
  for (const f of taskFiles) if (extname(f) === '.go') goFiles.push(f);
  if (goFiles.length === 0) return new Map();

  // dirRel ('' == project root) -> declared module path, or null when the
  // directory has no go.mod. Cached so each go.mod is read at most once.
  const moduleByDir = new Map<string, string | null>();

  /** Deepest ancestor dir (incl. self) that declares a Go module, or undefined. */
  const resolveModuleDir = (dirRel: string): string | undefined => {
    let dir = dirRel;
    for (;;) {
      let mod = moduleByDir.get(dir);
      if (mod === undefined) {
        mod = null;
        const goModAbs = join(projectRoot, dir, 'go.mod');
        if (existsSync(goModAbs)) {
          try {
            const m = MODULE_RE.exec(readFileSync(goModAbs, 'utf-8'));
            if (m) mod = m[1]!;
          } catch {
            // Unreadable go.mod — treat the directory as declaring no module.
          }
        }
        moduleByDir.set(dir, mod);
      }
      if (mod) return dir;
      if (dir === '') return undefined;
      const parent = dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  };

  const packageMap: GoPackageMap = new Map();
  for (const file of goFiles) {
    const d = dirname(file);
    const dirRel = d === '.' ? '' : d;
    const moduleDir = resolveModuleDir(dirRel);
    if (moduleDir === undefined) continue; // no enclosing go.mod
    const modulePath = moduleByDir.get(moduleDir)!;
    const sub = moduleDir === '' ? dirRel : dirRel.slice(moduleDir.length).replace(/^\//, '');
    const importPath = sub ? `${modulePath}/${sub}` : modulePath;
    let files = packageMap.get(importPath);
    if (!files) {
      files = [];
      packageMap.set(importPath, files);
    }
    files.push(file);
  }
  return packageMap;
}
