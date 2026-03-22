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

export interface SymbolCoverage {
  projectDocumented: number;
  internalDocumented: number;
  totalExports: number;
  modulesDocumented?: number;
  totalModules?: number;
}

export interface SyncByType {
  toCreate: number;
  outdated: number;
}

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
  /** Symbol-based coverage (Story 29.20) */
  symbolCoverage?: SymbolCoverage;
  /** Sync status by recommendation type (Story 29.20) */
  syncByType?: SyncByType;
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

  const summary = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  lines.push(`.anatoly/docs/ updated: ${stats.totalPages} pages${summary}`);
  lines.push('');

  // Symbol-based coverage (Story 29.20)
  if (stats.symbolCoverage) {
    const sc = stats.symbolCoverage;
    const projectPct = sc.totalExports === 0 ? 100 : Math.min(100, Math.round((sc.projectDocumented / sc.totalExports) * 100));
    const internalPct = sc.totalExports === 0 ? 100 : Math.min(100, Math.round((sc.internalDocumented / sc.totalExports) * 100));

    lines.push('Documentation coverage:');
    lines.push(`  Project docs (docs/): ${projectPct}% (${Math.min(sc.projectDocumented, sc.totalExports)}/${sc.totalExports} symbols)`);
    lines.push(`  Internal ref (.anatoly/docs/): ${internalPct}% (${Math.min(sc.internalDocumented, sc.totalExports)}/${sc.totalExports} symbols)`);

    if (sc.modulesDocumented !== undefined && sc.totalModules !== undefined) {
      const modPct = sc.totalModules === 0 ? 100 : Math.min(100, Math.round((sc.modulesDocumented / sc.totalModules) * 100));
      lines.push(`  Modules: ${modPct}% (${sc.modulesDocumented}/${sc.totalModules} modules > 200 LOC in project docs)`);
    }
  } else {
    // Fallback: page count only (no symbol data available)
    const pagePct = stats.totalPages > 0
      ? Math.min(100, Math.round((stats.userDocsPageCount / stats.totalPages) * 100))
      : 100;
    lines.push(`Documentation coverage: ${pagePct}% (${stats.userDocsPageCount}/${stats.totalPages} pages)`);
  }

  // Sync status by type (Story 29.20)
  if (stats.syncByType) {
    const parts2: string[] = [];
    if (stats.syncByType.toCreate > 0) parts2.push(`${stats.syncByType.toCreate} pages to create`);
    if (stats.syncByType.outdated > 0) parts2.push(`${stats.syncByType.outdated} pages outdated`);
    if (parts2.length > 0) {
      lines.push('');
      lines.push(`Sync status: ${parts2.join(', ')}`);
    }
  }

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
