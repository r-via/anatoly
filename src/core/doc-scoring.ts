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

import type { ProjectType } from './project-type-detector.js';

export type DocVerdict = 'DOCUMENTED' | 'PARTIAL' | 'UNDOCUMENTED';

export interface DocScoringInput {
  /** Pages found in user's docs/ directory (relative paths) */
  userDocPages: string[];
  /** Total pages in .anatoly/docs/ (ideal reference count) */
  idealPageCount: number;
  /** Detected project types */
  projectTypes: ProjectType[];
  /** Number of exports documented in project docs (docs/) */
  projectExportsDocumented: number;
  /** Total number of public exports */
  totalExports: number;
  /** Number of modules > 200 LOC with a doc page */
  modulesDocumented: number;
  /** Total modules > 200 LOC */
  totalModules: number;
  /** Content quality score (0-100), pre-computed from LLM analysis */
  contentQualityPercent: number;
}

export interface DocScore {
  structural: number;
  apiCoverage: number;
  moduleCoverage: number;
  contentQuality: number;
  navigation: number;
  overall: number;
  verdict: DocVerdict;
  /** Ideal pages minus user pages */
  syncGap: number;
}

// --- Main entry point ---

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
  const capped = Math.min(totalBonus, pool);
  const factor = (pool - capped) / pool;

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
