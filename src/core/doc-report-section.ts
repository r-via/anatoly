// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Reference Section in Report — Story 29.11
 *
 * Renders a Markdown section for the audit report showing:
 * - .anatoly/docs/ generation summary (new, refreshed, cached)
 * - Coverage comparison: docs/ vs .anatoly/docs/
 * - List of newly generated pages with their source files
 */

// --- Public interfaces ---

export interface DocReportStats {
  /** Total pages in .anatoly/docs/ */
  totalPages: number;
  /** Pages newly generated this run */
  newPages: { page: string; source: string }[];
  /** Pages regenerated because source changed */
  refreshedPages: string[];
  /** Pages unchanged (cache hit) */
  cachedPages: string[];
  /** Number of pages in user's docs/ directory */
  userDocsPageCount: number;
}

// --- Renderer ---

/**
 * Renders the "Documentation Reference" section for the audit report.
 * Returns a Markdown string ready to be appended to the master report.
 */
export function renderDocReferenceSection(stats: DocReportStats): string {
  const lines: string[] = [];

  lines.push('## Documentation Reference');
  lines.push('');

  // Page generation summary
  const parts: string[] = [];
  if (stats.newPages.length > 0) parts.push(`${stats.newPages.length} new`);
  if (stats.refreshedPages.length > 0)
    parts.push(`${stats.refreshedPages.length} refreshed`);
  if (stats.cachedPages.length > 0)
    parts.push(`${stats.cachedPages.length} cached`);

  lines.push(
    `.anatoly/docs/ updated: ${stats.totalPages} pages (${parts.join(', ')})`,
  );
  lines.push('');

  // Coverage comparison
  const coverage =
    stats.totalPages > 0
      ? Math.round((stats.userDocsPageCount / stats.totalPages) * 100)
      : 100;
  const syncGap = Math.max(0, stats.totalPages - stats.userDocsPageCount);

  lines.push('Your docs/ vs .anatoly/docs/:');
  lines.push(
    `  docs/ coverage: ${coverage}% (${stats.userDocsPageCount}/${stats.totalPages} pages)`,
  );
  lines.push(`  Sync gap: ${syncGap} pages`);

  // New pages listing
  if (stats.newPages.length > 0) {
    lines.push('');
    lines.push('New pages generated:');
    for (const { page, source } of stats.newPages) {
      lines.push(`  + .anatoly/docs/${page}  (from ${source})`);
    }
  }

  return lines.join('\n');
}
