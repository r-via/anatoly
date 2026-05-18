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

function conflictsFilePath(projectRoot: string): string {
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
export function loadDocConflicts(projectRoot: string): DocConflictsLock | null {
  const filePath = conflictsFilePath(projectRoot);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
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
 * Out-of-range values are clamped — and the clamp is **logged** when it
 * actually rewrites the range. Silent clamping was previously masking
 * false-positive conflicts where the LLM emitted line numbers far past
 * EOF; the resulting hash anchored to one stray line and the entry was
 * marked stale on the next run regardless of code changes.
 */
function extractLines(content: string, lineRange: [number, number]): string {
  const lines = content.split('\n');
  const start = Math.max(1, lineRange[0]);
  const end = Math.min(lines.length, lineRange[1]);
  if (start !== lineRange[0] || end !== lineRange[1]) {
    getLogger().warn(
      { requested: lineRange, clamped: [start, end], fileLines: lines.length },
      'doc-conflict-store: line range clamped to file bounds — anchor may not match the intended fragment',
    );
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
  _filePath: string,
  _symbol: string | undefined,
  lineRange: [number, number] | undefined,
  fileContent: string,
): string {
  let target: string;
  if (lineRange) {
    target = extractLines(fileContent, lineRange);
  } else {
    target = fileContent;
  }

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
    entry.anchor.file,
    entry.anchor.symbol,
    entry.anchor.line_range as [number, number] | undefined,
    currentFileContent,
  );
  return currentHash === entry.anchor.code_hash ? 'valid' : 'stale';
}
