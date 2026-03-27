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
import { extractModuleName } from './module-granularity.js';
import { scoreDocumentation, type DocScore, type DocScoringInput } from './doc-scoring.js';
import { resolveUserDocPlan, type DocPageEntry, type UserDocPlan } from './user-doc-plan.js';
import { buildDocRecommendations, type DocGap, type DocRecommendation } from './doc-recommendations.js';
import { renderDocReferenceSection, type DocReportStats } from './doc-report-section.js';
import type { ReviewFile } from '../schemas/review.js';
import type { CacheResult } from './doc-cache.js';
import type { Task } from '../schemas/task.js';

// --- Public interfaces ---

/**
 * Input bundle for the documentation report aggregation pipeline.
 *
 * Carries project metadata, review results, and task data needed to score
 * documentation coverage, detect gaps, and render the final report section.
 */
export interface DocReportInput {
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Detected project types (e.g. 'node', 'python') that influence scoring weights. */
  projectTypes: ProjectType[];
  /** Per-file review results containing symbol documentation status and docs_coverage data. */
  reviews: ReviewFile[];
  /** Parsed task entries used to estimate module LOC for coverage calculations. */
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
 *
 * Orchestrates the four-step pipeline: (1) resolve the user doc plan from
 * their docs/ directory, (2) compute documentation scoring input and score,
 * (3) build gap analysis from reviews, and (4) render the final report section.
 *
 * @param input - Bundled project metadata, reviews, and task data for the pipeline.
 * @returns Score, recommendations, rendered report section, and resolved user doc plan.
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
  let dirEntries;
  try {
    dirEntries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

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
 *
 * Aggregates two export-coverage counters: `projectExportsDocumented` counts
 * only DOCUMENTED exports (strict public-API metric), while
 * `internalExportsDocumented` also includes PARTIAL exports (lenient internal
 * metric). Modules with >= 200 LOC (estimated from task symbol line ranges)
 * are checked for matching user doc pages. Content quality is derived from the
 * average `docs_coverage.score_pct` across reviews.
 *
 * @param input - The full pipeline input containing reviews, tasks, and project metadata.
 * @param userDocPages - Doc page entries scanned from the user's docs/ directory.
 * @returns A {@link DocScoringInput} ready for {@link scoreDocumentation}.
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
    const dirName = extractModuleName(task.file);
    if (!dirName) continue;
    const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));
    moduleDirs.set(dirName, (moduleDirs.get(dirName) ?? 0) + maxLine);
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
 *
 * Produces three gap categories:
 * - `missing_page` when user docs/ has fewer pages than the ideal count.
 * - `missing_jsdoc` for each exported symbol marked UNDOCUMENTED (placed under
 *   the convention path `04-API-Reference/01-Public-API.md`).
 * - `missing_page` / `outdated_content` from per-review `docs_coverage` concepts
 *   (falls back to `05-Modules/unknown.md` when no doc_path is provided).
 *
 * @param reviews - Per-file review results containing symbol and docs_coverage data.
 * @param _score - Reserved for future score-aware gap weighting (currently unused).
 * @param idealPageCount - Target number of documentation pages for the project.
 * @param userPageCount - Actual number of markdown pages in the user's docs/ directory.
 * @returns An array of {@link DocGap} entries for downstream recommendation building.
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
          type: 'missing_jsdoc', // canonical enum value regardless of language (JSDoc, docstring, doc comment)
          idealPath: `04-API-Reference/01-Public-API.md`,
          rationale: `Exported ${sym.kind} ${sym.name} in ${review.file} has no documentation`,
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
 *
 * Assembles page counts (new, refreshed, cached), symbol-level coverage
 * metrics from the scoring input, and sync status by recommendation type.
 * The `syncByType` field is omitted (set to `undefined`) when there are no
 * pages to create and no outdated content, so the rendered report section
 * can skip the sync-status block entirely.
 *
 * @param input - The full pipeline input providing project root, cache results, and page sources.
 * @param scoringInput - Pre-computed scoring metrics (export counts, module counts).
 * @param recommendations - Generated recommendations used to derive sync-status counts.
 * @returns A {@link DocReportStats} object ready for {@link renderDocReferenceSection}.
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

  // Internal docs module coverage: check .anatoly/docs/ pages against module names
  const anatolyDocsDir = resolve(input.projectRoot, '.anatoly', 'docs');
  const internalDocPages = scanUserDocs(anatolyDocsDir);
  let internalModulesDocumented = 0;
  if (scoringInput.totalModules > 0) {
    // Re-derive moduleDirs from tasks to check against internal pages
    const moduleDirs = new Map<string, number>();
    for (const task of input.tasks) {
      const dirName = extractModuleName(task.file);
      if (!dirName) continue;
      const maxLine = Math.max(0, ...task.symbols.map(s => s.line_end));
      moduleDirs.set(dirName, (moduleDirs.get(dirName) ?? 0) + maxLine);
    }
    for (const [dirName, loc] of moduleDirs) {
      if (loc < 200) continue;
      const hasPage = internalDocPages.some(p =>
        p.path.toLowerCase().includes(dirName.toLowerCase()),
      );
      if (hasPage) internalModulesDocumented++;
    }
  }

  // Detect if docs/ is a mirror of .anatoly/docs/ (deduplicated)
  const userDocPaths = new Set(
    scanUserDocs(resolve(input.projectRoot, input.docsPath ?? 'docs')).map(p => p.path.toLowerCase()),
  );
  const internalPaths = internalDocPages.map(p => p.path.toLowerCase());
  const docsSynced = internalPaths.length > 0
    && userDocPaths.size > 0
    && internalPaths.filter(p => userDocPaths.has(p)).length >= internalPaths.length * 0.8;

  // Symbol-based coverage (Story 29.20)
  const symbolCoverage = {
    projectDocumented: scoringInput.projectExportsDocumented,
    internalDocumented: scoringInput.internalExportsDocumented,
    totalExports: scoringInput.totalExports,
    modulesDocumented: scoringInput.modulesDocumented,
    totalModules: scoringInput.totalModules,
    internalModulesDocumented,
  };

  // Sync status by recommendation type (Story 29.20)
  const toCreate = recommendations.filter(r => r.type === 'missing_page').length;
  const outdated = recommendations.filter(r => r.type === 'outdated_content').length;
  const syncByType = (toCreate > 0 || outdated > 0) ? { toCreate, outdated } : undefined;

  // Use actual .anatoly/docs/ page count if idealPageCount is missing (e.g. cached run)
  let totalPages = input.idealPageCount;
  if (totalPages === 0 && existsSync(anatolyDocsDir)) {
    totalPages = countMdFiles(anatolyDocsDir);
  }

  return {
    totalPages,
    newPages,
    refreshedPages,
    cachedPages,
    userDocsPageCount,
    symbolCoverage,
    syncByType,
    docsSynced,
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
