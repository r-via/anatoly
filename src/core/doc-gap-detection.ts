// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc Gap Detection — cross-index analysis.
 *
 * Compares the code index (function cards with NLP summaries) against the
 * doc index (chunked sections of .anatoly/docs/) to find gaps, drift, and
 * orphans. Pure vector math — no LLM calls.
 *
 * Each function card is the unit of work. For each, we query the doc index
 * to find the most similar doc section and classify the match.
 */

import type { VectorStore } from '../rag/vector-store.js';
import type { FunctionCard, DocSectionEntry } from '../rag/types.js';

// --- Types ---

export type GapClassification =
  | 'NOT_FOUND'           // function has no doc section (sim < gapThreshold)
  | 'FOUND_LOW_RELEVANCE' // doc exists but diverges (sim between gap and drift thresholds)
  | 'FOUND_COVERED'       // doc accurately covers the function (sim > driftThreshold)
  | 'ORPHAN_DOC';         // doc section has no matching function card

export interface GapItem {
  functionCard: FunctionCard;
  classification: Exclude<GapClassification, 'ORPHAN_DOC'>;
  bestMatch: DocSectionEntry | null;
  similarity: number;
}

export interface OrphanItem {
  docSection: DocSectionEntry;
  classification: 'ORPHAN_DOC';
  bestMatchFunction: string | null; // function name if any weak match
  similarity: number;
}

export interface GapDetectionResult {
  /** All function cards analyzed. */
  totalFunctions: number;
  /** All doc sections analyzed. */
  totalDocSections: number;
  /** Functions with no documentation. */
  notFound: GapItem[];
  /** Functions with weak/stale documentation. */
  lowRelevance: GapItem[];
  /** Functions with good documentation. */
  covered: GapItem[];
  /** Doc sections with no matching function. */
  orphans: OrphanItem[];
  /** Work items grouped by target doc page. */
  byPage: Map<string, PageWorkList>;
}

export interface PageWorkList {
  pagePath: string;
  notFound: GapItem[];
  lowRelevance: GapItem[];
  covered: GapItem[];
  orphans: OrphanItem[];
}

export type GapDetectionScope = 'internal' | 'project';

export interface GapDetectionOptions {
  /** Which doc set to analyze. 'internal' = .anatoly/docs/, 'project' = docs/ (or custom path). */
  scope?: GapDetectionScope; // default 'internal'
  gapThreshold?: number;   // default 0.60
  driftThreshold?: number; // default 0.85
  onProgress?: (current: number, total: number) => void;
}

// --- Source→page mapping (reuse doc-mapping logic) ---

/**
 * Derive the target doc page from a function card's filePath.
 * Uses the same convention as doc-mapping: src/{module}/* → 05-Modules/{module}.md
 */
function deriveDocPage(filePath: string): string {
  const parts = filePath.split('/');
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 0 && srcIdx + 1 < parts.length - 1) {
    const module = parts[srcIdx + 1];
    return `05-Modules/${module}.md`;
  }
  // Commands map to CLI Reference
  if (filePath.includes('/commands/')) return '04-API-Reference/04-CLI-Reference.md';
  // Schemas map to types
  if (filePath.includes('/schemas/')) return '04-API-Reference/03-Types-and-Interfaces.md';
  // Default: core module
  return '05-Modules/core.md';
}

// --- Main entry point ---

/**
 * Analyze the gap between code index and doc index.
 * Returns a typed work list for the doc update agent.
 *
 * No LLM calls — pure cosine similarity queries against the vector store.
 */
