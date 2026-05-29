// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import { loadDocConflicts, saveDocConflicts } from '../core/documentation/index.js';
import type { RefreshSummary } from '../core/documentation/index.js';
import type { DocConflict, DocConflictsLock, DocConflictVerdict } from '../schemas/doc-conflict.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Callback that runs an LLM refresh pass over the given entries and returns
 *  the updated entries + a summary. Injected by the CLI handler so the wizard
 *  module stays decoupled from transport/router construction. */
export type RefreshFn = (entries: DocConflict[]) => Promise<{ entries: DocConflict[]; summary: RefreshSummary }>;

export interface ArbitrateOptions {
  list?: boolean;
  review?: boolean;
  refreshFn?: RefreshFn;
  /** Skip the interactive "refresh first?" prompt. Used by tests and by the
   *  standalone `arbitrate refresh` subcommand (where the refresh is the
   *  whole point, not an optional pre-step). */
  skipRefreshPrompt?: boolean;
}

export interface ArbitrateResult {
  exitCode: number;
  message?: string;
  table?: string;
  error?: string;
  cancelled?: boolean;
  refreshSummary?: RefreshSummary;
}

export interface RefreshStandaloneOptions {
  refreshFn: RefreshFn;
  dryRun?: boolean;
}

export interface RefreshStandaloneResult {
  exitCode: number;
  message?: string;
  error?: string;
  summary?: RefreshSummary;
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

/**
 * Wrap a long string to {@link width} columns at word boundaries, preserving
 * the given indent on each output line. Single oversized words are emitted
 * on their own line rather than truncated.
 */
function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let current = indent;
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > indent.length) {
      out.push(current);
      current = indent + word;
    } else if (current === indent) {
      current = indent + word;
    } else {
      current = current + ' ' + word;
    }
  }
  if (current !== indent) out.push(current);
  return out.length > 0 ? out : [indent + text];
}

/** Format an ISO timestamp as "Nd ago (YYYY-MM-DD)" relative to now. */
function formatRelativeDate(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.round((Date.now() - t) / (1000 * 60 * 60 * 24));
  const ymd = iso.slice(0, 10);
  if (days < 1) return `today (${ymd})`;
  if (days === 1) return `1d ago (${ymd})`;
  return `${days}d ago (${ymd})`;
}

function formatConflictNote(entry: DocConflict): string {
  const WIDTH = 78; // matches clack's default note width budget on standard terminals
  const lines: string[] = [];

  // Header — single line, file + symbol + lines compactly
  const sym = entry.anchor.symbol ? `::${entry.anchor.symbol}` : '';
  const lr = entry.anchor.line_range
    ? `  (L${entry.anchor.line_range[0]}${entry.anchor.line_range[0] !== entry.anchor.line_range[1] ? `–L${entry.anchor.line_range[1]}` : ''})`
    : '';
  lines.push(`${entry.anchor.file}${sym}${lr}`);

  // Reference section — wrapped excerpt under the path
  lines.push('');
  lines.push(`Reference doc — ${entry.reference_excerpt.path}`);
  for (const line of wrapText(`"${entry.reference_excerpt.text}"`, WIDTH, '  ')) {
    lines.push(line);
  }

  // Code section — wrapped summary
  lines.push('');
  lines.push('Code observed');
  for (const line of wrapText(entry.code_summary, WIDTH, '  ')) {
    lines.push(line);
  }

  // Signals — compact aligned block
  lines.push('');
  lines.push('Signals');
  lines.push(`  presumption    ${entry.signals.presumption}`);
  if (entry.signals.test_covers_current_behavior !== undefined) {
    lines.push(`  tests cover    ${entry.signals.test_covers_current_behavior ? 'yes' : 'no'}`);
  }
  lines.push(`  doc touched    ${formatRelativeDate(entry.signals.doc_last_touched)}`);
  lines.push(`  code touched   ${formatRelativeDate(entry.signals.code_last_touched)}`);

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

  // Optional pre-step: LLM refresh of pending entries. Only offered when a
  // refreshFn was injected (the CLI handler builds router+config; tests pass
  // their own or none), outside --review mode, and only if there is still
  // something pending to refresh.
  let refreshSummary: RefreshSummary | undefined;
  if (!opts.review && opts.refreshFn && !opts.skipRefreshPrompt) {
    const pendingCount = filterPendingEntries(lock.entries).length;
    if (pendingCount > 0) {
      const confirm = await p.confirm({
        message: `Refresh ${pendingCount} pending entr${pendingCount > 1 ? 'ies' : 'y'} via LLM first? (recommended)`,
        initialValue: true,
      });
      if (p.isCancel(confirm)) {
        p.cancel('Arbitration cancelled.');
        return { exitCode: 0, cancelled: true };
      }
      if (confirm) {
        const spinner = p.spinner();
        spinner.start('Refreshing pending entries via LLM...');
        try {
          const { entries: updated, summary } = await opts.refreshFn(lock.entries);
          lock.entries = updated;
          lock.generated_at = new Date().toISOString();
          saveDocConflicts(projectRoot, lock);
          refreshSummary = summary;
          spinner.stop(formatRefreshBilan(summary, { prefix: 'Refresh done' }));
          if (summary.conversationDir) {
            p.log.info(`Transcripts: ${summary.conversationDir}`);
          }
        } catch (err) {
          spinner.stop('Refresh failed — continuing with the wizard on the original ledger.');
          p.log.warn(err instanceof Error ? err.message : String(err));
        }
      }
    }
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
      refreshSummary,
    };
  }

  p.intro(`Arbitrating ${targets.length} conflict${targets.length > 1 ? 's' : ''}`);

  let savedCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    // Short id is enough — full id is in the lock file. Keeps the box
    // header tight so the ──── line doesn't span the whole terminal.
    const shortId = entry.id.slice(0, 8);
    const label = `Conflict ${i + 1}/${targets.length}  ·  ${shortId}`;

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

  return { exitCode: 0, refreshSummary };
}

