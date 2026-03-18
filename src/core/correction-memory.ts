import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { atomicWriteJson } from '../utils/cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReclassificationEntry {
  /** Short pattern description, e.g. "async Commander action without try-catch" */
  pattern: string;
  /** The axis that produced the finding (correction, utility, duplication, overengineering, tests, documentation) */
  axis: string;
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

export interface DeliberationMemory {
  version: 1;
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

/**
 * Load the deliberation memory from disk.
 * Returns an empty memory if the file does not exist or is corrupted.
 * Migrates from legacy correction-memory.json if needed.
 */
export function loadDeliberationMemory(projectRoot: string): DeliberationMemory {
  const dir = resolve(projectRoot, MEMORY_DIR);
  const memPath = resolve(dir, MEMORY_FILE);
  const legacyPath = resolve(dir, LEGACY_MEMORY_FILE);

  // Migrate legacy file if new file doesn't exist but old one does
  if (!existsSync(memPath) && existsSync(legacyPath)) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(raw) as DeliberationMemory;
      if (parsed.version === 1 && Array.isArray(parsed.false_positives)) {
        // Add axis: 'correction' to entries that lack it
        for (const fp of parsed.false_positives) {
          if (!fp.axis) fp.axis = 'correction';
        }
        mkdirSync(dir, { recursive: true });
        atomicWriteJson(memPath, parsed);
        renameSync(legacyPath, legacyPath + '.bak');
        return parsed;
      }
    } catch { /* migration failed — continue to normal load */ }
  }

  try {
    const raw = readFileSync(memPath, 'utf-8');
    const parsed = JSON.parse(raw) as DeliberationMemory;
    if (parsed.version === 1 && Array.isArray(parsed.false_positives)) {
      return parsed;
    }
  } catch { /* file missing or corrupted */ }
  return { version: 1, false_positives: [] };
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
 * Deduplicates by pattern+axis — if an identical pattern already exists, skip.
 */
export function recordReclassification(
  projectRoot: string,
  entry: Omit<ReclassificationEntry, 'recorded_at'>,
): void {
  const memory = loadDeliberationMemory(projectRoot);

  // Deduplicate by pattern + axis
  const exists = memory.false_positives.some(
    (fp) => fp.pattern === entry.pattern && fp.axis === entry.axis && fp.dependency === entry.dependency,
  );
  if (exists) return;

  memory.false_positives.push({
    ...entry,
    recorded_at: new Date().toISOString(),
  });

  saveDeliberationMemory(projectRoot, memory);
}

/** @deprecated Use recordReclassification instead */
export const recordFalsePositive = (
  projectRoot: string,
  entry: Omit<ReclassificationEntry, 'recorded_at' | 'axis'> & { axis?: string },
): void => recordReclassification(projectRoot, { ...entry, axis: entry.axis ?? 'correction' });

/**
 * Format reclassifications for a specific axis as a prompt section.
 * Returns empty string if no relevant reclassifications exist.
 */
export function formatReclassificationsForAxis(
  projectRoot: string,
  axisId: string,
): string {
  const memory = loadDeliberationMemory(projectRoot);
  if (memory.false_positives.length === 0) return '';

  const relevant = memory.false_positives.filter((fp) => fp.axis === axisId);
  if (relevant.length === 0) return '';

  const lines = ['## Known False Positives (previously overturned by deliberation)', ''];
  lines.push('The following findings were previously flagged by this axis but overturned during deliberation review. Do not re-flag them unless you have new evidence that the situation has changed.');
  lines.push('');
  for (const fp of relevant) {
    const dep = fp.dependency ? ` (${fp.dependency})` : '';
    lines.push(`- **${fp.pattern}${dep}**: ${fp.reason}`);
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

  // Filter to correction axis entries matching deps or dep-agnostic
  const depSet = depNames ? new Set(depNames) : undefined;
  const relevant = memory.false_positives.filter(
    (fp) => fp.axis === 'correction' && (!fp.dependency || !depSet || depSet.has(fp.dependency)),
  );

  if (relevant.length === 0) return '';

  const lines = ['## Known False Positives (from previous verified runs)', ''];
  lines.push('The following patterns have been verified as false positives in this codebase. Do NOT flag them again:');
  lines.push('');
  for (const fp of relevant) {
    const dep = fp.dependency ? ` (${fp.dependency})` : '';
    lines.push(`- **${fp.pattern}${dep}**: ${fp.reason}`);
  }
  lines.push('');

  return lines.join('\n');
}
