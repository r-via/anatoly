// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Helpers for the pipe-delimited `SymbolReview.detail` format produced by
 * axis-merger: one segment per axis tagged by its verdict, joined by ` | `.
 *
 *     [VERDICT_A] text A | [VERDICT_B] text B | ...
 *
 * The reader side (`axisDetail` in render-axis.ts) locates each axis's
 * segment by its `[VERDICT] ` prefix. Refinement tiers that reclassify a
 * single axis must replace ONLY that axis's segment — assigning a flat
 * string would wipe every other axis's rationale and force the reader's
 * fallback to surface the tier-mutated text on every axis (the bug fixed
 * here: utility tier1 detail leaking to correction / tests / documentation
 * rows in the public report).
 *
 * Verdict tags are globally distinct across axes (USED / DEAD / OK / OVER
 * / GOOD / DOCUMENTED / etc.) so matching by `[VERDICT]` prefix is
 * unambiguous.
 */

/**
 * Replace (or append, if missing) the segment for one axis in a
 * pipe-delimited `detail` string.
 *
 * @param mergedDetail - The current `SymbolReview.detail` string.
 * @param fromVerdict  - Verdict tag currently present for the axis being
 *   reclassified (used to locate the existing segment).
 * @param toVerdict    - New verdict tag to write.
 * @param text         - Rationale text for the new segment.
 */
export function setAxisSegment(
  mergedDetail: string,
  fromVerdict: string,
  toVerdict: string,
  text: string,
): string {
  const fromTag = `[${fromVerdict}] `;
  const newSegment = `[${toVerdict}] ${text}`;
  const segments = mergedDetail.split(' | ');
  let replaced = false;
  const updated = segments.map((seg) => {
    if (!replaced && seg.startsWith(fromTag)) {
      replaced = true;
      return newSegment;
    }
    return seg;
  });
  if (!replaced) updated.push(newSegment);
  return updated.join(' | ');
}

/**
 * Extract the rationale text for a given verdict tag from a pipe-delimited
 * `detail` string. Returns undefined when no matching segment exists.
 * Used to fold the pre-reclassification rationale into the new segment
 * (e.g. "was ERROR: <original error text>" when downgrading to NEEDS_FIX).
 */
export function getAxisSegmentText(mergedDetail: string, verdict: string): string | undefined {
  const tag = `[${verdict}] `;
  for (const seg of mergedDetail.split(' | ')) {
    if (seg.startsWith(tag)) return seg.slice(tag.length);
  }
  return undefined;
}
