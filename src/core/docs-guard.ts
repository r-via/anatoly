// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Guard — Story 29.6
 *
 * Runtime guard that enforces the invariant: Anatoly NEVER writes to
 * the project's docs/ directory. Only the clean loop can modify docs/.
 *
 * This function should be called before any file write operation in
 * the pipeline to prevent accidental writes to docs/.
 */

import { resolve, sep } from 'node:path';

/**
 * Throws if the given output path resolves to the project's docs/ directory.
 *
 * @param outputPath - The path about to be written to
 * @param projectRoot - The project root directory
 * @param docsPath - Subdirectory name to guard (defaults to `'docs'`)
 * @throws Error with clear INVARIANT VIOLATION message
 */
export function assertSafeOutputPath(outputPath: string, projectRoot: string, docsPath = 'docs'): void {
  const resolved = resolve(outputPath);
  const docsDir = resolve(projectRoot, docsPath);

  if (resolved === docsDir || resolved.startsWith(docsDir + sep)) {
    throw new Error(
      `INVARIANT VIOLATION: Anatoly must NEVER write to docs/. ` +
      `Attempted path: ${outputPath}. ` +
      `Only the clean loop can modify docs/. ` +
      `Use .anatoly/docs/ for generated documentation.`,
    );
  }
}
