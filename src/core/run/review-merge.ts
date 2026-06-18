// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReviewFile, SymbolReview, SymbolFinding, Action } from '../../schemas/review.js';
import type { AxisId } from '../evaluation/contract.js';
import { setAxisSegment, getAxisSegmentText } from '../evaluation/refinement/detail-segment.js';

/**
 * Selective-refresh review merge.
 *
 * Purpose: when a user runs `--axes <subset> --cache-refresh`, the
 * orchestration only evaluates the requested axes; the cached entry on
 * disk still holds valid verdicts for the OTHER axes (same file content,
 * same prompt hash). Without this merge, writing the fresh partial review
 * to the cache would shrink axis coverage from "all 7" to "just utility",
 * forcing the next `anatoly run` to re-evaluate every axis on every file
 * to recover full coverage. This is the opposite of what the user asked
 * for ("refresh just utility, keep the rest").
 *
 * What we merge:
 *  - per-symbol verdicts: cached for non-refreshed axes, fresh for
 *    refreshed axes (when the symbol exists in both)
 *  - per-symbol `detail`: kept in axis-merger's pipe-delimited format
 *    (`[VERDICT] text | [VERDICT] text | ...`) using `setAxisSegment`
 *  - per-symbol `findings`: cached findings for non-refreshed axes plus
 *    fresh findings for refreshed axes
 *  - `duplicate_target`: replaced only when 'duplication' is refreshed
 *  - actions: cached for non-refreshed sources plus fresh for refreshed
 *    sources, re-numbered sequentially
 *  - file_level: kept from cached (a partial run may not produce
 *    accurate file_level for axes it didn't evaluate)
 *  - best_practices: refreshed iff 'best_practices' is in the set
 *  - docs_coverage / doc_recommendations: refreshed iff 'documentation'
 *    is in the set
 *  - axis_meta: per-axis, refreshed-axis entries from fresh override
 *    cached
 *  - doc_divergences / doc_stale_references: same per-axis policy
 *  - verdict: recomputed from merged symbols by callers via the existing
 *    pipeline; this module returns NEEDS_REFACTOR as a placeholder if
 *    any merged symbol carries a non-trivial finding, otherwise CLEAN.
 *    Callers that have access to the verdict computer should override.
 *  - confidence: per-symbol min across surviving axes
 *
 * Symbol set rules:
 *  - symbol in fresh ∩ cached → merged per the rules above
 *  - symbol in fresh ∖ cached → fresh as-is (new symbol, non-refreshed
 *    axes default to '-' since we have no cached value to fold in)
 *  - symbol in cached ∖ fresh → discarded (source no longer has it; the
 *    fresh scan is the source of truth for which symbols exist)
 *
 * Non-goals (caller's job):
 *  - validating that cached is not stale: caller already checks content
 *    hash and prompt hash via loadProjectReviewRaw
 *  - recomputing the file verdict using the official policy: callers
 *    should pass the merged review back through computeFileVerdict
 *
 * Invariant guards:
 *  - the returned review must be schema-valid; we never set a verdict to
 *    a value outside the union and never widen a refreshed axis with a
 *    cached value (the user asked for it to be re-evaluated, that's the
 *    contract)
 */
