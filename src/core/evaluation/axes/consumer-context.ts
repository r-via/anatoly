// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { AxisContext } from '../contract.js';

/** Max consumer functions listed per exported symbol before truncation. */
const MAX_CONSUMERS_RENDERED = 6;

/**
 * Render the cross-file consumer context shared by all axes: for each exported
 * symbol of the file under review, the project functions that actually consume
 * it (signature + behavioral summary), resolved by joining the usage graph with
 * RAG `referencedImports`.
 *
 * This is downstream-usage ground truth, useful to every axis in its own way:
 *  - correction: blast radius of changing a symbol's contract (don't break a
 *    consumer that reads it; don't propose adding a guard a consumer already has);
 *  - overengineering: an abstraction with one trivial consumer is over-built;
 *  - utility: a symbol whose only consumers are themselves dead is dead;
 *  - duplication: consolidation impact (how many consumers each copy has);
 *  - tests / documentation: high fan-in symbols are priority surface.
 *
 * Absent in RAG-off mode (no cards) → returns '' so builders can append it
 * unconditionally. Recall-safe: it is evidence about real usage, never an
 * instruction to suppress a finding.
 */
export function renderConsumerContext(ctx: AxisContext): string {
  const entries = ctx.consumerContext;
  if (!entries || entries.length === 0) return '';

  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.consumers.length === 0) continue;
    const shown = entry.consumers.slice(0, MAX_CONSUMERS_RENDERED);
    const extra = entry.consumers.length - shown.length;
    const lines = shown.map((c) => {
      const sig = c.signature?.trim() || c.name;
      return `  - \`${sig}\` (${c.file})${c.summary ? ` — ${c.summary}` : ''}`;
    });
    blocks.push(
      `- \`${entry.symbol}\` is consumed by:`,
      ...lines,
      ...(extra > 0 ? [`  - …and ${extra} more`] : []),
    );
  }

  if (blocks.length === 0) return '';

  return [
    '## Consumers (how this file\'s exports are used)',
    '',
    'Project functions that actually reference each exported symbol of this file,',
    'resolved across the codebase (function-level). Use this as ground truth for',
    'downstream usage: a symbol with live consumers must not have its contract',
    'changed or removed without accounting for them; a guard or fallback a',
    'consumer already performs need not be re-added; a symbol with no consumers',
    'anywhere is unused. Static-reference based, so a dynamically/framework-',
    'invoked consumer may not appear — treat it as evidence, not proof.',
    '',
    ...blocks,
    '',
  ].join('\n');
}
