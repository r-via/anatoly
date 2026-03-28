// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Scoring Integration — Story 29.10
 *
 * Produces a project-level documentation score across 5 weighted dimensions:
 *   1. Structural presence (25%) — Required sections exist in docs/
 *   2. API coverage (25%) — % of public exports with JSDoc
 *   3. Module coverage (20%) — % of modules > 200 LOC with doc page
 *   4. Content quality (15%) — Pages follow writing rules
 *   5. Navigation (15%) — index.md, page coverage ratio
 *
 * Weights are adjusted by project type (e.g., Backend API + ORM gets
 * +10% structural weight for REST Endpoints + Auth, +10% for Data Model).
 *
 * Scoring runs against user's docs/, NOT against .anatoly/docs/.
 */

import type { ProjectType } from './language-detect.js';

export type DocVerdict = 'DOCUMENTED' | 'PARTIAL' | 'UNDOCUMENTED';

/**
 * Input metrics for computing a project-level documentation score.
 *
 * Aggregates page inventory, export coverage, module coverage, and content
 * quality into a single structure consumed by {@link scoreDocumentation}.
 *
 * Two export-count fields capture different perspectives:
 * - `projectExportsDocumented` — exports documented in the user-facing `docs/` directory
 *   (used for the API-coverage dimension that measures what end-users can discover).
 * - `internalExportsDocumented` — exports documented in `.anatoly/docs/` (the generated
 *   reference set); this field is carried for comparison/sync-gap purposes but does not
 *   directly feed into the score.
 */
export interface DocScoringInput {
  /** Pages found in user's docs/ directory (relative paths) */
  userDocPages: string[];
  /** Total pages in .anatoly/docs/ (ideal reference count) */
  idealPageCount: number;
  /** Detected project types */
  projectTypes: ProjectType[];
  /** Number of exports documented in project docs (docs/) */
  projectExportsDocumented: number;
  /** Number of exports documented in internal ref (.anatoly/docs/) */
  internalExportsDocumented: number;
  /** Total number of public exports */
  totalExports: number;
  /** Number of modules > 200 LOC with a doc page */
  modulesDocumented: number;
  /** Total modules > 200 LOC */
  totalModules: number;
  /** Content quality score (0-100), pre-computed from LLM analysis */
  contentQualityPercent: number;
}

/**
 * Result of {@link scoreDocumentation}, containing per-dimension scores,
 * an overall weighted score, a human-readable verdict, and a sync gap.
 *
 * All numeric score fields are integers in the range 0–100 representing
 * a percentage. The {@link overall} score is a weighted average of the
 * five dimensions; the weights are adjusted by detected project types.
 */
export interface DocScore {
  /** Structural presence score (0–100): percentage of required doc sections present. */
  structural: number;
  /** API coverage score (0–100): percentage of public exports with JSDoc in user docs. */
  apiCoverage: number;
  /** Module coverage score (0–100): percentage of large modules (>200 LOC) with a doc page. */
  moduleCoverage: number;
  /** Content quality score (0–100): pre-computed from LLM analysis of writing quality. */
  contentQuality: number;
  /** Navigation score (0–100): index presence (50 pts) + page coverage ratio (50 pts). */
  navigation: number;
  /** Weighted average of all five dimension scores (0–100). */
  overall: number;
  /** Human-readable verdict derived from {@link overall}: ≥80 DOCUMENTED, ≥50 PARTIAL, else UNDOCUMENTED. */
  verdict: DocVerdict;
  /** Ideal pages minus user pages (≥0). Indicates how many doc pages are missing. */
  syncGap: number;
}

/**
 * Compute a multi-dimensional documentation score for the project.
 *
 * Evaluates five weighted dimensions — structural presence (25%), API coverage
 * (25%), module coverage (20%), content quality (15%), and navigation (15%) —
 * then produces a weighted overall score and a verdict.
 *
 * Dimension weights are adjusted by detected project types (e.g., Backend API
 * and ORM increase structural weight; Library increases API-coverage weight).
 * Verdict thresholds: overall ≥80 → DOCUMENTED, ≥50 → PARTIAL, else UNDOCUMENTED.
 *
 * @param input - Aggregated metrics describing the project's documentation state.
 * @returns A {@link DocScore} containing per-dimension scores, an overall score,
 *   a {@link DocVerdict}, and the gap between ideal and actual page counts.
 */
export function scoreDocumentation(input: DocScoringInput): DocScore {
  const structural = computeStructural(input.userDocPages, input.projectTypes);
  const apiCoverage = safePercent(input.projectExportsDocumented, input.totalExports);
  const moduleCoverage = safePercent(input.modulesDocumented, input.totalModules);
  const contentQuality = input.contentQualityPercent;
  const navigation = computeNavigation(input.userDocPages, input.idealPageCount);

  const w = computeWeights(input.projectTypes);

  const overall = Math.round(
    (structural * w.structural +
      apiCoverage * w.apiCoverage +
      moduleCoverage * w.moduleCoverage +
      contentQuality * w.contentQuality +
      navigation * w.navigation) /
      100,
  );

  const verdict: DocVerdict =
    overall >= 80 ? 'DOCUMENTED' : overall >= 50 ? 'PARTIAL' : 'UNDOCUMENTED';

  const syncGap = Math.max(0, input.idealPageCount - input.userDocPages.length);

  return {
    structural,
    apiCoverage,
    moduleCoverage,
    contentQuality,
    navigation,
    overall,
    verdict,
    syncGap,
  };
}