// ---------------------------------------------------------------------------
// Standalone refresh — used by `docs arbitrate refresh`
// ---------------------------------------------------------------------------

export async function runRefreshStandalone(
  projectRoot: string,
  opts: RefreshStandaloneOptions,
): Promise<RefreshStandaloneResult> {
  let lock: DocConflictsLock | null;
  try {
    lock = loadDocConflicts(projectRoot);
  } catch (err) {
    return { exitCode: 1, error: err instanceof Error ? err.message : String(err) };
  }

  if (!lock || lock.entries.length === 0) {
    return { exitCode: 0, message: 'No conflicts to refresh.' };
  }

  const pendingCount = filterPendingEntries(lock.entries).length;
  if (pendingCount === 0) {
    return { exitCode: 0, message: 'No pending entries — nothing to refresh.' };
  }

  const { entries: updated, summary } = await opts.refreshFn(lock.entries);

  if (!opts.dryRun) {
    lock.entries = updated;
    lock.generated_at = new Date().toISOString();
    saveDocConflicts(projectRoot, lock);
  }

  const lines: string[] = [];
  lines.push(formatRefreshBilan(summary, { prefix: opts.dryRun ? 'Dry-run' : 'Refresh done' }));
  if (summary.conversationDir) {
    lines.push(`Transcripts: ${summary.conversationDir}`);
  }
  if (opts.dryRun) {
    lines.push('(dry-run: no changes written)');
  }

  return { exitCode: 0, summary, message: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Shared bilan formatter
// ---------------------------------------------------------------------------

function formatRefreshBilan(summary: RefreshSummary, opts: { prefix: string }): string {
  const auto = summary.autoResolved.dismiss + summary.autoResolved.docWins + summary.autoResolved.codeWins;
  const parts: string[] = [];
  parts.push(`${opts.prefix} — ${auto}/${summary.inspected} auto-resolved`);
  parts.push(`(${summary.autoResolved.dismiss} dismiss · ${summary.autoResolved.docWins} doc-wins · ${summary.autoResolved.codeWins} code-wins)`);
  parts.push(`${summary.stillPending} still pending`);
  if (summary.belowConfidence > 0) parts.push(`${summary.belowConfidence} below confidence`);
  if (summary.errors > 0) parts.push(`${summary.errors} errors`);
  if (summary.cost) {
    const secs = (summary.cost.durationMs / 1000).toFixed(1);
    parts.push(`$${summary.cost.costUsd.toFixed(4)} in ${secs}s (${summary.cost.calls} call${summary.cost.calls !== 1 ? 's' : ''})`);
  }
  return parts.join(' · ');
}
