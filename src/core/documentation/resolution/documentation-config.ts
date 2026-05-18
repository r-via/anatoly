// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Pure builders for the `documentation` config section. Kept in a neutral
 * module (no commander / clack / cli deps) so both the interactive wizard
 * (`commands/init.ts`) and the v3 yaml writer (`cli/`) can share one source
 * of truth without an import cycle.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DocCommentKind } from '../../../schemas/config.js';

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

/** Well-known doc file/directory candidates for auto-detection. */
const DOC_CANDIDATES: { path: string; glob: string; isDir: boolean }[] = [
  { path: 'docs', glob: 'docs/**/*.md', isDir: true },
  { path: 'README.md', glob: 'README.md', isDir: false },
  { path: 'ARCHITECTURE.md', glob: 'ARCHITECTURE.md', isDir: false },
  { path: 'CONTRIBUTING.md', glob: 'CONTRIBUTING.md', isDir: false },
  { path: 'specs', glob: 'specs/**/*.md', isDir: true },
];

/**
 * Auto-detect documentation paths present in the project root.
 * Returns an array of glob patterns for detected doc sources.
 */
export function detectDocPaths(projectRoot: string): string[] {
  const found: string[] = [];
  for (const candidate of DOC_CANDIDATES) {
    const fullPath = join(projectRoot, candidate.path);
    try {
      if (candidate.isDir) {
        if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
          if (readdirSync(fullPath).length > 0) found.push(candidate.glob);
        }
      } else if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        found.push(candidate.glob);
      }
    } catch {
      // Skip inaccessible paths
    }
  }
  return found;
}

/**
 * The documentation config quick init / first run produces: auto-detected
 * reference paths (fallback `README.md`), inline comments off, doc mode
 * `lite`. Shared by `anatoly init` (quick) and the `anatoly run` first-run
 * path so both entry points emit an identical documentation section.
 */
export function quickInitDocConfig(projectRoot: string): {
  config: DocumentationConfig;
  referencePaths: string[];
} {
  const detected = detectDocPaths(projectRoot);
  const referencePaths = detected.length > 0 ? detected : ['README.md'];
  return {
    config: buildDocumentationConfig({
      referencePaths,
      inlineCommentsEnabled: false,
      internalMode: 'lite',
    }),
    referencePaths,
  };
}