export async function detectDocGaps(
  vectorStore: VectorStore,
  options?: GapDetectionOptions,
): Promise<GapDetectionResult> {
  const gapThreshold = options?.gapThreshold ?? 0.60;
  const driftThreshold = options?.driftThreshold ?? 0.85;
  const scope = options?.scope ?? 'internal';

  // Load all function cards with their NLP vectors
  const cardsWithVectors = await vectorStore.listAllWithNlpVectors();
  // Filter doc sections by source attribute (set during indexing)
  const allDocSections = await vectorStore.listDocSections(scope);

  if (allDocSections.length === 0) {
    // No doc sections for this scope — everything is NOT_FOUND
    return {
      totalFunctions: cardsWithVectors.length,
      totalDocSections: 0,
      notFound: cardsWithVectors.map(({ card }) => ({ functionCard: card, classification: 'NOT_FOUND' as const, bestMatch: null, similarity: 0 })),
      lowRelevance: [],
      covered: [],
      orphans: [],
      byPage: new Map(),
    };
  }

  const notFound: GapItem[] = [];
  const lowRelevance: GapItem[] = [];
  const covered: GapItem[] = [];

  // Track which doc sections are matched (for orphan detection)
  const matchedDocIds = new Set<string>();

  // For each function card, find the most similar doc section in scope
  for (let i = 0; i < cardsWithVectors.length; i++) {
    const { card, nlpVector } = cardsWithVectors[i];
    options?.onProgress?.(i + 1, cardsWithVectors.length);

    // Skip cards with no NLP vector (embedding not available)
    if (!nlpVector || nlpVector.length === 0 || nlpVector.every(v => v === 0)) {
      notFound.push({ functionCard: card, classification: 'NOT_FOUND', bestMatch: null, similarity: 0 });
      continue;
    }

    // Query doc index — filtered by source attribute
    const scopedResults = await vectorStore.searchDocSections(nlpVector, 3, 0.0, scope);

    if (scopedResults.length === 0) {
      notFound.push({ functionCard: card, classification: 'NOT_FOUND', bestMatch: null, similarity: 0 });
      continue;
    }

    const best = scopedResults[0];
    const docSection: DocSectionEntry = {
      id: best.card.id,
      filePath: best.card.filePath,
      name: best.card.name,
      summary: best.card.summary ?? '',
      lastIndexed: best.card.lastIndexed,
      source: scope,
    };

    if (best.score < gapThreshold) {
      notFound.push({ functionCard: card, classification: 'NOT_FOUND', bestMatch: docSection, similarity: best.score });
    } else if (best.score < driftThreshold) {
      lowRelevance.push({ functionCard: card, classification: 'FOUND_LOW_RELEVANCE', bestMatch: docSection, similarity: best.score });
      matchedDocIds.add(best.card.id);
    } else {
      covered.push({ functionCard: card, classification: 'FOUND_COVERED', bestMatch: docSection, similarity: best.score });
      matchedDocIds.add(best.card.id);
    }
  }

  // Orphan detection: doc sections in scope with no matching function card
  const orphans: OrphanItem[] = allDocSections
    .filter(ds => !matchedDocIds.has(ds.id))
    .map(ds => ({
      docSection: ds,
      classification: 'ORPHAN_DOC' as const,
      bestMatchFunction: null,
      similarity: 0,
    }));

  // Group by page
  const byPage = new Map<string, PageWorkList>();

  const getPage = (pagePath: string): PageWorkList => {
    let page = byPage.get(pagePath);
    if (!page) {
      page = { pagePath, notFound: [], lowRelevance: [], covered: [], orphans: [] };
      byPage.set(pagePath, page);
    }
    return page;
  };

  for (const item of notFound) {
    getPage(deriveDocPage(item.functionCard.filePath)).notFound.push(item);
  }
  for (const item of lowRelevance) {
    getPage(deriveDocPage(item.functionCard.filePath)).lowRelevance.push(item);
  }
  for (const item of covered) {
    getPage(deriveDocPage(item.functionCard.filePath)).covered.push(item);
  }
  for (const item of orphans) {
    getPage(item.docSection.filePath).orphans.push(item);
  }

  return {
    totalFunctions: cardsWithVectors.length,
    totalDocSections: allDocSections.length,
    notFound,
    lowRelevance,
    covered,
    orphans,
    byPage,
  };
}

// --- Formatting for CLI display ---

export function formatGapSummary(result: GapDetectionResult, scope: GapDetectionScope = 'internal', docsPath?: string): string {
  const target = scope === 'internal' ? '.anatoly/docs/' : (docsPath ?? 'docs/');
  const lines: string[] = [
    `Target: ${target} (${scope === 'internal' ? 'internal' : 'project'} documentation)`,
    '',
    `Functions analyzed: ${result.totalFunctions} (from code index)`,
    `Doc sections analyzed: ${result.totalDocSections} (from ${target} index)`,
    '',
    `  NOT_FOUND:           ${result.notFound.length} functions not in ${target}`,
    `  FOUND_LOW_RELEVANCE: ${result.lowRelevance.length} functions with stale/weak coverage`,
    `  FOUND_COVERED:       ${result.covered.length} functions well documented`,
    `  ORPHAN_DOC:          ${result.orphans.length} ${target} sections with no matching code`,
  ];

  if (result.notFound.length > 0) {
    lines.push('', `Top undocumented functions (not in ${target}):`);
    for (const item of result.notFound.slice(0, 15)) {
      lines.push(`  - ${item.functionCard.name} (${item.functionCard.filePath})`);
    }
    if (result.notFound.length > 15) {
      lines.push(`  … and ${result.notFound.length - 15} more`);
    }
  }

  if (result.lowRelevance.length > 0) {
    lines.push('', `Functions with stale coverage in ${target}:`);
    for (const item of result.lowRelevance.slice(0, 10)) {
      lines.push(`  - ${item.functionCard.name} → ${item.bestMatch?.name ?? '?'} (sim ${item.similarity.toFixed(2)})`);
    }
  }

  if (result.orphans.length > 0) {
    lines.push('', `Orphan sections in ${target} (no matching code):`);
    for (const item of result.orphans.slice(0, 10)) {
      lines.push(`  - ${item.docSection.name} (${item.docSection.filePath})`);
    }
  }

  return lines.join('\n');
}
