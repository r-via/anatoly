// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execFileSync } from 'node:child_process';

/**
 * Get the set of files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore. Returns null if not in a git repo.
 */
export function getGitTrackedFiles(projectRoot: string): Set<string> | null {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return new Set(output.split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Check if a single file is ignored by .gitignore.
 * Returns false if not in a git repo (permissive default).
 */
export function isGitIgnored(projectRoot: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    return true; // exit code 0 = ignored
  } catch {
    return false; // exit code 1 = not ignored, or not a git repo
  }
}

/**
 * Most recent annotated git tag reachable from HEAD (e.g. `v0.8.1`).
 *
 * Returns `null` when:
 *  - the directory isn't a git repo,
 *  - the repo has no tags yet,
 *  - git is not installed,
 *  - any other failure (permissions, shallow clone, etc.).
 *
 * Used as a language-agnostic version fallback for projects without an
 * in-tree manifest version (Go modules, monorepos, plain shell projects).
 */
export function getLatestGitTag(projectRoot: string): string | null {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}
