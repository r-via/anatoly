// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { DocConflictsLockSchema, type DocConflictsLock, type DocConflict } from '../../../schemas/doc-conflict.js';
import { anatolyPath } from '../../../utils/anatoly-paths.js';
import { getLogger } from '../../../utils/logger.js';

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

// doc 16 PR 1: the arbitration ledger lives at the `.anatoly/state/` root,
// NOT inside `state/internal-docs/`. Co-locating it with the regenerated
// scaffold fragments let `anatoly docs scaffold internal` (an `rmSync` of the
// internal-docs dir) silently destroy resolved verdicts. The store is the
// durable record of arbitration and must outlive any scaffold rebuild.
function conflictsFilePath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'state', 'doc-conflicts.yaml');
}

// Pre-doc-16 location, kept as a read-only fallback so a verdict set under
// the old layout is not lost. Migrated forward on first load (write-through
// to the new path) so the next read hits the durable location.
function legacyConflictsFilePath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'state/internal-docs', 'doc-conflicts.yaml');
}

// ---------------------------------------------------------------------------
// Load — Story 55.3 AC2
// ---------------------------------------------------------------------------

/**
 * Load and validate doc-conflicts.yaml.
 * Returns null if the file does not exist.
 * Throws on malformed YAML, Zod validation failure, or unsupported version (NFR7).
 */
/**
 * Parse + validate raw YAML lock content. Throws the same actionable errors
 * as before for an unsupported version (NFR7) or a schema violation,
 * regardless of which on-disk location it came from.
 */
function parseAndValidate(raw: string): DocConflictsLock {
  const parsed = yamlParse(raw) as Record<string, unknown>;

  // NFR7: explicit version check before Zod parse for actionable error
  if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version !== 1) {
    throw new Error(
      `unsupported version ${parsed.version} in doc-conflicts.yaml — run \`anatoly docs upgrade-conflicts\` to migrate`,
    );
  }

  const result = DocConflictsLockSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `invalid doc-conflicts.yaml: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  return result.data;
}

export function loadDocConflicts(projectRoot: string): DocConflictsLock | null {
  const filePath = conflictsFilePath(projectRoot);
  if (existsSync(filePath)) {
    return parseAndValidate(readFileSync(filePath, 'utf-8'));
  }

  // doc 16 PR 1: migrate-on-read from the pre-doc-16 location. A malformed
  // legacy file still throws the same actionable error (behaviour-preserving);
  // a valid one is returned AND written through to the durable path so the
  // next load hits the new location and a scaffold rebuild can no longer
  // destroy it. The legacy file is left intact: write-through is best-effort,
  // and on a write failure the next load simply retries the migration.
  const legacyPath = legacyConflictsFilePath(projectRoot);
  if (!existsSync(legacyPath)) return null;

  const lock = parseAndValidate(readFileSync(legacyPath, 'utf-8'));
  try {
    saveDocConflicts(projectRoot, lock);
  } catch {
    /* best-effort migration — a write failure must not break a read */
  }
  return lock;
}

/**
 * Count doc conflicts still awaiting arbitration. Relocated verbatim from
 * `commands/run.ts` (PR 2, doc 11) so the report phase can move out without a
 * layer-violating import back into `run.ts`. Best-effort: any load failure
 * counts as zero pending.
 */
export function countPendingDocConflicts(projectRoot: string): number {
  try {
    const lock = loadDocConflicts(projectRoot);
    if (!lock) return 0;
    return lock.entries.filter((e) => e.verdict === 'pending').length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Save — Story 55.3 AC2 (atomic write via temp + rename, NFR1)
// ---------------------------------------------------------------------------

/**
 * Atomically write doc-conflicts.yaml.
 * Creates parent directories if needed.
 */
export function saveDocConflicts(projectRoot: string, lock: DocConflictsLock): void {
  const filePath = conflictsFilePath(projectRoot);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const content = yamlStringify(lock, { lineWidth: 120 });
  const tmpPath = join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already renamed or cleaned */ }
  }
}

// ---------------------------------------------------------------------------
// Hash anchoring — Story 55.3 AC3
// ---------------------------------------------------------------------------

/**
 * Normalise content for hashing: strip CRLF → LF, trim leading/trailing whitespace.
 */
function normalise(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Extract lines from content by 1-based line range [start, end] inclusive.
 *
 * Out-of-range values are clamped. The clamp is logged, but the level depends
 * on whether it can actually mis-anchor the hash:
 *
 * - **Material (warn).** The start is pushed up from `<1`, or the start lands
 *   at/past EOF. Both collapse the fragment to empty or a single stray line —
 *   the pathology this guard exists for: silent clamping used to mask
 *   false-positive conflicts where the LLM emitted line numbers far past EOF,
 *   the hash anchored to a stray line, and the entry was marked stale on the
 *   next run regardless of code changes.
 * - **Benign (debug).** Only the end was trimmed back to EOF while the start is
 *   valid. The hash then covers the real file tail (lines `start..EOF`), which
 *   is essentially the intended fragment — common when the LLM rounds a
 *   symbol's end a few lines past the last line. Not worth a warning.
 */
function extractLines(content: string, lineRange: [number, number]): string {
  const lines = content.split('\n');
  const start = Math.max(1, lineRange[0]);
  const end = Math.min(lines.length, lineRange[1]);
  if (start !== lineRange[0] || end !== lineRange[1]) {
    // Material when the start was clamped up (negative/zero) or the requested
    // start sits PAST EOF (slice collapses to empty). A start ON the last line
    // (lineRange[0] === lines.length) is still a valid anchor, and a pure
    // end-overshoot with an in-range start anchors to the real file tail, so
    // both are benign. Use `>` not `>=` to avoid a spurious WARN on the last line.
    const material = lineRange[0] < 1 || lineRange[0] > lines.length;
    const payload = { requested: lineRange, clamped: [start, end], fileLines: lines.length };
    if (material) {
      getLogger().warn(
        payload,
        'doc-conflict-store: line range clamped to file bounds — anchor may not match the intended fragment',
      );
    } else {
      getLogger().debug(
        payload,
        'doc-conflict-store: line range end clamped to EOF — anchor covers the file tail, unaffected',
      );
    }
  }
  return lines.slice(start - 1, end).join('\n');
}

/**
 * Compute a SHA-256 hash of the normalised code content at the anchor location.
 *
 * Resolution order:
 * 1. If lineRange is provided, hash only those lines
 * 2. Otherwise hash the full file content
 *
 * All content is normalised (CRLF→LF, trimmed) before hashing (NFR2).
 */
export function hashCodeAnchor(
  lineRange: [number, number] | undefined,
  fileContent: string,
): string {
  const target = lineRange ? extractLines(fileContent, lineRange) : fileContent;
  const normalised = normalise(target);
  return createHash('sha256').update(normalised).digest('hex');
}

// ---------------------------------------------------------------------------
// Verify anchor hash — Story 55.3 AC4
// ---------------------------------------------------------------------------

/**
 * Verify whether a conflict's anchor hash still matches the current file content.
 * Returns 'valid' if the hash matches, 'stale' otherwise.
 */
export function verifyAnchorHash(
  entry: DocConflict,
  currentFileContent: string,
): 'valid' | 'stale' {
  const currentHash = hashCodeAnchor(
    entry.anchor.line_range as [number, number] | undefined,
    currentFileContent,
  );
  return currentHash === entry.anchor.code_hash ? 'valid' : 'stale';
}
