// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * User Documentation Plan Resolver — Story 29.12
 *
 * Analyzes the user's existing docs/ directory to understand their
 * organizational logic. Maps each page to a concept category
 * (architecture, guides, api-reference, etc.) so that recommendations
 * respect the user's conventions instead of forcing Anatoly's structure.
 *
 * Supports:
 * - Hierarchical structures (subdirectories)
 * - Flat structures (all .md at root)
 * - Numbered/lettered prefix normalization (01-, a-, etc.)
 * - H1-based classification when names are ambiguous
 */

// --- Public interfaces ---

export interface DocPageEntry {
  /** Relative path within docs/ (e.g., "architecture/rag-engine.md") */
  path: string;
  /** First few lines of content (H1 + summary) for classification */
  headContent: string;
}

export interface UserDocPage {
  /** Full path from project root (e.g., "docs/architecture/rag-engine.md") */
  path: string;
  /** Inferred concept category */
  concept: string;
  /** H1 title, or null if none found */
  title: string | null;
}

export interface UserDocPlan {
  /** Concept → user directory path (e.g., "architecture" → "docs/architecture/") */
  sectionMappings: Record<string, string>;
  /** All classified pages */
  pages: UserDocPage[];
}

// --- Main entry point ---

/**
 * Resolves the user's documentation plan from their existing docs/ pages.
 * Returns null if no pages exist (no docs/ directory).
 *
 * @param pages - Array of doc page entries discovered in the user's docs directory,
 *                each containing a relative path and head content for classification.
 * @param docsDir - Base directory name for user documentation (defaults to `"docs"`).
 * @returns Classified plan with section mappings and page entries, or null if
 *          no pages are provided.
 */
export function resolveUserDocPlan(
  pages: DocPageEntry[],
  docsDir = 'docs',
): UserDocPlan | null {
  if (pages.length === 0) return null;

  const sectionMappings: Record<string, string> = {};
  const classifiedPages: UserDocPage[] = [];

  for (const entry of pages) {
    const parts = entry.path.split('/');
    const hasSubdir = parts.length > 1;
    const title = extractTitle(entry.headContent);

    let concept: string;

    if (hasSubdir) {
      // Classify by directory name
      const dirName = parts[0];
      concept = matchConcept(dirName) ?? inferConceptFromContent(entry.headContent);

      // Register section mapping (directory → concept)
      if (concept !== 'other' && !(concept in sectionMappings)) {
        sectionMappings[concept] = `${docsDir}/${dirName}/`;
      }
    } else {
      // Flat structure: classify by file name, then fall back to H1
      const fileName = parts[0].replace(/\.md$/i, '');
      concept = matchConcept(fileName) ?? inferConceptFromContent(entry.headContent);
    }

    classifiedPages.push({
      path: `${docsDir}/${entry.path}`,
      concept,
      title,
    });
  }

  return { sectionMappings, pages: classifiedPages };
}

// --- Concept matching ---

/** Ordered concept patterns — first match wins */
const CONCEPT_PATTERNS: [string, RegExp][] = [
  ['getting-started', /^(?:getting.?started|install|setup|quick.?start|start)/i],
  ['architecture', /^(?:architecture|design|system.?design)/i],
  ['core-concepts', /^(?:core.?concepts|concepts|glossary|terminology)/i],
  ['api-reference', /^(?:api|reference|endpoints?|routes?|commands?)/i],
  ['modules', /^(?:modules?|components?|packages?|libs?)/i],
  ['development', /^(?:development|contributing|build|deploy|dev)/i],
  ['guides', /^(?:guides?|tutorials?|how.?to|walkthrough|cookbook)/i],
];

/**
 * Strips ordering prefixes like "01-", "a-", "2_", "1." from names.
 * Only strips short prefixes (digits or single letter + separator).
 */
function normalizePrefix(name: string): string {
  return name.replace(/^(?:\d+|[a-z])[-_.]/i, '');
}

/**
 * Matches a directory or file name to a concept.
 * Strips ordering prefixes before matching.
 */
function matchConcept(name: string): string | null {
  const normalized = normalizePrefix(name);

  for (const [concept, pattern] of CONCEPT_PATTERNS) {
    if (pattern.test(normalized)) return concept;
  }
  return null;
}

// --- Content-based classification ---

/** Content patterns — no start anchor, match keywords anywhere in H1 */
const CONTENT_PATTERNS: [string, RegExp][] = [
  ['getting-started', /(?:getting.?started|install|setup|quick.?start)/i],
  ['architecture', /(?:architecture|system.?design)/i],
  ['core-concepts', /(?:core.?concepts|concepts|glossary|terminology)/i],
  ['api-reference', /(?:api|reference|endpoints?|routes?|commands?)/i],
  ['modules', /(?:modules?|components?|packages?|libs?)/i],
  ['development', /(?:development|contributing|build|deploy)/i],
  ['guides', /(?:guides?|tutorials?|how.?to|walkthrough|cookbook)/i],
];

function extractTitle(headContent: string): string | null {
  const match = headContent.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Infers concept from H1 content when name-based matching fails.
 * Uses CONTENT_PATTERNS (no start anchor) so titles like
 * "System Architecture" match the architecture concept.
 */
function inferConceptFromContent(headContent: string): string {
  const title = extractTitle(headContent);
  if (!title) return 'other';

  for (const [concept, pattern] of CONTENT_PATTERNS) {
    if (pattern.test(title)) return concept;
  }
  return 'other';
}
