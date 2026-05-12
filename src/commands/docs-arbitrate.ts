// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import { loadDocConflicts, saveDocConflicts } from '../core/doc-conflict-store.js';
import type { DocConflict, DocConflictsLock, DocConflictVerdict } from '../schemas/doc-conflict.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArbitrateOptions {
  list?: boolean;
  review?: boolean;
}

export interface ArbitrateResult {
  exitCode: number;
  message?: string;
  table?: string;
  error?: string;
  cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Pure logic helpers (unit-testable)
// ---------------------------------------------------------------------------

/** Return only entries with verdict=pending. */
export function filterPendingEntries(entries: DocConflict[]): DocConflict[] {
  return entries.filter((e) => e.verdict === 'pending');
}

/** Return entries with status=applied (for --review mode). */
export function filterReviewableEntries(entries: DocConflict[]): DocConflict[] {
  return entries.filter((e) => e.status === 'applied');
}

/** Format a summary table for --list mode. */
export function formatListTable(entries: DocConflict[]): string {
  const header = ['ID', 'File', 'Symbol', 'Verdict', 'Status'];
  const rows = entries.map((e) => [
    e.id,
    e.anchor.file,
    e.anchor.symbol ?? '—',
    e.verdict,
    e.status,
  ]);

  // Compute column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const sep = widths.map((w) => '─'.repeat(w + 2)).join('┼');
  const formatRow = (cols: string[]) =>
    cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('│');

  const lines: string[] = [];
  lines.push(formatRow(header));
  lines.push(sep);
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  return lines.join('\n');
}

/** Mutate an entry to record a verdict. */
export function applyVerdict(
  entry: DocConflict,
  verdict: DocConflictVerdict,
  note?: string,
): void {
  entry.verdict = verdict;
  entry.verdict_set_at = new Date().toISOString();
  if (note !== undefined && note !== '') {
    entry.verdict_note = note;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatConflictNote(entry: DocConflict): string {
  const lines: string[] = [];
  lines.push(`File:        ${entry.anchor.file}`);
  if (entry.anchor.symbol) {
    lines.push(`Symbol:      ${entry.anchor.symbol}`);
  }
  if (entry.anchor.line_range) {
    lines.push(`Lines:       ${entry.anchor.line_range[0]}–${entry.anchor.line_range[1]}`);
  }
  lines.push('');
  lines.push(`Reference:   ${entry.reference_excerpt.path}`);
  lines.push(`  "${entry.reference_excerpt.text}"`);
  lines.push('');
  lines.push(`Code says:   ${entry.code_summary}`);
  lines.push('');
  lines.push(`Presumption: ${entry.signals.presumption}`);
  if (entry.signals.test_covers_current_behavior !== undefined) {
    lines.push(`Tests cover: ${entry.signals.test_covers_current_behavior ? 'yes' : 'no'}`);
  }
  lines.push(`Doc touched: ${entry.signals.doc_last_touched}`);
  lines.push(`Code touched: ${entry.signals.code_last_touched}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main wizard orchestrator
// ---------------------------------------------------------------------------

export async function runArbitrateWizard(
  projectRoot: string,
  opts: ArbitrateOptions,
): Promise<ArbitrateResult> {
  // Load conflicts
  let lock: DocConflictsLock | null;
  try {
    lock = loadDocConflicts(projectRoot);
  } catch (err) {
    return {
      exitCode: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // No file or empty entries
  if (!lock || lock.entries.length === 0) {
    return {
      exitCode: 0,
      message: 'No conflicts to arbitrate. Run `anatoly run` first to generate conflicts.',
    };
  }

  // --list mode: display table and exit
  if (opts.list) {
    const table = formatListTable(lock.entries);
    return { exitCode: 0, table };
  }

  // Determine which entries to iterate
  const targets = opts.review
    ? filterReviewableEntries(lock.entries)
    : filterPendingEntries(lock.entries);

  if (targets.length === 0) {
    const modeLabel = opts.review ? 'applied entries to review' : 'pending conflicts';
    return {
      exitCode: 0,
      message: `No ${modeLabel}. Run \`anatoly run\` first to generate conflicts.`,
    };
  }

  p.intro(`Arbitrating ${targets.length} conflict${targets.length > 1 ? 's' : ''}`);

  let savedCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    const label = `[${i + 1}/${targets.length}] ${entry.id}`;

    // Display conflict details
    p.note(formatConflictNote(entry), label);

    // Build verdict options based on mode
    const options = opts.review
      ? [
          { value: 'pending', label: 'Re-open (set to pending)' },
          { value: 'keep', label: 'Keep current verdict' },
        ]
      : [
          { value: 'doc-wins', label: 'Doc wins — code should be updated' },
          { value: 'code-wins', label: 'Code wins — doc is stale' },
          { value: 'skip', label: 'Skip — not actionable now' },
          { value: 'defer', label: 'Defer — decide later' },
        ];

    const choice = await p.select({
      message: `Verdict for ${entry.anchor.file}${entry.anchor.symbol ? `:${entry.anchor.symbol}` : ''}?`,
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel('Arbitration cancelled. Progress saved.');
      return { exitCode: 0, cancelled: true };
    }

    // Handle defer: skip without changing anything
    if (choice === 'defer' || choice === 'keep') {
      continue;
    }

    // For review mode: re-open sets verdict=pending and status=active
    if (opts.review && choice === 'pending') {
      entry.verdict = 'pending';
      entry.status = 'active';
      entry.verdict_set_at = new Date().toISOString();
      entry.verdict_note = undefined;
    } else {
      // Ask for optional note
      const note = await p.text({
        message: 'Add a note (optional, press Enter to skip):',
      });

      if (p.isCancel(note)) {
        p.cancel('Arbitration cancelled. Progress saved.');
        return { exitCode: 0, cancelled: true };
      }

      applyVerdict(
        entry,
        choice as DocConflictVerdict,
        typeof note === 'string' && note.trim() ? note.trim() : undefined,
      );
    }

    // Incremental save after each verdict (NFR8)
    lock.generated_at = new Date().toISOString();
    saveDocConflicts(projectRoot, lock);
    savedCount++;
  }

  p.outro(`Done — ${savedCount} verdict${savedCount !== 1 ? 's' : ''} applied.`);

  return { exitCode: 0 };
}
