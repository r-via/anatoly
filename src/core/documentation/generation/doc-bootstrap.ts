// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc Bootstrap Helpers — Story 29.21
 *
 * First-run detection and pipeline-stage flags. Every doc-pipeline flag now
 * lives in ONE ledger — `.anatoly/cache/doc-build/manifest.json` (see
 * {@link DocCache}) — so a retry never repeats finished work:
 *
 * - per-page generation flag → `manifest.pages` (written by commitDocPage)
 * - pipeline-complete marker → `manifest.scaffold` (writeScaffoldStatus)
 * - global coherence flag    → `manifest.coherence` (writeCoherenceStatus)
 *
 * All three readers/writers route through {@link docManifestPath}, so moving
 * the storage never leaves a consumer pointing at a stale location. File
 * existence alone is never the signal: a crashed scaffolder leaves stub
 * pages, and a flag is only written *after* the work it records succeeded.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { anatolyPath } from '../../../utils/anatoly-paths.js';
import {
  loadDocCache,
  saveDocCache,
  docManifestPath,
  type ScaffoldInfo,
  type CoherenceInfo,
} from '../resolution/doc-cache.js';

/** Internal-docs output directory for `projectRoot`. */
function docsDir(projectRoot: string): string {
  return anatolyPath(projectRoot, 'state/internal-docs');
}

/**
 * Detect whether this run needs the bootstrap doc phase.
 *
 * The canonical signal is `manifest.scaffold`: it is written only after a
 * previous run completed scaffold + generation + coherence. No manifest, a
 * pre-v3 (discarded) manifest, or a manifest without `scaffold` all mean the
 * pipeline never finished → bootstrap. A pre-v3 manifest is intentionally
 * treated as "needs bootstrap" so the one-time clean regeneration happens.
 */
export function needsBootstrap(projectRoot: string): boolean {
  if (!existsSync(docsDir(projectRoot))) return true;
  const cache = loadDocCache(docManifestPath(projectRoot));
  return !cache.scaffold?.scaffoldedAt;
}

/**
 * Mark the docs as validly scaffolded (pipeline-complete). Called after
 * `runDocBootstrap` / `runDocUpdate` returns successfully — i.e. after the
 * refinement / coherence passes. A crash mid-pipeline never reaches this, so
 * the next run correctly re-bootstraps.
 *
 * Synchronous load→mutate→save of the small ledger: no `await` between read
 * and write, so it cannot interleave with concurrent per-page commits.
 * Best-effort: a failed flag write must not fail the run.
 */
export function writeScaffoldStatus(
  projectRoot: string,
  info: { mode: 'bootstrap' | 'update'; runId?: string },
): void {
  if (!existsSync(docsDir(projectRoot))) return;
  const scaffold: ScaffoldInfo = {
    scaffoldedAt: new Date().toISOString(),
    lastMode: info.mode,
    ...(info.runId ? { lastRunId: info.runId } : {}),
  };
  try {
    const path = docManifestPath(projectRoot);
    saveDocCache(path, { ...loadDocCache(path), scaffold });
  } catch {
    /* status write is best-effort */
  }
}

/** Read the pipeline-complete marker, or `null` if absent/never completed. */
export function readScaffoldStatus(projectRoot: string): ScaffoldInfo | null {
  const { scaffold } = loadDocCache(docManifestPath(projectRoot));
  if (
    scaffold &&
    typeof scaffold.scaffoldedAt === 'string' &&
    (scaffold.lastMode === 'bootstrap' || scaffold.lastMode === 'update')
  ) {
    return scaffold;
  }
  return null;
}

/**
 * Stable signature of the current internal-doc set: SHA-256 over every
 * `.md` file's path + content, ordered by path. Two runs that produced
 * byte-identical docs yield the same key; regenerating any page changes it.
 * This is the coherence flag's invalidation key.
 */
export function computeDocSetSignature(outputDir: string): string {
  const files: Array<{ rel: string; content: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (name.endsWith('.md')) {
        try {
          files.push({ rel, content: readFileSync(abs, 'utf-8') });
        } catch {
          /* unreadable file — skip; its absence still changes the digest */
        }
      }
    }
  };
  walk(outputDir, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(f.content);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Flag that the global coherence pass completed for the given doc-set
 * signature. Same best-effort, synchronous-commit contract as
 * {@link writeScaffoldStatus}.
 */
export function writeCoherenceStatus(projectRoot: string, key: string): void {
  if (!existsSync(docsDir(projectRoot))) return;
  const coherence: CoherenceInfo = { key, at: new Date().toISOString() };
  try {
    const path = docManifestPath(projectRoot);
    saveDocCache(path, { ...loadDocCache(path), coherence });
  } catch {
    /* coherence flag write is best-effort */
  }
}

/** Read the coherence flag, or `null` if the pass never completed. */
export function readCoherenceStatus(projectRoot: string): CoherenceInfo | null {
  const { coherence } = loadDocCache(docManifestPath(projectRoot));
  if (coherence && typeof coherence.key === 'string' && typeof coherence.at === 'string') {
    return coherence;
  }
  return null;
}

/**
 * Whether the global coherence pass can be skipped this run: it already
 * completed for a doc set byte-identical to the current one. Any regenerated
 * page changes the signature and forces coherence to run again.
 */
export function coherenceUpToDate(projectRoot: string, outputDir: string): boolean {
  const flag = readCoherenceStatus(projectRoot);
  if (!flag) return false;
  return flag.key === computeDocSetSignature(outputDir);
}

/**
 * Whether to skip the double-pass review on first run.
 *
 * If >= 50% of bootstrap pages failed LLM generation, the double pass
 * would gain little from the incomplete internal docs.
 */
export function shouldSkipDoublePass(pagesFailed: number, totalPages: number): boolean {
  if (totalPages === 0) return false;
  return pagesFailed >= totalPages * 0.5;
}
