// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Best-effort project name + version detection for the run summary.
 *
 * Looks at the conventional manifest for each detected language, then falls
 * back to `git describe --tags --abbrev=0`. Every step is wrapped in try/catch
 * so a malformed manifest never breaks the run summary.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getLatestGitTag } from '../utils/git.js';

export interface ProjectIdentity {
  name: string;
  /** Version string (e.g. `1.2.3`, `v0.8.1`) or `null` when undetectable. */
  version: string | null;
}

/**
 * Resolve `{ name, version }` for the run summary. Never throws.
 */
export function detectProjectIdentity(projectRoot: string): ProjectIdentity {
  // Each detector returns ProjectIdentity when it finds usable data, else null.
  // We try them in order and accept the first hit, then top up `version` from
  // git tags when the manifest gave us a name but no version (Go's case).
  const detectors: Array<(root: string) => ProjectIdentity | null> = [
    detectFromPackageJson,
    detectFromCargoToml,
    detectFromPyprojectToml,
    detectFromGoMod,
  ];

  let result: ProjectIdentity | null = null;
  for (const fn of detectors) {
    const hit = fn(projectRoot);
    if (hit) {
      result = hit;
      break;
    }
  }

  if (!result) {
    result = { name: basename(projectRoot), version: null };
  }

  if (!result.version) {
    const tag = getLatestGitTag(projectRoot);
    if (tag) result.version = tag;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Manifest detectors
// ---------------------------------------------------------------------------

function detectFromPackageJson(root: string): ProjectIdentity | null {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const name = typeof pkg.name === 'string' ? pkg.name : null;
    const version = typeof pkg.version === 'string' ? pkg.version : null;
    if (!name && !version) return null;
    return { name: name ?? basename(root), version };
  } catch {
    return null;
  }
}

function detectFromCargoToml(root: string): ProjectIdentity | null {
  const path = join(root, 'Cargo.toml');
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, 'utf-8');
    // [package] section, then `name = "..."` and `version = "..."`. Workspace-only
    // Cargo.toml files (no [package]) are common in monorepos — skip them.
    const pkg = body.match(/\[package\][^[]*/s);
    if (!pkg) return null;
    const name = pkg[0].match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const version = pkg[0].match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (!name && !version) return null;
    return { name: name ?? basename(root), version };
  } catch {
    return null;
  }
}

function detectFromPyprojectToml(root: string): ProjectIdentity | null {
  const path = join(root, 'pyproject.toml');
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, 'utf-8');
    // PEP 621 [project] is the modern home; [tool.poetry] is the legacy one.
    // Regex parse is fine because both fields are single-quoted scalars in
    // every spec-compliant pyproject we'll meet.
    const section = body.match(/\[project\][^[]*/s) ?? body.match(/\[tool\.poetry\][^[]*/s);
    if (!section) return null;
    const name = section[0].match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const version = section[0].match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (!name && !version) return null;
    return { name: name ?? basename(root), version };
  } catch {
    return null;
  }
}

function detectFromGoMod(_root: string): ProjectIdentity | null {
  // go.mod has no version field, and its `module github.com/owner/repo` line
  // gives an import path — not what the user thinks of as the project name.
  // When the repo dir is "awf-cli" and the module is "github.com/awf-project/cli",
  // the visible identity is "awf-cli" (basename), not "cli" (last module segment).
  // Returning null lets the basename + git-tag fallback handle Go projects.
  return null;
}
