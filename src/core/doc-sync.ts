// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Ralph Documentation Sync Mode — Story 29.14
 *
 * Synchronizes the user's docs/ from .anatoly/docs/ using dual-output
 * recommendations. Handles three actionable types:
 *
 * - missing_page: creates a new file from the ideal content
 * - missing_section: appends the missing section to an existing page
 * - outdated_content: replaces only the outdated section
 *
 * Invariants:
 * - Never deletes user-written content
 * - Never reorganizes or renames existing files
 * - All changes are individually revertible via git
 */

import type { DocRecommendation, RecommendationType } from './doc-recommendations.js';

// --- Public types ---

export interface SyncResult {
  path: string;
  type: RecommendationType;
  action: 'created' | 'updated';
  before: string | null;
  after: string;
}

export interface SyncReport {
  applied: SyncResult[];
  skipped: DocRecommendation[];
}

export interface SyncIO {
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
}

/** Types that syncDocs can act on */
const ACTIONABLE_TYPES = new Set<RecommendationType>([
  'missing_page',
  'missing_section',
  'outdated_content',
]);

// --- Main entry point ---

/**
 * Processes documentation recommendations and applies changes to docs/.
 *
 * Uses injected I/O callbacks so the function is pure and testable.
 * Non-actionable recommendation types are returned in skipped.
 *
 * @param recommendations - Array of doc recommendations to process.
 * @param io - Injected I/O callbacks for reading and writing files.
 * @param opts - Optional settings; `docsPath` overrides the target directory
 *               (defaults to `"docs"`).
 * @returns A report of applied sync results and skipped recommendations.
 */
export function syncDocs(
  recommendations: DocRecommendation[],
  io: SyncIO,
  opts?: { docsPath?: string },
): SyncReport {
  const docsPath = opts?.docsPath ?? 'docs';
  const applied: SyncResult[] = [];
  const skipped: DocRecommendation[] = [];

  for (const rec of recommendations) {
    if (!ACTIONABLE_TYPES.has(rec.type)) {
      skipped.push(rec);
      continue;
    }

    const result = applyRecommendation(rec, io, docsPath);
    if (result) {
      applied.push(result);
    } else {
      skipped.push(rec);
    }
  }

  return { applied, skipped };
}

// --- Recommendation handlers ---

function applyRecommendation(
  rec: DocRecommendation,
  io: SyncIO,
  docsPath: string,
): SyncResult | null {
  switch (rec.type) {
    case 'missing_page':
      return applyMissingPage(rec, io, docsPath);
    case 'missing_section':
      return applyMissingSection(rec, io);
    case 'outdated_content':
      return applyOutdatedContent(rec, io);
    default:
      return null;
  }
}

function applyMissingPage(
  rec: DocRecommendation,
  io: SyncIO,
  docsPath: string,
): SyncResult | null {
  const content = io.readFile(rec.content_ref);
  if (content === null) return null;

  const adapted = adaptLinks(content, docsPath);
  io.writeFile(rec.path_user, adapted);

  return {
    path: rec.path_user,
    type: rec.type,
    action: 'created',
    before: null,
    after: adapted,
  };
}

function applyMissingSection(
  rec: DocRecommendation,
  io: SyncIO,
): SyncResult | null {
  if (!rec.section) return null;

  const existing = io.readFile(rec.path_user);
  if (existing === null) return null;

  const idealContent = io.readFile(rec.content_ref);
  if (idealContent === null) return null;

  const sectionContent = extractSection(idealContent, rec.section);
  if (sectionContent === null) return null;

  const updated = appendSection(existing, rec.section, sectionContent);
  io.writeFile(rec.path_user, updated);

  return {
    path: rec.path_user,
    type: rec.type,
    action: 'updated',
    before: existing,
    after: updated,
  };
}

function applyOutdatedContent(
  rec: DocRecommendation,
  io: SyncIO,
): SyncResult | null {
  if (!rec.section) return null;

  const existing = io.readFile(rec.path_user);
  if (existing === null) return null;

  const idealContent = io.readFile(rec.content_ref);
  if (idealContent === null) return null;

  const newSectionContent = extractSection(idealContent, rec.section);
  if (newSectionContent === null) return null;

  const updated = replaceSection(existing, rec.section, newSectionContent);
  io.writeFile(rec.path_user, updated);

  return {
    path: rec.path_user,
    type: rec.type,
    action: 'updated',
    before: existing,
    after: updated,
  };
}

// --- Content helpers ---

/**
 * Replaces .anatoly/docs/ references with docs/ in markdown links.
 */
function adaptLinks(content: string, docsPath = 'docs'): string {
  return content.replace(/\.anatoly\/docs\//g, `${docsPath}/`);
}

/**
 * Extracts a section (heading + body) from markdown content.
 * Returns the text from the heading to the next heading of same or higher level,
 * or to end of file.
 */
function extractSection(content: string, heading: string): string | null {
  const level = heading.match(/^(#+)/)?.[1].length ?? 2;
  const headingText = heading.replace(/^#+\s*/, '');
  const escapedText = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^#{${level}}\\s+${escapedText}\\s*$`,
    'm',
  );

  const match = pattern.exec(content);
  if (!match) return null;

  const start = match.index;
  // Find next heading of same or higher level
  const rest = content.slice(start + match[0].length);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}}\\s`, 'm'));

  if (nextHeading && nextHeading.index !== undefined) {
    return content.slice(start, start + match[0].length + nextHeading.index).trimEnd();
  }
  return content.slice(start).trimEnd();
}

/**
 * Appends a section to the end of a markdown document.
 */
function appendSection(existing: string, _heading: string, sectionContent: string): string {
  const trimmed = existing.trimEnd();
  return `${trimmed}\n\n${sectionContent}\n`;
}

/**
 * Replaces an existing section in markdown content with new content.
 * Adds a Ralph comment before the replaced section.
 */
function replaceSection(
  existing: string,
  heading: string,
  newSectionContent: string,
): string {
  const level = heading.match(/^(#+)/)?.[1].length ?? 2;
  const headingText = heading.replace(/^#+\s*/, '');
  const escapedText = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^#{${level}}\\s+${escapedText}\\s*$`,
    'm',
  );

  const match = pattern.exec(existing);
  if (!match) {
    // Section not found — append instead
    return appendSection(existing, heading, newSectionContent);
  }

  const start = match.index;
  const rest = existing.slice(start + match[0].length);
  const nextHeading = rest.match(new RegExp(`^#{1,${level}}\\s`, 'm'));

  const comment = '<!-- Updated by Ralph: section refreshed to match current code -->';
  let result: string;

  if (nextHeading && nextHeading.index !== undefined) {
    const end = start + match[0].length + nextHeading.index;
    result = existing.slice(0, start) + comment + '\n' + newSectionContent + '\n\n' + existing.slice(end);
  } else {
    result = existing.slice(0, start) + comment + '\n' + newSectionContent + '\n';
  }

  return result;
}
