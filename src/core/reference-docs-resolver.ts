// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Reference-docs resolver — Story 54.4
 *
 * Unified collection of human-authored reference documentation:
 * markdown files matched by glob patterns + structured doc-comments
 * extracted from source files via tree-sitter adapters.
 */

import { readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { glob } from 'tinyglobby';
import type { Config } from '../schemas/config.js';
import type { DocCommentKind } from '../schemas/config.js';
import { resolveAdapter } from './language-adapters.js';
import { parseToRootNode } from './scanner.js';
import { getLogger } from '../utils/logger.js';

// --- Public types ---

export interface ReferenceDoc {
  source: 'md' | 'readme' | 'spec' | 'comment';
  path: string;
  content: string;
  symbol?: string;
  lang?: string;
}

// --- Source classification ---

/** Classify a file path into a reference doc source type. */
export function classifySource(filePath: string): 'md' | 'readme' | 'spec' {
  const base = basename(filePath).toLowerCase();
  if (base === 'readme.md') return 'readme';
  if (filePath.startsWith('specs/') || filePath.startsWith('specs\\')) return 'spec';
  return 'md';
}

// --- Main resolver ---

/**
 * Resolve all human-authored reference documentation for the project.
 * Collects markdown files from `reference.paths` globs and optionally
 * extracts structured doc-comments from source files.
 */
export async function resolveReferenceDocs(
  projectRoot: string,
  config: Config,
): Promise<ReferenceDoc[]> {
  const docConfig = config.documentation;
  if (!docConfig?.reference) return [];

  const logger = getLogger();
  const results: ReferenceDoc[] = [];

  // 1. Resolve markdown files from reference.paths
  for (const pattern of docConfig.reference.paths) {
    let matched: string[];
    try {
      matched = await glob([pattern], { cwd: projectRoot });
    } catch {
      logger.warn(`failed to glob pattern ${pattern}`);
      continue;
    }

    if (matched.length === 0) {
      logger.info(`no files matched for pattern ${pattern}`);
      continue;
    }

    for (const file of matched) {
      try {
        const content = await readFile(join(projectRoot, file), 'utf-8');
        results.push({
          source: classifySource(file),
          path: file,
          content,
        });
      } catch {
        logger.warn(`failed to read reference doc ${file}`);
      }
    }
  }

  // 2. Extract inline doc-comments if enabled
  const inlineConfig = docConfig.reference.inline_comments;
  if (inlineConfig?.enabled && inlineConfig.kinds?.length && inlineConfig.include?.length) {
    const kinds = inlineConfig.kinds as DocCommentKind[];
    let sourceFiles: string[];
    try {
      sourceFiles = await glob(inlineConfig.include, { cwd: projectRoot });
    } catch {
      sourceFiles = [];
    }

    for (const file of sourceFiles) {
      const ext = extname(file);
      const adapter = resolveAdapter(ext);
      if (!adapter?.extractDocComments) continue;

      let source: string;
      try {
        source = await readFile(join(projectRoot, file), 'utf-8');
      } catch {
        continue;
      }

      const rootNode = await parseToRootNode(source, adapter);
      if (!rootNode) {
        logger.warn(
          `skipping doc-comment extraction for ${adapter.languageId}: grammar not available`,
        );
        continue;
      }

      const comments = adapter.extractDocComments(rootNode, source, kinds);
      for (const comment of comments) {
        results.push({
          source: 'comment',
          path: file,
          content: comment.cleaned,
          symbol: comment.symbol,
          lang: adapter.languageId,
        });
      }
    }
  }

  // 3. Log summary
  const counts = { md: 0, readme: 0, spec: 0, comment: 0 };
  for (const r of results) counts[r.source]++;
  logger.info(
    `resolved ${results.length} reference docs (md: ${counts.md}, readme: ${counts.readme}, spec: ${counts.spec}, comment: ${counts.comment})`,
  );

  return results;
}
