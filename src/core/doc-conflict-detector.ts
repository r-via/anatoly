// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { resolveDocMode } from './run-config.js';
import {
  loadDocConflicts,
  saveDocConflicts,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by Story 55.10 (LLM detection of new conflicts), kept here for the phase 1 surface
  hashCodeAnchor,
  verifyAnchorHash,
} from './doc-conflict-store.js';
import type { DocConflict, DocConflictsLock, ArbitrationSignals, Presumption } from '../schemas/doc-conflict.js';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DetectionSummary {
  newConflicts: number;
  applied: number;
  stale: number;
  pending: number;
}

export interface DocConflictDetectionOpts {
  projectRoot: string;
  config: Config;
  tasks: Task[];
  fragmentsDir: string;
}

// ---------------------------------------------------------------------------
// Presumption derivation — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Derive the presumption from arbitration signals.
 * Rule: if code was touched after doc → doc-stale; if doc after code → code-drift; else unknown.
 */
export function derivePresumption(signals: ArbitrationSignals): Presumption {
  const docTime = new Date(signals.doc_last_touched).getTime();
  const codeTime = new Date(signals.code_last_touched).getTime();

  if (codeTime > docTime) return 'doc-stale';
  if (docTime > codeTime) return 'code-drift';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Stale entry detection — Story 55.4 AC (FR4b)
// ---------------------------------------------------------------------------

/**
 * For each entry, verify the code_hash against current file contents.
 * If the hash doesn't match (or file is missing), mark as stale-by-codechange
 * and revert verdict to pending.
 */
export function markStaleEntries(
  entries: DocConflict[],
  fileContents: Map<string, string>,
): { entries: DocConflict[]; staleCount: number } {
  let staleCount = 0;

  const updated = entries.map((entry) => {
    const content = fileContents.get(entry.anchor.file);

    // File deleted or not available — mark stale
    if (content === undefined) {
      staleCount++;
      return {
        ...entry,
        status: 'stale-by-codechange' as const,
        verdict: 'pending' as const,
        verdict_note: `[auto] code changed or file removed — ${new Date().toISOString()}`,
      };
    }

    const verification = verifyAnchorHash(entry, content);
    if (verification === 'stale') {
      staleCount++;
      return {
        ...entry,
        status: 'stale-by-codechange' as const,
        verdict: 'pending' as const,
        verdict_note: `[auto] code changed — hash mismatch at ${new Date().toISOString()}`,
      };
    }

    return entry;
  });

  return { entries: updated, staleCount };
}

// ---------------------------------------------------------------------------
// Apply resolved verdicts — Story 55.4 AC (FR4c)
// ---------------------------------------------------------------------------

/**
 * For entries with a non-pending verdict and active status, apply the verdict:
 * - doc-wins / code-wins → status: applied
 * - skip → status: skipped
 */
export function applyResolvedVerdicts(
  entries: DocConflict[],
): { entries: DocConflict[]; appliedCount: number } {
  let appliedCount = 0;

  const updated = entries.map((entry) => {
    // Only apply verdicts on active entries that have a non-pending verdict
    if (entry.verdict === 'pending') return entry;
    if (entry.status === 'applied' || entry.status === 'skipped') return entry;
    if (entry.status === 'stale-by-codechange') return entry;

    appliedCount++;

    if (entry.verdict === 'skip') {
      return { ...entry, status: 'skipped' as const };
    }

    return { ...entry, status: 'applied' as const };
  });

  return { entries: updated, appliedCount };
}

// ---------------------------------------------------------------------------
// Git timestamp extraction — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Get the last commit timestamp (ISO 8601) for a file via git log.
 * Returns a fallback timestamp if git is unavailable or file is untracked.
 */
export function getGitTimestamp(projectRoot: string, filePath: string): string {
  try {
    const result = execFileSync('git', ['log', '-1', '--format=%cI', '--', filePath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return result || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Test coverage heuristic — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Check if a symbol is covered by tests via grep heuristic.
 * Searches for the symbol name in files matching *.test.* or *_test.*.
 */
export function checkTestCoverage(projectRoot: string, symbol: string | undefined): boolean | undefined {
  if (!symbol) return undefined;

  try {
    // Use git grep for efficiency (only searches tracked files)
    const result = execFileSync('git', ['grep', '-l', symbol, '--', '*.test.*', '*_test.*', '*.spec.*'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return result.length > 0;
  } catch {
    // git grep returns exit code 1 when no matches found
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conflict ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable ID for a conflict based on anchor location.
 */
export function generateConflictId(anchor: { file: string; symbol?: string; line_range?: [number, number] }): string {
  const hash = createHash('sha256');
  hash.update(anchor.file);
  if (anchor.symbol) hash.update(`:${anchor.symbol}`);
  if (anchor.line_range) hash.update(`:${anchor.line_range[0]}-${anchor.line_range[1]}`);
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Main detection entry point — Story 55.4 AC1
// ---------------------------------------------------------------------------

/**
 * Run doc-conflict detection.
 *
 * 1. Load existing lock (or create empty)
 * 2. Verify code_hash for non-pending entries → mark stale
 * 3. Apply resolved verdicts (doc-wins, code-wins, skip)
 * 4. Write updated lock
 * 5. Return summary for logger and run-metrics
 *
 * Short-circuits for lite and off modes (no-op with log info).
 */
export async function runDocConflictDetection(
  opts: DocConflictDetectionOpts,
): Promise<DetectionSummary> {
  const log = getLogger();
  const { projectRoot, config } = opts;
  const mode = resolveDocMode(config);

  // AC6: Short-circuit for lite and off modes
  if (mode === 'off') {
    log.info('doc-conflict-detection: mode=off — skipping');
    return { newConflicts: 0, applied: 0, stale: 0, pending: 0 };
  }

  if (mode === 'lite') {
    log.info('doc-conflict-detection: mode=lite — skipping (no conflicts in lite mode)');
    return { newConflicts: 0, applied: 0, stale: 0, pending: 0 };
  }

  // Load existing lock
  let lock = loadDocConflicts(projectRoot);
  if (!lock) {
    lock = {
      version: 1,
      generated_at: new Date().toISOString(),
      entries: [],
    };
  }

  // Build file contents map for hash verification
  const fileContents = new Map<string, string>();
  for (const entry of lock.entries) {
    const filePath = join(projectRoot, entry.anchor.file);
    if (existsSync(filePath) && !fileContents.has(entry.anchor.file)) {
      try {
        fileContents.set(entry.anchor.file, readFileSync(filePath, 'utf-8'));
      } catch {
        // File unreadable — will be marked stale
      }
    }
  }

  // Step 1: Mark stale entries (FR4b)
  const staleResult = markStaleEntries(lock.entries, fileContents);
  let entries = staleResult.entries;

  // Step 2: Apply resolved verdicts (FR4c)
  const applyResult = applyResolvedVerdicts(entries);
  entries = applyResult.entries;

  // Step 3: Write updated lock
  const updatedLock: DocConflictsLock = {
    version: 1,
    generated_at: new Date().toISOString(),
    entries,
  };
  saveDocConflicts(projectRoot, updatedLock);

  const pendingCount = entries.filter(e => e.verdict === 'pending').length;

  const summary: DetectionSummary = {
    newConflicts: 0, // New conflict detection via LLM deferred to Story 55.4 phase 2
    applied: applyResult.appliedCount,
    stale: staleResult.staleCount,
    pending: pendingCount,
  };

  log.info({
    phase: 'doc-conflict-detection',
    ...summary,
  }, 'doc-conflict-detection complete');

  return summary;
}
