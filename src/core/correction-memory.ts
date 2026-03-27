// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { atomicWriteJson } from '../utils/cache.js';
import { contextLogger } from '../utils/log-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single axis reclassification within a symbol entry. */
export interface AxisReclassification {
  axis: string;
  from: string;
  to: string;
}

/**
 * One reclassification entry per symbol, grouping all axis changes together.
 * This avoids duplicating original_detail and reason across axis entries.
 */
export interface ReclassificationEntry {
  /** Symbol name (function, struct, constant, etc.) */
  symbol: string;
  /** All axis reclassifications for this symbol */
  reclassifications: AxisReclassification[];
  /** The dependency involved, if any */
  dependency?: string;
  /** The original detail that was disproven */
  original_detail: string;
  /** Why it was disproven (from verification/deliberation pass) */
  reason: string;
  /** ISO timestamp when this was recorded */
  recorded_at: string;
}

/** @deprecated Use ReclassificationEntry instead */
export type FalsePositiveEntry = ReclassificationEntry;

/** V1 entry shape (per-axis), kept for migration. */
interface LegacyReclassificationEntry {
  pattern: string;
  axis: string;
  dependency?: string;
  original_detail: string;
  reason: string;
  recorded_at: string;
}

/**
 * Versioned container for deliberation reclassification entries.
 *
 * Persisted to `.anatoly/deliberation-memory.json` and loaded/saved by
 * {@link loadDeliberationMemory} / {@link saveDeliberationMemory}.
 */
export interface DeliberationMemory {
  version: 2;
  false_positives: ReclassificationEntry[];
}

/** @deprecated Use DeliberationMemory instead */
export type CorrectionMemory = DeliberationMemory;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MEMORY_DIR = '.anatoly';
const MEMORY_FILE = 'deliberation-memory.json';
const LEGACY_MEMORY_FILE = 'correction-memory.json';

// ---------------------------------------------------------------------------
// V1 → V2 migration
// ---------------------------------------------------------------------------

/** Extract the symbol name from a v1 pattern like "[deliberation] COOKIE_LEN: utility DEAD → USED". */
function extractSymbolFromPattern(pattern: string): string {
  const match = pattern.match(/^\[deliberation\]\s+(.+?):\s+\w+\s+/);
  if (match) return match[1];
  // Correction-axis patterns are free-text summaries — use them as-is
  return pattern;
}

