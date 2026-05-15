// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReferenceDoc } from '../reference-docs-resolver.js';

// ---------------------------------------------------------------------------
// Story 55.7: Arbitrated fragment — a doc-wins entry promoted to authority
// ---------------------------------------------------------------------------

/** A doc fragment that a human arbitrator validated as authoritative via `doc-wins`. */
export interface ArbitratedFragment {
  referencePath: string;
  lineRange?: [number, number];
  text: string;
  arbitratedAt: string;
  note?: string;
}

/**
 * Render the reference-docs section for business-logic axis prompts.
 *
 * Reference docs are human-authored (README, specs, doc comments) and
 * treated as authoritative ground truth. The LLM should flag any code
 * that contradicts them as a `doc_divergence` finding.
 *
 * Returns an empty string when no reference docs are available so the
 * prompt builder can append it unconditionally.
 */
export function renderReferenceDocsContext(
  referenceDocs: ReferenceDoc[] | null | undefined,
  arbitratedFragments?: ArbitratedFragment[],
): string {
  const hasReferenceDocs = referenceDocs && referenceDocs.length > 0;
  const hasArbitratedFragments = !!arbitratedFragments && arbitratedFragments.length > 0;

  // Early-return only when no authoritative source is available. Without
  // this guard, an empty referenceDocs would suppress the arbitrated
  // fragments (Story 55.7), which is an independent authoritative source.
  if (!hasReferenceDocs && !hasArbitratedFragments) {
    return '';
  }

  const parts: string[] = [];
  parts.push('## REFERENCE DOCUMENTATION (AUTHORITATIVE — human-authored or human-validated)');
  parts.push('');
  parts.push(
    'Use the following as ground truth. If the code you are reviewing contradicts an invariant, convention, or non-goal stated here, flag it as a `doc_divergence` finding (not as a regular bug).',
  );
  parts.push('');

  // 1. Human-authored reference docs. In lite mode these are the per-file
  //    RAG-retrieved doc chunks (README, specs, docs/); in full mode they
  //    are augmented by the arbitrated fragments below.
  if (hasReferenceDocs) {
    for (const doc of referenceDocs!) {
      const label = doc.symbol
        ? `### \`${doc.path}\` (source: ${doc.source}, symbol: ${doc.symbol})`
        : `### \`${doc.path}\` (source: ${doc.source})`;
      parts.push(label);
      parts.push('');
      parts.push(doc.content);
      parts.push('');
    }
  }

  // 2. Story 55.7: arbitrated doc-wins fragments (human-validated intent
  //    baked in via the arbitration loop — independent authoritative source
  //    even when no reference docs are configured)
  if (hasArbitratedFragments) {
    parts.push('### ARBITRATED INTENTS (human-validated via `anatoly docs arbitrate`)');
    parts.push('');
    parts.push(
      'A human arbitrator has CONFIRMED the following statements as the intended behavior of the code (verdict: doc-wins). These are not "documentation that the code might disagree with" — they are the agreed-upon contract. If the code under review contradicts one of these statements, that is a **regular correctness bug**: emit it as a normal finding on your axis (e.g. `correction: NEEDS_FIX`) with a clear `detail` referencing the arbitrated intent. Do NOT emit `doc_divergence` for these — divergences from arbitrated intents are bugs, not unresolved doc/code disagreements.',
    );
    parts.push('');

    for (const frag of arbitratedFragments!) {
      const lineInfo = frag.lineRange ? ` (lines ${frag.lineRange[0]}–${frag.lineRange[1]})` : '';
      parts.push(`#### \`${frag.referencePath}\`${lineInfo}`);
      parts.push('');
      parts.push(frag.text);
      if (frag.note) {
        parts.push('');
        parts.push(`> Note: ${frag.note}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}
