// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Report Aggregator — Story 29.15
 *
 * Aggregates documentation data from the pipeline into report components:
 * 1. Resolves user doc plan (once per run)
 * 2. Scores documentation across 5 dimensions
 * 3. Builds dual-output recommendations
 * 4. Renders the "Documentation Reference" report section
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectType } from './language-detect.js';
import { scoreDocumentation, type DocScore, type DocScoringInput } from './doc-scoring.js';
import { resolveUserDocPlan, type DocPageEntry, type UserDocPlan } from './user-doc-plan.js';
import { buildDocRecommendations, type DocGap, type DocRecommendation } from './doc-recommendations.js';
import { renderDocReferenceSection, type DocReportStats } from './doc-report-section.js';
import type { ReviewFile } from '../schemas/review.js';
import type { CacheResult } from './doc-cache.js';
import type { Task } from '../schemas/task.js';

// --- Public interfaces ---

export interface DocReportInput {
  projectRoot: string;
  projectTypes: ProjectType[];
  reviews: ReviewFile[];
  tasks: Task[];
  /** Total pages in .anatoly/docs/ */
  idealPageCount: number;
  /** Cache result from doc generation phase */
  cacheResult?: CacheResult;
  /** Mappings of new pages to source files */
  newPageSources?: { page: string; source: string }[];
  /** Configurable docs directory name (default: 'docs') */
  docsPath?: string;
}

export interface DocReportResult {
  score: DocScore;
  recommendations: DocRecommendation[];
  renderedSection: string;
  userDocPlan: UserDocPlan | null;
}

// --- Main entry point ---

/**
 * Aggregates all documentation data into report components.
 */
export function aggregateDocReport(input: DocReportInput): DocReportResult {
  const docsDir = resolve(input.projectRoot, input.docsPath ?? 'docs');

  const docsPath = input.docsPath ?? 'docs';

  // 1. Resolve user doc plan
  const docPages = scanUserDocs(docsDir);
  const userDocPlan = resolveUserDocPlan(docPages, docsPath);

  // 2. Compute scoring input from reviews
  const scoringInput = buildScoringInput(input, docPages);
  const score = scoreDocumentation(scoringInput);

  // 3. Build gaps from reviews and score
  const gaps = buildGapsFromReviews(input.reviews, score, input.idealPageCount, docPages.length);
  const recommendations = buildDocRecommendations(gaps, userDocPlan, { docsPath });

  // 4. Render report section
  const reportStats = buildReportStats(input, scoringInput, recommendations);
  const renderedSection = renderDocReferenceSection(reportStats);

  return { score, recommendations, renderedSection, userDocPlan };
}

// --- Internal helpers ---

/**
 * Scans user's docs/ directory and returns page entries with head content.
 */
function scanUserDocs(docsDir: string): DocPageEntry[] {
  if (!existsSync(docsDir)) return [];

  const pages: DocPageEntry[] = [];
  scanDir(docsDir, docsDir, pages);
  return pages;
}

function scanDir(baseDir: string, currentDir: string, pages: DocPageEntry[]): void {
  const dirEntries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of dirEntries) {
    const fullPath = join(currentDir, entry.name);
    try {
      if (entry.isDirectory()) {
        scanDir(baseDir, fullPath, pages);
      } else if (entry.name.endsWith('.md')) {
        const relativePath = fullPath.slice(baseDir.length + 1);
        let headContent = '';
        try {
          const content = readFileSync(fullPath, 'utf-8');
          headContent = content.split('\n').slice(0, 5).join('\n');
        } catch {
          // Skip unreadable
        }
        pages.push({ path: relativePath, headContent });
      }
    } catch {
      // Skip
    }
  }
}

/**
 * Builds scoring input from reviews and doc page data.
 */