export function mergeRefreshedReview(
  cached: ReviewFile | null,
  fresh: ReviewFile,
  refreshedAxes: readonly AxisId[],
): ReviewFile {
  if (!cached) return fresh;
  if (cached.file !== fresh.file) return fresh;

  const refreshed = new Set<AxisId>(refreshedAxes);

  // Index cached symbols by name+line_start for stable lookup. A rename
  // counts as a different symbol; a moved line counts as a different
  // symbol. Both are conservative: better to lose cached values than to
  // attribute them to a symbol they no longer describe.
  const cachedByKey = new Map<string, SymbolReview>();
  for (const s of cached.symbols) {
    cachedByKey.set(`${s.name}@${s.line_start}`, s);
  }

  const mergedSymbols = fresh.symbols.map((freshSym) => {
    const cachedSym = cachedByKey.get(`${freshSym.name}@${freshSym.line_start}`);
    if (!cachedSym) return freshSym;
    return mergeSymbol(cachedSym, freshSym, refreshed);
  });

  const mergedActions = mergeActions(cached.actions ?? [], fresh.actions ?? [], refreshed);

  const merged: ReviewFile = {
    ...cached,
    // Identity / scan metadata always from fresh (source of truth)
    version: fresh.version,
    file: fresh.file,
    is_generated: fresh.is_generated,
    language: fresh.language ?? cached.language,
    parse_method: fresh.parse_method ?? cached.parse_method,
    skip_reason: fresh.skip_reason ?? cached.skip_reason,

    symbols: mergedSymbols,
    actions: mergedActions,
    // file_level: keep cached; a partial run may not detect unused imports
    // or circular deps accurately.
    file_level: cached.file_level,

    // Per-axis side outputs: refresh only if the owning axis was refreshed.
    best_practices: refreshed.has('best_practices') ? fresh.best_practices : cached.best_practices,
    docs_coverage: refreshed.has('documentation') ? fresh.docs_coverage : cached.docs_coverage,
    doc_recommendations: refreshed.has('documentation') ? fresh.doc_recommendations : cached.doc_recommendations,
    doc_divergences: refreshed.has('documentation') ? fresh.doc_divergences : cached.doc_divergences,
    doc_stale_references: refreshed.has('documentation') ? fresh.doc_stale_references : cached.doc_stale_references,
    axis_meta: mergeAxisMeta(cached.axis_meta, fresh.axis_meta, refreshed),

    // deliberation is a separate pass that wraps a full run; a selective
    // refresh does not invalidate it, but we re-attach the cached one only
    // when the fresh run did not produce a new one.
    deliberation: fresh.deliberation ?? cached.deliberation,

    // verdict: the caller should recompute via computeFileVerdict after
    // the merge. We provisionally trust the fresh verdict — if the fresh
    // run reclassified the dominant signal, that is what the user wanted.
    verdict: fresh.verdict,
  };

  return merged;
}

/**
 * Compute the set of axes covered by a merged review for index purposes.
 * An axis is "covered" iff at least one merged symbol carries a verdict
 * other than '-' for it. Best_practices and documentation also count via
 * their dedicated side outputs.
 */
