// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Pure builders for the `documentation` config section. Kept in a neutral
 * module (no commander / clack / cli deps) so both the interactive wizard
 * (`commands/init.ts`) and the v3 yaml writer (`cli/`) can share one source
 * of truth without an import cycle.
 */

import type { DocCommentKind } from '../schemas/config.js';

export interface DocWizardSelections {
  referencePaths: string[];
  inlineCommentsEnabled: boolean;
  inlineCommentKinds?: DocCommentKind[];
  inlineCommentInclude?: string[];
  internalMode: 'full' | 'lite' | 'off';
}

export interface DocumentationConfig {
  reference: {
    paths: string[];
    inline_comments: {
      enabled: boolean;
      kinds?: DocCommentKind[];
      include?: string[];
    };
  };
  internal: {
    mode: 'full' | 'lite' | 'off';
    full?: { sync_to_repo: boolean };
  };
}

/**
 * Build a documentation config object from wizard selections.
 * Matches the DocumentationConfigSchema shape.
 */
export function buildDocumentationConfig(selections: DocWizardSelections): DocumentationConfig {
  const reference: DocumentationConfig['reference'] = {
    paths: selections.referencePaths,
    inline_comments: { enabled: selections.inlineCommentsEnabled },
  };

  if (selections.inlineCommentsEnabled && selections.inlineCommentKinds) {
    reference.inline_comments.kinds = selections.inlineCommentKinds;
    reference.inline_comments.include = selections.inlineCommentInclude ?? [];
  }

  const internal: DocumentationConfig['internal'] = { mode: selections.internalMode };

  // lite mode needs no sub-config: reference docs are retrieved per-file via
  // RAG at review time. Only full mode carries a sub-block.
  if (selections.internalMode === 'full') {
    internal.full = { sync_to_repo: false };
  }

  return { reference, internal };
}

/**
 * The documentation config used when no interactive choices are made
 * (first run / quick init): `mode: lite` (per-file RAG retrieval, docs
 * trusted as-is), `README.md` as the sole reference path, inline comments
 * off. Single source of truth shared with the first-run yaml writer so the
 * generated documentation section never drifts between entry paths.
 */
export function defaultDocumentationConfig(): DocumentationConfig {
  return buildDocumentationConfig({
    referencePaths: ['README.md'],
    inlineCommentsEnabled: false,
    internalMode: 'lite',
  });
}
