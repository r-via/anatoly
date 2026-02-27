import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { atomicWriteJson } from '../utils/cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FalsePositiveEntry {
  /** Short pattern description, e.g. "async Commander action without try-catch" */
  pattern: string;
  /** The dependency involved, if any */
  dependency?: string;
  /** The NEEDS_FIX detail that was disproven */
  original_detail: string;
  /** Why it was disproven (from verification pass) */
  reason: string;
  /** ISO timestamp when this was recorded */
  recorded_at: string;
}

export interface CorrectionMemory {
  version: 1;
  false_positives: FalsePositiveEntry[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MEMORY_DIR = '.anatoly';
const MEMORY_FILE = 'correction-memory.json';

/**
 * Load the correction memory from disk.
 * Returns an empty memory if the file does not exist or is corrupted.
 */
export function loadCorrectionMemory(projectRoot: string): CorrectionMemory {
  const memPath = resolve(projectRoot, MEMORY_DIR, MEMORY_FILE);
  try {
    const raw = readFileSync(memPath, 'utf-8');
    const parsed = JSON.parse(raw) as CorrectionMemory;
    if (parsed.version === 1 && Array.isArray(parsed.false_positives)) {
      return parsed;
    }
  } catch { /* file missing or corrupted */ }
  return { version: 1, false_positives: [] };
}

/**
 * Save the correction memory to disk (atomic write).
 */
export function saveCorrectionMemory(projectRoot: string, memory: CorrectionMemory): void {
  const dir = resolve(projectRoot, MEMORY_DIR);
  mkdirSync(dir, { recursive: true });
  const memPath = join(dir, MEMORY_FILE);
  atomicWriteJson(memPath, memory);
}

/**
 * Record a false positive into the correction memory.
 * Deduplicates by pattern — if an identical pattern already exists, skip.
 */
export function recordFalsePositive(
  projectRoot: string,
  entry: Omit<FalsePositiveEntry, 'recorded_at'>,
): void {
  const memory = loadCorrectionMemory(projectRoot);

  // Deduplicate by pattern
  const exists = memory.false_positives.some(
    (fp) => fp.pattern === entry.pattern && fp.dependency === entry.dependency,
  );
  if (exists) return;

  memory.false_positives.push({
    ...entry,
    recorded_at: new Date().toISOString(),
  });

  saveCorrectionMemory(projectRoot, memory);
}

/**
 * Format known false positives as a prompt section.
 * Returns empty string if no relevant false positives exist.
 */
export function formatMemoryForPrompt(
  projectRoot: string,
  depNames?: string[],
): string {
  const memory = loadCorrectionMemory(projectRoot);
  if (memory.false_positives.length === 0) return '';

  // Filter to relevant entries (matching deps or dep-agnostic)
  const depSet = depNames ? new Set(depNames) : undefined;
  const relevant = memory.false_positives.filter(
    (fp) => !fp.dependency || !depSet || depSet.has(fp.dependency),
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