/** Extract (from, to) from a v1 pattern like "[deliberation] COOKIE_LEN: utility DEAD → USED". */
function extractTransitionFromPattern(pattern: string, axis: string): { from: string; to: string } | undefined {
  const escaped = axis.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s+(\\S+)\\s+→\\s+(\\S+)`);
  const match = pattern.match(re);
  if (match) return { from: match[1], to: match[2] };
  return undefined;
}

function migrateV1toV2(entries: LegacyReclassificationEntry[]): ReclassificationEntry[] {
  // Group v1 entries by (symbol, original_detail) to merge per-axis entries
  const groups = new Map<string, {
    symbol: string;
    reclassifications: AxisReclassification[];
    dependency?: string;
    original_detail: string;
    reason: string;
    recorded_at: string;
  }>();

  for (const entry of entries) {
    const symbol = extractSymbolFromPattern(entry.pattern);
    const transition = extractTransitionFromPattern(entry.pattern, entry.axis);
    const key = `${symbol}\0${entry.dependency ?? ''}`;

    const existing = groups.get(key);
    if (existing) {
      if (transition) {
        // Only add if this axis isn't already present
        const hasAxis = existing.reclassifications.some((r) => r.axis === entry.axis);
        if (!hasAxis) {
          existing.reclassifications.push({ axis: entry.axis, ...transition });
        }
      }
    } else {
      const reclassifications: AxisReclassification[] = [];
      if (transition) {
        reclassifications.push({ axis: entry.axis, ...transition });
      } else {
        // Correction-axis entries without parseable transition: store axis + placeholders
        reclassifications.push({ axis: entry.axis, from: '?', to: '?' });
      }
      groups.set(key, {
        symbol,
        reclassifications,
        dependency: entry.dependency,
        original_detail: entry.original_detail,
        reason: entry.reason,
        recorded_at: entry.recorded_at,
      });
    }
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load the deliberation memory from disk.
 * Returns an empty memory if the file does not exist or is corrupted.
 * Migrates from legacy correction-memory.json and v1 format if needed.
 */
export function loadDeliberationMemory(projectRoot: string): DeliberationMemory {
  const dir = resolve(projectRoot, MEMORY_DIR);
  const memPath = resolve(dir, MEMORY_FILE);
  const legacyPath = resolve(dir, LEGACY_MEMORY_FILE);

  // Migrate from legacy correction-memory.json if new file doesn't exist
  if (!existsSync(memPath) && existsSync(legacyPath)) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version: number; false_positives: unknown[] };
      if (parsed.version === 1 && Array.isArray(parsed.false_positives)) {
        const v1Entries = parsed.false_positives as LegacyReclassificationEntry[];
        for (const fp of v1Entries) {
          if (!fp.axis) fp.axis = 'correction';
        }
        const migrated: DeliberationMemory = {
          version: 2,
          false_positives: migrateV1toV2(v1Entries),
        };
        mkdirSync(dir, { recursive: true });
        atomicWriteJson(memPath, migrated);
        renameSync(legacyPath, legacyPath + '.bak');
        return migrated;
      } else {
        contextLogger().warn(
          { legacyPath, version: parsed.version },
          'legacy correction-memory.json has unrecognized version — skipping migration',
        );
      }
    } catch (err) {
      contextLogger().warn({ legacyPath, err }, 'deliberation memory migration failed');
    }
  }

  try {
    const raw = readFileSync(memPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version: number; false_positives: unknown[] };
    if (parsed.version === 2 && Array.isArray(parsed.false_positives)) {
      return parsed as DeliberationMemory;
    }
    // Migrate v1 deliberation-memory.json in-place
    if (parsed.version === 1 && Array.isArray(parsed.false_positives)) {
      const v1Entries = parsed.false_positives as LegacyReclassificationEntry[];
      const migrated: DeliberationMemory = {
        version: 2,
        false_positives: migrateV1toV2(v1Entries),
      };
      atomicWriteJson(memPath, migrated);
      contextLogger().info({ memPath }, 'migrated deliberation memory v1 → v2');
      return migrated;
    }
  } catch (err) {
    if (existsSync(memPath)) {
      const bakPath = memPath + `.corrupted.${Date.now()}`;
      contextLogger().warn({ memPath, bakPath, err }, 'deliberation memory file corrupted — rebuilding');
      try {
        renameSync(memPath, bakPath);
      } catch { /* best-effort backup */ }
      const fresh: DeliberationMemory = { version: 2, false_positives: [] };
      mkdirSync(dir, { recursive: true });
      atomicWriteJson(memPath, fresh);
      return fresh;
    }
  }
  return { version: 2, false_positives: [] };
}

/** @deprecated Use loadDeliberationMemory instead */
export const loadCorrectionMemory = loadDeliberationMemory;

/**
 * Save the deliberation memory to disk (atomic write).
 */
export function saveDeliberationMemory(projectRoot: string, memory: DeliberationMemory): void {
  const dir = resolve(projectRoot, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });
  const memPath = join(dir, MEMORY_FILE);
  atomicWriteJson(memPath, memory);
}

/** @deprecated Use saveDeliberationMemory instead */
export const saveCorrectionMemory = saveDeliberationMemory;

/**
 * Record a reclassification into the deliberation memory.
 * Groups by symbol+dependency — merges axis reclassifications into existing entries.
 */
export function recordReclassification(
  projectRoot: string,
  entry: Omit<ReclassificationEntry, 'recorded_at'>,
): void {
  const memory = loadDeliberationMemory(projectRoot);

  // Find existing entry for this symbol+dependency
  const existing = memory.false_positives.find(
    (fp) => fp.symbol === entry.symbol && fp.dependency === entry.dependency,
  );

  if (existing) {
    // Merge new axis reclassifications — update existing axes, add new ones
    let changed = false;
    for (const r of entry.reclassifications) {
      const existingAxis = existing.reclassifications.find((er) => er.axis === r.axis);
      if (existingAxis) {
        // Update stale from/to values if they changed
        if (existingAxis.from !== r.from || existingAxis.to !== r.to) {
          existingAxis.from = r.from;
          existingAxis.to = r.to;
          changed = true;
        }
      } else {
        existing.reclassifications.push(r);
        changed = true;
      }
    }
    // Update reason/detail if provided (later entries may have better context)
    if (entry.reason && entry.reason !== existing.reason) {
      existing.reason = entry.reason;
      changed = true;
    }
    if (entry.original_detail && entry.original_detail !== existing.original_detail) {
      existing.original_detail = entry.original_detail;
      changed = true;
    }
    if (!changed) return;
    existing.recorded_at = new Date().toISOString();
  } else {
    memory.false_positives.push({
      ...entry,
      recorded_at: new Date().toISOString(),
    });
  }

  saveDeliberationMemory(projectRoot, memory);
}

/**
 * Format reclassifications for a specific axis as a prompt section.
 * When `symbolNames` is provided, only reclassifications for those symbols
 * are included — this avoids injecting irrelevant false positives from other
 * files into the prompt (which wastes tokens).
 * Returns empty string if no relevant reclassifications exist.
 */
export function formatReclassificationsForAxis(
  projectRoot: string,
  axisId: string,
  symbolNames?: Set<string>,
): string {
  const memory = loadDeliberationMemory(projectRoot);
  if (memory.false_positives.length === 0) return '';

  // Find entries that have at least one reclassification matching this axis
  // AND (if scoped) whose symbol is in the current file
  const relevant = memory.false_positives.filter(
    (fp) =>
      fp.reclassifications.some((r) => r.axis === axisId) &&
      (!symbolNames || symbolNames.has(fp.symbol)),
  );
  if (relevant.length === 0) return '';

  const lines = ['## Known False Positives (previously overturned by deliberation)', ''];
  lines.push('The following findings were previously flagged by this axis but overturned during deliberation review. Do not re-flag them unless you have new evidence that the situation has changed.');
  lines.push('');
  for (const fp of relevant) {
    const dep = fp.dependency ? ` (${fp.dependency})` : '';
    const axisChange = fp.reclassifications.find((r) => r.axis === axisId);
    const transition = axisChange ? ` [${axisChange.from} → ${axisChange.to}]` : '';
    lines.push(`- **${fp.symbol}${dep}${transition}**: ${fp.reason}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Format known false positives as a prompt section (correction axis, with dependency filtering).
 * Returns empty string if no relevant false positives exist.
 */
export function formatMemoryForPrompt(
  projectRoot: string,
  depNames?: string[],
): string {
  const memory = loadDeliberationMemory(projectRoot);
  if (memory.false_positives.length === 0) return '';

  // Filter to entries with correction-axis reclassifications matching deps
  const depSet = depNames ? new Set(depNames) : undefined;
  const relevant = memory.false_positives.filter(
    (fp) =>
      fp.reclassifications.some((r) => r.axis === 'correction') &&
      (!fp.dependency || !depSet || depSet.has(fp.dependency)),
  );

  if (relevant.length === 0) return '';

  const lines = ['## Known False Positives (from previous verified runs)', ''];
  lines.push('The following patterns have been verified as false positives in this codebase. Do NOT flag them again:');
  lines.push('');
  for (const fp of relevant) {
    const dep = fp.dependency ? ` (${fp.dependency})` : '';
    const axisChange = fp.reclassifications.find((r) => r.axis === 'correction');
    const transition = axisChange ? ` [${axisChange.from} → ${axisChange.to}]` : '';
    lines.push(`- **${fp.symbol}${dep}${transition}**: ${fp.reason}`);
  }
  lines.push('');

  return lines.join('\n');
}
