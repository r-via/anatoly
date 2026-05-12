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
  internalDigest?: { tokens: number; content: string; fingerprint: string } | null,
  arbitratedFragments?: ArbitratedFragment[],
): string {
  if (!referenceDocs || referenceDocs.length === 0) return '';

  const parts: string[] = [];
  parts.push('## REFERENCE DOCUMENTATION (AUTHORITATIVE — human-authored)');
  parts.push('');
  parts.push(
    'Use the following as ground truth. If the code you are reviewing contradicts an invariant, convention, or non-goal stated here, flag it as a `doc_divergence` finding (not as a regular bug).',
  );
  parts.push('');

  for (const doc of referenceDocs) {
    const label = doc.symbol
      ? `### \`${doc.path}\` (source: ${doc.source}, symbol: ${doc.symbol})`
      : `### \`${doc.path}\` (source: ${doc.source})`;
    parts.push(label);
    parts.push('');
    parts.push(doc.content);
    parts.push('');
  }

  // Story 55.5: append evaluated internal digest when present
  if (internalDigest?.content?.includes('status: evaluated')) {
    parts.push('### Internal Reference Digest (source: reference-digest)');
    parts.push('');
    parts.push(internalDigest.content);
    parts.push('');
  }

  // Story 55.7: append arbitrated doc-wins fragments when present
  if (arbitratedFragments && arbitratedFragments.length > 0) {
    parts.push('## ARBITRATED INTERNAL DOCS (human-validated)');
    parts.push('');
    parts.push(
      'The following internal documentation fragments were validated by a human arbitrator as correct (verdict: doc-wins). Treat them as authoritative — flag code that contradicts them as a `doc_divergence` finding.',
    );
    parts.push('');

    for (const frag of arbitratedFragments) {
      const lineInfo = frag.lineRange ? ` (lines ${frag.lineRange[0]}–${frag.lineRange[1]})` : '';
      parts.push(`### \`${frag.referencePath}\`${lineInfo}`);
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