function buildScoringInput(
  input: DocReportInput,
  userDocPages: DocPageEntry[],
): DocScoringInput {
  let projectExportsDocumented = 0;
  let internalExportsDocumented = 0;
  let totalExports = 0;
  let modulesDocumented = 0;

  for (const review of input.reviews) {
    for (const sym of review.symbols) {
      if (sym.exported) {
        totalExports++;
        if (sym.documentation === 'DOCUMENTED') {
          projectExportsDocumented++;
        }
        // Count internal coverage from docs_coverage axis data
        if (sym.documentation === 'DOCUMENTED' || sym.documentation === 'PARTIAL') {
          internalExportsDocumented++;
        }
      }
    }
  }

  // Count modules > 200 LOC from tasks
  const moduleDirs = new Map<string, number>();
  for (const task of input.tasks) {
    const parts = task.file.split('/');
    const srcIdx = parts.indexOf('src');
    const dirIdx = srcIdx >= 0 ? srcIdx + 1 : 0;
    if (dirIdx < parts.length - 1) {
      const dirName = parts[dirIdx];
      const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));
      moduleDirs.set(dirName, (moduleDirs.get(dirName) ?? 0) + maxLine);
    }
  }

  const totalModules = Array.from(moduleDirs.values()).filter(loc => loc >= 200).length;

  // Count modules >= 200 LOC that have a doc page
  for (const [dirName, loc] of moduleDirs) {
    if (loc < 200) continue;
    const hasPage = userDocPages.some(p =>
      p.path.toLowerCase().includes(dirName.toLowerCase()),
    );
    if (hasPage) modulesDocumented++;
  }

  // Content quality: use docs_coverage score from reviews if available
  const coverageScores = input.reviews
    .filter(r => r.docs_coverage)
    .map(r => r.docs_coverage!.score_pct);
  const contentQualityPercent = coverageScores.length > 0
    ? Math.round(coverageScores.reduce((a, b) => a + b, 0) / coverageScores.length)
    : 0;

  return {
    userDocPages: userDocPages.map(p => p.path),
    idealPageCount: input.idealPageCount,
    projectTypes: input.projectTypes,
    projectExportsDocumented,
    internalExportsDocumented,
    totalExports,
    modulesDocumented,
    totalModules,
    contentQualityPercent,
  };
}

/**
 * Builds documentation gaps from review data for recommendation generation.
 */
function buildGapsFromReviews(
  reviews: ReviewFile[],
  _score: DocScore,
  idealPageCount: number,
  userPageCount: number,
): DocGap[] {
  const gaps: DocGap[] = [];

  // Gap from sync gap: missing pages
  if (idealPageCount > userPageCount) {
    const missing = idealPageCount - userPageCount;
    gaps.push({
      type: 'missing_page',
      idealPath: '.anatoly/docs/',
      rationale: `User docs/ has ${userPageCount} pages vs ${idealPageCount} ideal pages (${missing} missing)`,
      priority: 'high',
    });
  }

  // Gaps from undocumented exports
  for (const review of reviews) {
    for (const sym of review.symbols) {
      if (sym.exported && sym.documentation === 'UNDOCUMENTED') {
        gaps.push({
          type: 'missing_jsdoc',
          idealPath: `04-API-Reference/01-Public-API.md`,
          rationale: `Exported ${sym.kind} ${sym.name} in ${review.file} has no JSDoc`,
          priority: 'medium',
        });
      }
    }

    // Gaps from docs_coverage concepts
    if (review.docs_coverage) {
      for (const concept of review.docs_coverage.concepts) {
        if (concept.status === 'MISSING') {
          gaps.push({
            type: 'missing_page',
            idealPath: concept.doc_path ?? '05-Modules/unknown.md',
            rationale: `Documentation concept "${concept.name}" is missing: ${concept.detail}`,
            priority: 'medium',
          });
        } else if (concept.status === 'OUTDATED') {
          gaps.push({
            type: 'outdated_content',
            idealPath: concept.doc_path ?? '05-Modules/unknown.md',
            rationale: `Documentation for "${concept.name}" is outdated: ${concept.detail}`,
            priority: 'high',
            existingUserPath: concept.doc_path ?? undefined,
          });
        }
      }
    }
  }

  return gaps;
}

/**
 * Builds report stats from pipeline data.
 */
function buildReportStats(
  input: DocReportInput,
  scoringInput: DocScoringInput,
  recommendations: DocRecommendation[],
): DocReportStats {
  const newPages = input.newPageSources ?? [];
  const refreshedPages = input.cacheResult?.stale ?? [];
  const cachedPages = input.cacheResult?.fresh ?? [];

  const docsDir = resolve(input.projectRoot, input.docsPath ?? 'docs');
  let userDocsPageCount = 0;
  if (existsSync(docsDir)) {
    userDocsPageCount = countMdFiles(docsDir);
  }

  // Symbol-based coverage (Story 29.20)
  const symbolCoverage = {
    projectDocumented: scoringInput.projectExportsDocumented,
    internalDocumented: scoringInput.internalExportsDocumented,
    totalExports: scoringInput.totalExports,
    modulesDocumented: scoringInput.modulesDocumented,
    totalModules: scoringInput.totalModules,
  };

  // Sync status by recommendation type (Story 29.20)
  const toCreate = recommendations.filter(r => r.type === 'missing_page').length;
  const outdated = recommendations.filter(r => r.type === 'outdated_content').length;
  const syncByType = (toCreate > 0 || outdated > 0) ? { toCreate, outdated } : undefined;

  return {
    totalPages: input.idealPageCount,
    newPages,
    refreshedPages,
    cachedPages,
    userDocsPageCount,
    symbolCoverage,
    syncByType,
  };
}

function countMdFiles(dir: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countMdFiles(join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        count++;
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return count;
}