// --- Structural score ---

const BASE_REQUIRED: RegExp[] = [
  /(?:^|\/)index\.md$/i,
  /(?:^|\/)(?:\d+-)?getting-started/i,
  /(?:^|\/)(?:\d+-)?architecture/i,
  /(?:^|\/)(?:\d+-)?api-reference/i,
  /(?:^|\/)(?:\d+-)?development/i,
];

const TYPE_SECTIONS: Partial<Record<ProjectType, RegExp[]>> = {
  'Backend API': [
    /rest-endpoints|routes|controllers|endpoints/i,
    /authentication|auth/i,
  ],
  'ORM': [
    /data-model|models|entities/i,
    /migration/i,
  ],
  'Frontend': [
    /component-api|components/i,
    /state-management|stores/i,
  ],
  'CLI': [/cli-reference|cli/i],
  'Monorepo': [/package-overview|packages/i],
};

/**
 * Compute the structural presence score by merging {@link BASE_REQUIRED}
 * patterns with type-specific patterns from {@link TYPE_SECTIONS}, then
 * counting how many required page patterns are matched by user doc pages.
 *
 * @param userDocPages - Relative paths of pages found in the user's docs/ directory.
 * @param projectTypes - Detected project types used to add extra required section patterns.
 * @returns Percentage (0-100) of required documentation sections present.
 */
function computeStructural(
  userDocPages: string[],
  projectTypes: ProjectType[],
): number {
  const required = [...BASE_REQUIRED];
  for (const t of projectTypes) {
    const extra = TYPE_SECTIONS[t];
    if (extra) required.push(...extra);
  }

  if (required.length === 0) return 100;

  const present = required.filter(pattern =>
    userDocPages.some(page => pattern.test(page)),
  );

  return Math.round((present.length / required.length) * 100);
}

// --- Navigation score ---

function computeNavigation(
  userDocPages: string[],
  idealPageCount: number,
): number {
  if (idealPageCount === 0) return 100;

  const hasIndex = userDocPages.some(p => /(?:^|\/)index\.md$/i.test(p));
  const indexScore = hasIndex ? 50 : 0;
  const coverageScore =
    Math.min(1, userDocPages.length / idealPageCount) * 50;

  return Math.round(indexScore + coverageScore);
}

// --- Weight computation ---

interface Weights {
  structural: number;
  apiCoverage: number;
  moduleCoverage: number;
  contentQuality: number;
  navigation: number;
}

/**
 * Compute per-dimension weight percentages adjusted by detected project types.
 *
 * Certain project types award bonus weight to the structural or API-coverage
 * dimensions (e.g. Backend API / ORM / Frontend / Monorepo boost structural;
 * Library boosts API coverage). The bonus is funded by proportionally reducing
 * the smaller dimensions (moduleCoverage, contentQuality, navigation) so that
 * total weights always sum to 100. A {@link Math.max} guard prevents the
 * navigation weight from going negative when bonuses are large.
 *
 * @param types - Detected project types that drive weight adjustments.
 * @returns A {@link Weights} object whose values sum to 100.
 */
function computeWeights(types: ProjectType[]): Weights {
  let structBonus = 0;
  let apiBonus = 0;

  if (types.includes('Backend API')) structBonus += 10;
  if (types.includes('ORM')) structBonus += 10;
  if (types.includes('Frontend')) structBonus += 10;
  if (types.includes('Monorepo')) structBonus += 10;
  if (types.includes('Library')) apiBonus += 15;

  const totalBonus = structBonus + apiBonus;
  if (totalBonus === 0) {
    return {
      structural: 25,
      apiCoverage: 25,
      moduleCoverage: 20,
      contentQuality: 15,
      navigation: 15,
    };
  }

  // Reduce smaller dimensions proportionally to fund bonuses
  const pool = 20 + 15 + 15; // moduleCoverage + contentQuality + navigation

  // Scale down bonuses proportionally when they exceed available pool
  if (totalBonus > pool) {
    const ratio = pool / totalBonus;
    structBonus = Math.round(structBonus * ratio);
    apiBonus = pool - structBonus;
  }

  const effectiveBonus = structBonus + apiBonus;
  const factor = (pool - effectiveBonus) / pool;

  const m = Math.round(20 * factor);
  const c = Math.round(15 * factor);
  const n = Math.max(0, 100 - (25 + structBonus) - (25 + apiBonus) - m - c);

  return {
    structural: 25 + structBonus,
    apiCoverage: 25 + apiBonus,
    moduleCoverage: m,
    contentQuality: c,
    navigation: n,
  };
}

// --- Helpers ---

function safePercent(documented: number, total: number): number {
  if (total === 0) return 100;
  return Math.min(100, Math.round((documented / total) * 100));
}