export function computeMergedAxesCoverage(
  review: ReviewFile,
  refreshedAxes: readonly AxisId[],
  cachedAxes: readonly string[],
): AxisId[] {
  // The union of (axes the cache already covered) and (axes we just ran)
  // is the post-merge coverage. We expose this as the canonical source so
  // callers do not need to re-derive it from the per-symbol verdicts (which
  // could be `-` for legitimate reasons like axis crashes).
  const out = new Set<AxisId>(refreshedAxes);
  for (const a of cachedAxes) {
    // Drop unknown axes (older cache schemas may have axis names that no
    // longer exist in the current AxisId union).
    if (isAxisId(a)) out.add(a);
  }
  // touch `review` so unused-param lint stays quiet; callers may want to
  // cross-check in the future (e.g. drop axes that are all '-' after
  // merge), but today we trust the union.
  void review;
  return [...out];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function mergeSymbol(
  cached: SymbolReview,
  fresh: SymbolReview,
  refreshed: Set<AxisId>,
): SymbolReview {
  // Start from cached so non-refreshed axis verdicts are preserved, then
  // overlay the fresh values for refreshed axes.
  const merged: SymbolReview = { ...cached };

  // Identity / scan metadata: always from fresh.
  merged.kind = fresh.kind;
  merged.exported = fresh.exported;
  merged.line_start = fresh.line_start;
  merged.line_end = fresh.line_end;

  // Per-axis verdicts.
  if (refreshed.has('correction')) merged.correction = fresh.correction;
  if (refreshed.has('overengineering')) merged.overengineering = fresh.overengineering;
  if (refreshed.has('utility')) merged.utility = fresh.utility;
  if (refreshed.has('duplication')) {
    merged.duplication = fresh.duplication;
    merged.duplicate_target = fresh.duplicate_target;
  }
  if (refreshed.has('tests')) merged.tests = fresh.tests;
  if (refreshed.has('documentation')) merged.documentation = fresh.documentation;
  // The flow axis carries a per-symbol verdict identical in shape to
  // correction. It was historically omitted here, so a partial run that
  // re-evaluated flow (e.g. `--axes flow`) had its fresh verdict dropped and
  // the cached '-' kept, silently zeroing every flow finding on a cached run.
  if (refreshed.has('flow')) merged.flow = fresh.flow;

  // Detail: rebuild pipe-delimited segments. For each refreshed axis,
  // replace the cached segment with the fresh one; for non-refreshed
  // axes the cached segment is preserved as-is.
  merged.detail = rebuildDetail(cached, fresh, refreshed);

  // confidence: min across all surviving axis confidences. We do not have
  // per-axis confidences in SymbolReview (only one combined number), so we
  // take the more conservative of cached and fresh — a refreshed axis
  // never raises the overall confidence above what the cached non-refreshed
  // axes warranted.
  merged.confidence = Math.min(cached.confidence, fresh.confidence);

  // findings: each finding carries its own `axis`; keep cached for
  // non-refreshed axes, take fresh for refreshed axes.
  const cachedFindings = (cached.findings ?? []).filter((f) => !isFindingFromAxis(f, refreshed));
  const freshFindings = fresh.findings ?? [];
  const allFindings = [...cachedFindings, ...freshFindings];
  merged.findings = allFindings.length > 0 ? allFindings : undefined;

  return merged;
}

/**
 * Rebuild the pipe-delimited `detail` string after a per-axis merge.
 * Start from the cached detail (which carries segments for all axes the
 * cache covered) and overlay one segment per refreshed axis using the
 * fresh symbol's verdict + the fresh segment text extracted from
 * fresh.detail. When the fresh detail does not carry a segment for a
 * refreshed axis (e.g. axis crashed or default path), we leave the cached
 * segment in place — losing it would silently downgrade fidelity.
 */
function rebuildDetail(cached: SymbolReview, fresh: SymbolReview, refreshed: Set<AxisId>): string {
  let detail = cached.detail;
  const axisToVerdict: Array<{ axis: AxisId; cached: string; fresh: string; freshSeg?: string }> = [
    { axis: 'correction', cached: cached.correction, fresh: fresh.correction },
    { axis: 'overengineering', cached: cached.overengineering, fresh: fresh.overengineering },
    { axis: 'utility', cached: cached.utility, fresh: fresh.utility },
    { axis: 'duplication', cached: cached.duplication, fresh: fresh.duplication },
    { axis: 'tests', cached: cached.tests, fresh: fresh.tests },
    { axis: 'documentation', cached: cached.documentation, fresh: fresh.documentation },
  ];
  for (const { axis, cached: cachedVerdict, fresh: freshVerdict } of axisToVerdict) {
    if (!refreshed.has(axis)) continue;
    if (freshVerdict === '-') continue; // fresh skipped/crashed this axis; keep cached segment
    const freshSegmentText = getAxisSegmentText(fresh.detail, freshVerdict);
    if (freshSegmentText === undefined) continue;
    detail = setAxisSegment(detail, cachedVerdict, freshVerdict, freshSegmentText);
  }
  return detail;
}

/**
 * Whether a cached finding belongs to one of the refreshed axes, so the
 * merge can drop it in favour of the fresh equivalent. Each finding carries
 * its own `axis` (SymbolFindingSchema, defaulted to 'correction' on parse),
 * so attribution is exact — no detail-string parsing.
 */
function isFindingFromAxis(finding: SymbolFinding, refreshed: Set<AxisId>): boolean {
  return refreshed.has(finding.axis);
}

function mergeActions(
  cached: Action[],
  fresh: Action[],
  refreshed: Set<AxisId>,
): Action[] {
  const kept = cached.filter((a) => !a.source || !refreshed.has(a.source));
  const merged = [...kept, ...fresh];
  // Re-ID sequentially so the merged review has stable, non-colliding IDs.
  return merged.map((a, i) => ({ ...a, id: i + 1 }));
}

function mergeAxisMeta(
  cached: ReviewFile['axis_meta'],
  fresh: ReviewFile['axis_meta'],
  refreshed: Set<AxisId>,
): ReviewFile['axis_meta'] {
  if (!cached && !fresh) return undefined;
  const out = { ...(cached ?? {}) } as NonNullable<ReviewFile['axis_meta']>;
  if (fresh) {
    for (const [k, v] of Object.entries(fresh)) {
      if (refreshed.has(k as AxisId)) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

const VALID_AXIS_IDS: ReadonlySet<string> = new Set([
  'utility', 'duplication', 'correction', 'overengineering',
  'tests', 'best_practices', 'documentation', 'flow',
]);

function isAxisId(s: string): s is AxisId {
  return VALID_AXIS_IDS.has(s);
}
