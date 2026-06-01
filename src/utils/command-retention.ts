// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bounded retention for a standalone command's observability tree
 * (`<project>/.anatoly/commands/<command>/<timestamp>/`), e.g. `docs
 * arbitrate refresh` or `init --scope`.
 *
 * Each invocation writes one timestamped directory of LLM conversation
 * transcripts. These are forensic, non-reproducible observability output,
 * NOT a content-addressable cache: rerunning never reproduces the same
 * transcript, nothing is ever read back by key, and the dir count grows
 * once per invocation forever. So unlike `.anatoly/cache/` (regenerated on
 * demand, pruned by the snapshot system), this tree needs its own simple
 * keep-most-recent-N retention.
 *
 * Directory names are ISO-8601 timestamps with `:`/`.` replaced by `-`, so
 * a lexicographic sort is chronological. We sort by name (stable, no clock
 * read) and remove everything past the newest `keep` entries.
 *
 * Best-effort: never throws. A command must not fail because an old
 * transcript dir could not be cleaned up.
 *
 * @param commandRoot Absolute path of `<project>/.anatoly/commands/<command>/`.
 * @param keep        How many most-recent run dirs to retain (must be >= 0).
 * @returns The names of the directories that were removed.
 */
export function pruneTimestampedRuns(commandRoot: string, keep: number): string[] {
  if (keep < 0) return [];
  if (!existsSync(commandRoot)) return [];

  let dirs: string[];
  try {
    dirs = readdirSync(commandRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  if (dirs.length <= keep) return [];

  // Newest first (ISO timestamps sort chronologically as strings).
  dirs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const toRemove = dirs.slice(keep);
  const removed: string[] = [];
  for (const name of toRemove) {
    const full = join(commandRoot, name);
    try {
      // Guard against following a symlink out of the tree.
      if (!statSync(full).isDirectory()) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
