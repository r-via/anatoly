// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync } from 'node:fs';
import { runEventLogPath } from '../../utils/run-layout.js';
import type { ReviewFile, DocDivergence, DocStaleReference, DocConflictFinding } from '../../schemas/review.js';
// Import directly from the defining module, not the documentation/ barrel: the
// barrel pulls the whole doc subsystem (generation, conflict detection…), part
// of which imports back into reporting/, forming an ESM import cycle that left
// reporting/ barrel exports (renderDivergenceSection, aggregateReviews…)
// undefined under parallel test collection. The specific module has no such
// back-edge, so this keeps the dependency acyclic.
import { loadPendingConflictsAsDocConflicts } from '../documentation/conflict/doc-stale-reference.js';

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

/**
 * Fold each confirmed invariant finding (from the `invariants` pipeline
 * phase) into the correction axis of its symbol as an explained NEEDS_FIX,
 * so it becomes a finding in `axes/correction/shard.N.md` (where every
 * finding lives and the scorer reads), not only carried on the review.
 * Mirrors applyPendingConflictsToReviews: safety-net + dedupe — only flip a
 * symbol whose `correction` is not already a defect (`OK`/`-`), so an
 * inconsistency the correction axis already caught is NOT double-counted. The
 * invariant findings already live on the reviews (written by the phase before
 * deliberation), so no external store or fresh-this-run gate is needed.
 * Mutates `reviews` in place; returns the number folded.
 */
export function applyInvariantFindingsToReviews(reviews: ReviewFile[]): number {
  let folded = 0;
  for (const rf of reviews) {
    for (const sym of rf.symbols) {
      const findings = sym.invariant_findings;
      if (!findings || findings.length === 0) continue;
      // dedupe / safety-net: correction already flagged ⇒ leave it (the
      // existing finding scores; a second on the same anchor is a false
      // positive under the bench's bipartite matching).
      if (sym.correction !== 'OK' && sym.correction !== '-') continue;
      // Fold the first finding (one symbol carries at most one
      // inter-representation pair in increment 1); its detail + counterpart
      // explain the inconsistency.
      const f = findings[0]!;
      const counterpart = f.counterpart
        ? ` Counterpart: \`${f.counterpart.symbol}\` in \`${f.counterpart.file}\`.`
        : '';
      sym.correction = 'NEEDS_FIX';
      if (f.invariant === 'numerical_target') {
        sym.detail =
          `Numerical-target inconsistency: this constant table cannot produce the ` +
          `documented numeric target derived elsewhere in the codebase.${counterpart} ` +
          `${f.detail}`;
      } else {
        sym.detail =
          `Inter-representation inconsistency: this symbol and a counterpart compute ` +
          `the same named quantity but disagree in value or direction.${counterpart} ` +
          `${f.detail}`;
      }
      folded++;
    }
  }
  return folded;
}

/**
 * Fold a documented-constant contradiction into the correction axis.
 *
 * When the correction axis reviews a data-only file (e.g. a constant table)
 * and an authoritative reference doc is in context (documentation lite/full
 * injects it; RAG declaration indexing — c56a3e4 — is what lets the reference
 * chunk reach a file that exports no function), the axis emits the
 * code↔reference contradiction as a `doc_divergence` with verdict OK rather
 * than a bug: by policy (correction.system.md), a value that contradicts a
 * documented *target* is "documentation may be stale", not a code defect, so
 * it is surfaced informationally and never scored. That policy makes a real
 * spec-contradicting constant (INV-DWELL: `DWELL_TICKS = 6` vs a documented
 * "2 ticks") invisible to the correction axis the bench scores.
 *
 * This fold promotes the narrow, high-confidence slice of those divergences —
 * a *numeric* contradiction of a *constant/variable* the axis already reviewed —
 * to an explained correction NEEDS_FIX, the same scorable home
 * (`axes/correction/shard.N.md`) as every finding. The doc_divergence stays on
 * the review (the markdown "Divergences code ↔ reference" section still renders
 * it; arbitration is unaffected): we surface the contradiction, we do not
 * adjudicate which side is authoritative — the detail points at
 * `anatoly docs arbitrate`.
 *
 * Tight gates keep precision (train-dispatch runs at 1.0):
 *  - `axis_origin === 'correction'` (only the correction axis's own divergences;
 *    best_practices/overengineering/tests divergences are out of scope);
 *  - the divergence anchors a reviewed symbol of kind `constant`/`variable`
 *    (a documented *value*, not a function-behavior divergence — murkier, higher FP);
 *  - the `reference_excerpt` contains a digit (a documented numeric target to
 *    contradict — guards against vague prose divergences);
 *  - safety-net + dedupe: only flip a symbol whose `correction` is not already a
 *    defect (`OK`/`-`), so a contradiction the axis (or an earlier fold) already
 *    caught is NOT double-counted under the bench's bipartite matching.
 *
 * Runs AFTER applyPendingConflictsToReviews / applyInvariantFindingsToReviews so
 * a symbol either of those promoted is already NEEDS_FIX and skipped here.
 * Mutates `reviews` in place; returns the number folded.
 */
export function applyDocumentedConstantDivergences(reviews: ReviewFile[]): number {
  let folded = 0;
  for (const rf of reviews) {
    const divergences = rf.doc_divergences;
    if (!divergences || divergences.length === 0) continue;
    for (const dv of divergences) {
      if (dv.axis_origin !== 'correction') continue;
      if (!dv.symbol) continue;
      // A documented numeric target is required: the excerpt must carry a digit.
      if (!/\d/.test(dv.reference_excerpt)) continue;
      const sym = rf.symbols.find((s) => s.name === dv.symbol);
      if (!sym) continue;
      // Only a documented *value* (constant/variable), never a function-behavior
      // divergence (out of scope, higher FP).
      if (sym.kind !== 'constant' && sym.kind !== 'variable') continue;
      // dedupe / safety-net: correction already flagged ⇒ leave it.
      if (sym.correction !== 'OK' && sym.correction !== '-') continue;
      sym.correction = 'NEEDS_FIX';
      sym.detail =
        `Documented-constant contradiction: this value contradicts an authoritative ` +
        `documented target. Reference (${dv.reference_source}): "${dv.reference_excerpt}". ` +
        `Observed: ${dv.observed_behavior}. ` +
        'The code contradicts its documented contract here; run `anatoly docs arbitrate` to resolve which side is authoritative.';
      folded++;
    }
  }
  return folded;
}
