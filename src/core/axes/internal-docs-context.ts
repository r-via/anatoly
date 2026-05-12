// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { RelevantDoc } from '../axis-evaluator.js';
import type { Config } from '../../schemas/config.js';

/**
 * Render the internal-docs section for business-logic axis prompts.
 *
 * Internal docs (`.anatoly/docs/`) are auto-generated from code and
 * treated strictly as weak supplementary context — NOT ground truth.
 * The reference docs (human-authored) always win in case of conflict.
 *
 * Only injected when `documentation.internal.mode === 'full'`.
 * Returns an empty string otherwise so the prompt builder can
 * append it unconditionally without polluting the output.
 */
export function renderInternalDocsContext(
  relevantDocs: RelevantDoc[] | undefined,
  config: Config,
): string {
  // Only inject in full mode — lite and off skip internal docs context
  if (config.documentation?.internal?.mode !== 'full') return '';

  const internalDocs = relevantDocs?.filter((d) => d.source === 'internal') ?? [];
  if (internalDocs.length === 0) return '';

  const parts: string[] = [];
  parts.push('## INTERNAL DOCUMENTATION (DERIVED FROM CODE — context only, not ground truth)');
  parts.push('');
  parts.push(
    'Do NOT use this section to flag code. If it contradicts the reference docs above, the reference wins. Treat this strictly as weak supplementary context.',
  );
  parts.push('');
  for (const doc of internalDocs) {
    parts.push(`### \`${doc.path}\``);
    parts.push('');
    parts.push(doc.content);
    parts.push('');
  }
  return parts.join('\n');
}
