// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Dual-Output Documentation Recommendations — Story 29.13
 *
 * Transforms raw documentation gaps into enriched recommendations
 * that include both the ideal path (.anatoly/docs/) and the user's
 * path (docs/) so Ralph can apply fixes in the user's organizational style.
 *
 * When a UserDocPlan exists, concept-based section mappings determine
 * the user path. When no plan exists, ideal paths are mirrored under docs/.
 */

import type { UserDocPlan } from './user-doc-plan.js';

// --- Public types ---

export type RecommendationType =
  | 'missing_page'
  | 'missing_section'
  | 'outdated_content'
  | 'empty_page'
  | 'broken_link'
  | 'missing_index_entry'
  | 'missing_jsdoc'
  | 'incomplete_jsdoc';

export interface DocGap {
  type: RecommendationType;
  /** Page path within .anatoly/docs/ (e.g., "05-Modules/rag.md") */
  idealPath: string;
  rationale: string;
  priority: 'high' | 'medium' | 'low';
  /** For missing_section: the missing section heading */
  section?: string;
  /** For types referencing an existing user page (missing_section, outdated_content) */
  existingUserPath?: string;
}

export interface DocRecommendation {
  type: RecommendationType;
  path_ideal: string;
  path_user: string;
  content_ref: string;
  rationale: string;
  priority: 'high' | 'medium' | 'low';
  section?: string;
}

// --- Concept extraction from ideal paths ---

/** Maps ideal directory prefixes to concept names */
const DIR_TO_CONCEPT: Record<string, string> = {
  '00-Monorepo': 'monorepo',
  '01-Getting-Started': 'getting-started',
  '02-Architecture': 'architecture',
  '03-Guides': 'guides',
  '04-API-Reference': 'api-reference',
  '05-Modules': 'modules',
  '06-Development': 'development',
};

/**
 * Extracts the concept from an ideal page path.
 * e.g., "05-Modules/rag.md" → "modules"
 */
function extractConcept(idealPath: string): string | null {
  const dir = idealPath.split('/')[0];
  return DIR_TO_CONCEPT[dir] ?? null;
}

/**
 * Strips ordering prefixes from filenames.
 * e.g., "01-Common-Workflows.md" → "Common-Workflows.md"
 */
function stripFilePrefix(filename: string): string {
  return filename.replace(/^\d+[-_.]/, '');
}

// --- Main entry point ---

/**
 * Transforms documentation gaps into dual-output recommendations.
 *
 * Each recommendation includes both path_ideal (.anatoly/docs/) and
 * path_user (docs/) so Ralph can apply fixes in the user's structure.
 *
 * Path resolution:
 * 1. If gap has existingUserPath → use it directly
 * 2. If userDocPlan has a mapping for the concept → use mapped directory + filename
 * 3. Otherwise → mirror ideal path under docs/
 */
export function buildDocRecommendations(
  gaps: DocGap[],
  userDocPlan: UserDocPlan | null,
  opts?: { docsPath?: string },
): DocRecommendation[] {
  const docsPath = opts?.docsPath ?? 'docs';
  return gaps.map((gap) => {
    const pathIdeal = `.anatoly/docs/${gap.idealPath}`;
    const pathUser = resolveUserPath(gap, userDocPlan, docsPath);

    const rec: DocRecommendation = {
      type: gap.type,
      path_ideal: pathIdeal,
      path_user: pathUser,
      content_ref: pathIdeal,
      rationale: gap.rationale,
      priority: gap.priority,
    };

    if (gap.section !== undefined) {
      rec.section = gap.section;
    }

    return rec;
  });
}

// --- Path resolution ---

function resolveUserPath(gap: DocGap, plan: UserDocPlan | null, docsPath: string): string {
  // Explicit existing path takes precedence
  if (gap.existingUserPath) {
    return gap.existingUserPath;
  }

  const parts = gap.idealPath.split('/');
  const filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const cleanFilename = stripFilePrefix(filename);

  // Try concept-based mapping from user plan
  if (plan) {
    const concept = extractConcept(gap.idealPath);
    if (concept && concept in plan.sectionMappings) {
      const userDir = plan.sectionMappings[concept];
      return `${userDir}${cleanFilename}`;
    }
  }

  // Fallback: mirror ideal path under docsPath, stripping file prefix only
  if (parts.length > 1) {
    return `${docsPath}/${parts[0]}/${cleanFilename}`;
  }
  return `${docsPath}/${cleanFilename}`;
}
