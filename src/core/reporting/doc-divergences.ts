// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync } from 'node:fs';
import { runEventLogPath } from '../../utils/run-layout.js';
import type { ReviewFile, DocDivergence, DocStaleReference, DocConflictFinding } from '../../schemas/review.js';
import { loadPendingConflictsAsDocConflicts } from '../documentation/index.js';

/** Documentation mode info for report header (FR18). */
export interface DocModeInfo {
  mode: 'full' | 'lite' | 'off';
  digestTokens?: number;
  lastCoherence?: string;
}

/**
 * Collect all doc_divergences from review files into a flat array.
 */
export function aggregateDivergences(reviews: ReviewFile[]): DocDivergence[] {
  const result: DocDivergence[] = [];
  for (const r of reviews) {
    if (r.doc_divergences) {
      result.push(...r.doc_divergences);
    }
  }
  return result;
}

/**
 * Render a markdown section for doc divergences (FR17).
 * Returns empty string when there are no divergences.
 */
export function renderDivergenceSection(divergences: DocDivergence[]): string {
  if (divergences.length === 0) return '';
  const lines: string[] = [];
  lines.push('### Divergences code ↔ reference');
  lines.push('');
  for (const d of divergences) {
    const loc = d.symbol
      ? `\`${d.symbol}\` in \`${d.file}\`${d.line ? `:${d.line}` : ''}`
      : `\`${d.file}\`${d.line ? `:${d.line}` : ''}`;
    lines.push(`- **[${d.axis_origin} · ${d.severity}]** ${loc}`);
    lines.push(`  - Reference (\`${d.reference_source}\`): _"${d.reference_excerpt}"_`);
    lines.push(`  - Observed: ${d.observed_behavior}`);
  }
  return lines.join('\n');
}

/**
 * Collect all doc_stale_references from review files into a flat array.
 */
export function aggregateStaleReferences(reviews: ReviewFile[]): DocStaleReference[] {
  const result: DocStaleReference[] = [];
  for (const r of reviews) {
    if (r.doc_stale_references) {
      result.push(...r.doc_stale_references);
    }
  }
  return result;
}

/**
 * Render a markdown section for stale reference findings (Story 55.8).
 * Returns empty string when there are no stale references.
 */
export function renderStaleReferenceSection(refs: DocStaleReference[]): string {
  if (refs.length === 0) return '';
  const lines: string[] = [];
  lines.push('### Documentation marked stale by arbitration (code-wins)');
  lines.push('');
  for (const r of refs) {
    const loc = r.reference_line_range
      ? `\`${r.reference_path}\` (lines ${r.reference_line_range[0]}–${r.reference_line_range[1]})`
      : `\`${r.reference_path}\``;
    lines.push(`- ${loc} — arbitrated ${r.arbitrated_at}`);
    if (r.arbitration_note) {
      lines.push(`  - Note: ${r.arbitration_note}`);
    }
  }
  return lines.join('\n');
}

/**
 * doc 16 PR 3a — render unresolved code↔reference doc-conflicts. These are
 * detected but unarbitrated: the report states the contradiction and points
 * the reader at `anatoly docs arbitrate`; it does not adjudicate which side
 * is correct. Returns empty string when there are none.
 */
export function renderDocConflictSection(conflicts: DocConflictFinding[]): string {
  if (conflicts.length === 0) return '';
  const lines: string[] = [];
  lines.push('### Unresolved doc conflicts (code ↔ reference) — run `anatoly docs arbitrate`');
  lines.push('');
  for (const c of conflicts) {
    const sym = c.symbol ? `::${c.symbol}` : '';
    const ref = c.reference_line_range
      ? `\`${c.reference_path}\` (lines ${c.reference_line_range[0]}–${c.reference_line_range[1]})`
      : `\`${c.reference_path}\``;
    lines.push(`- \`${c.file}\`${sym} vs ${ref} — detected ${c.detected_at}`);
    lines.push(`  - Reference: ${c.reference_text}`);
    lines.push(`  - Code: ${c.code_summary}`);
  }
  return lines.join('\n');
}

/**
 * Render the Documentation mode line for the report header (FR18).
 */
export function renderDocModeLine(info: DocModeInfo): string {
  switch (info.mode) {
    case 'off':
      return 'Documentation: off';
    case 'lite':
      return `Documentation: lite (digest ${info.digestTokens ?? '?'} tokens)`;
    case 'full':
      return info.lastCoherence
        ? `Documentation: full (last coherence: ${info.lastCoherence})`
        : 'Documentation: full';
  }
}

/**
 * Run start (epoch ms) from the run's `anatoly.ndjson` first event
 * (the "run started" line, always present by report time). Returns
 * undefined when it cannot be established — caller then folds nothing.
 */
function runStartMs(runDir: string | undefined): number | undefined {
  if (!runDir) return undefined;
  try {
    const first = readFileSync(runEventLogPath(runDir), 'utf-8').split('\n', 1)[0];
    const t = (JSON.parse(first) as { time?: unknown }).time;
    return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * doc 16 PR 3a — fold each unresolved (pending) doc-conflict into the
 * correction axis of the matching reviewed symbol as an explained
 * NEEDS_FIX, so it becomes a finding in `axes/correction/shard.N.md`
 * (where every finding lives and the scorer reads), not only a markdown
 * section. Safety-net + dedupe: only flip a symbol whose `correction` is
 * not already a defect (`OK`/`-`), so a conflict the correction axis
 * already caught is NOT double-counted. The `doc-conflicts.yaml` store is
 * untouched (arbitration). A conflict whose file/symbol is not in the
 * reviewed set is left to the markdown section only (no fabricated
 * symbols). Mutates `reviews` in place; returns the number folded.
 */
export function applyPendingConflictsToReviews(
  reviews: ReviewFile[],
  projectRoot: string,
  runDir?: string,
): number {
  const conflicts = loadPendingConflictsAsDocConflicts(projectRoot);
  if (conflicts.length === 0) return 0;
  // doc 16 PR 3a fix: fold ONLY conflicts freshly detected in THIS run.
  // A migrated/stale pending entry (prior run) is low-quality and folding
  // it manufactures correction false positives (bench pr3a-doc16:
  // src/events.ts#SpinEventEmitter, src/engine.ts#spin from May-12/15
  // stale entries). If the run start is unknowable, fold nothing
  // (conservative: never amplify stale junk into NEEDS_FIX).
  const startMs = runStartMs(runDir);
  if (startMs === undefined) return 0;
  let folded = 0;
  for (const c of conflicts) {
    if (!c.symbol) continue;
    const det = Date.parse(c.detected_at);
    if (Number.isNaN(det) || det < startMs) continue; // not fresh this run
    const rf = reviews.find((r) => r.file === c.file);
    if (!rf) continue;
    const sym = rf.symbols.find((s) => s.name === c.symbol);
    if (!sym) continue;
    // dedupe / safety-net: correction already flagged ⇒ leave it (the
    // existing finding scores; a second on the same anchor is a false
    // positive under the bench's bipartite matching).
    if (sym.correction !== 'OK' && sym.correction !== '-') continue;
    sym.correction = 'NEEDS_FIX';
    sym.detail =
      `Unresolved code↔reference doc conflict (detected ${c.detected_at}). ` +
      `Reference (${c.reference_path}): "${c.reference_text}". ` +
      `Code: "${c.code_summary}". ` +
      'The code contradicts its documented contract here; run `anatoly docs arbitrate` to resolve which side is authoritative.';
    folded++;
  }
  return folded;
}
