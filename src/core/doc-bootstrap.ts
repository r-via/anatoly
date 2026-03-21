// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc Bootstrap Helpers — Story 29.21
 *
 * Detection logic for first-run bootstrap and double-pass review decisions.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detect whether this run needs the bootstrap doc phase.
 *
 * Returns true if `.anatoly/docs/` doesn't exist or is incomplete
 * (missing index.md or .cache.json — indicating an interrupted bootstrap).
 */
export function needsBootstrap(projectRoot: string): boolean {
  const docsDir = join(projectRoot, '.anatoly', 'docs');
  if (!existsSync(docsDir)) return true;

  // Both files must exist for a complete bootstrap:
  // - index.md: created by scaffolder
  // - .cache.json: created by doc generation
  const hasIndex = existsSync(join(docsDir, 'index.md'));
  const hasCache = existsSync(join(docsDir, '.cache.json'));
  return !hasIndex || !hasCache;
}

/**
 * Whether to skip the double-pass review on first run.
 *
 * If >= 50% of bootstrap pages failed LLM generation, the double pass
 * would gain little from the incomplete internal docs.
 */
export function shouldSkipDoublePass(pagesFailed: number, totalPages: number): boolean {
  if (totalPages === 0) return false;
  return pagesFailed >= totalPages * 0.5;
}
