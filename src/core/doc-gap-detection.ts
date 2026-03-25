// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc Gap Detection v2 — Two-Strategy Architecture
 *
 * Strategy 1: Module pages — domain vector matching (macro + micro)
 * Strategy 2: Conceptual pages — key concept coverage
 *
 * No LLM calls. No Docker. Pure vector math + string matching.
 */

import type { VectorStore } from '../rag/vector-store.js';
import type { FunctionCard, DocSectionEntry } from '../rag/types.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export type GapDetectionScope = 'internal' | 'project';
export type PageType = 'module' | 'reference' | 'conceptual';

// --- Strategy 1: Domain reports ---

export interface DomainReport {
  domain: string;
  functionCount: number;
  matchedPage: string | null;
  similarity: number;
  classification: 'COVERED' | 'LOW_RELEVANCE' | 'NOT_FOUND';
  functionsCovered: number;
  functionsLowRelevance: number;
  functionsMissing: Array<{ name: string; file: string; docSummary: string }>;
}

// --- Strategy 3: Concept reports ---

export interface ConceptReport {
  concept: string;
  frequency: number;
  mentioned: boolean;
  suggestedPage: string;
}

// --- Combined result ---

/** Combined result of the three-strategy V2 gap detection, with per-strategy coverage stats and actionable items. */
export interface GapReportV2 {
  scope: GapDetectionScope;
  target: string;

  // Strategy 1
  domains: DomainReport[];
  moduleCoverage: { covered: number; total: number };

  // Strategy 3
  concepts: ConceptReport[];
  conceptCoverage: { mentioned: number; total: number };

  // Actionable
  pagesToCreate: string[];
  pagesToUpdate: string[];
  conceptsToDocument: Array<{ concept: string; frequency: number; suggestedPage: string }>;
}

/** Options bag for V2 gap detection. Threshold pairs control gap (missing) vs drift (low-relevance) classification. */
export interface GapDetectionV2Options {
  scope?: GapDetectionScope;
  projectDocsPath?: string;
  // Strategy 1 thresholds
  domainGapThreshold?: number;      // default 0.55
  domainDriftThreshold?: number;    // default 0.75
  functionGapThreshold?: number;    // default 0.50
  functionDriftThreshold?: number;  // default 0.75
  // Strategy 3
  conceptTopN?: number;             // default 30
  conceptMinFrequency?: number;     // default 5
  onProgress?: (phase: string, current: number, total: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════
// Page classification
// ═══════════════════════════════════════════════════════════════════════

/** Classify a doc page by path: 'module' if path contains "module", 'reference' for api-reference/cli/types/schema/endpoint, otherwise 'conceptual'. */
export function classifyPage(pagePath: string): PageType {
  const lower = pagePath.toLowerCase();
  if (lower.includes('module')) return 'module';
  if (lower.includes('api-reference') || lower.includes('cli')
    || lower.includes('types') || lower.includes('schema')
    || lower.includes('endpoint')) return 'reference';
  return 'conceptual';
}

// ═══════════════════════════════════════════════════════════════════════
// Domain extraction
// ═══════════════════════════════════════════════════════════════════════

interface Domain {
  name: string;
  functions: Array<{ card: FunctionCard; docVector: number[] }>;
  avgDocVector: number[];
}

/** Max functions per domain before splitting into sub-domains by file. */
const DOMAIN_SPLIT_THRESHOLD = 50;

function extractDomain(filePath: string): string {
  const parts = filePath.split('/');
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 0 && srcIdx + 1 < parts.length - 1) {
    return parts[srcIdx + 1];
  }
  return parts[0] || 'root';
}

function extractSubDomain(filePath: string): string {
  // Use directory + filename (without extension) as sub-domain
  // e.g. src/core/scanner.ts → core/scanner
  const parts = filePath.split('/');
  const srcIdx = parts.indexOf('src');
  if (srcIdx >= 0 && srcIdx + 1 < parts.length - 1) {
    const module = parts[srcIdx + 1];
    const file = parts[parts.length - 1].replace(/\.[^.]+$/, ''); // strip extension
    return `${module}/${file}`;
  }
  return filePath.replace(/\.[^.]+$/, '');
}

/** Group function cards into domains, splitting large domains into sub-domains by file. Skips single-function domains. */
function groupByDomain(cards: Array<{ card: FunctionCard; docVector: number[] }>): Domain[] {
  // First pass: group by top-level domain
  const coarseMap = new Map<string, Array<{ card: FunctionCard; docVector: number[] }>>();
  for (const entry of cards) {
    const domain = extractDomain(entry.card.filePath);
    const list = coarseMap.get(domain) ?? [];
    list.push(entry);
    coarseMap.set(domain, list);
  }

  // Second pass: split large domains into sub-domains by file
  const finalMap = new Map<string, Array<{ card: FunctionCard; docVector: number[] }>>();
  for (const [domain, fns] of coarseMap) {
    if (fns.length > DOMAIN_SPLIT_THRESHOLD) {
      // Split by file
      for (const entry of fns) {
        const sub = extractSubDomain(entry.card.filePath);
        const list = finalMap.get(sub) ?? [];
        list.push(entry);
        finalMap.set(sub, list);
      }
    } else {
      finalMap.set(domain, fns);
    }
  }

  return Array.from(finalMap.entries())
    .filter(([, fns]) => fns.length >= 2) // skip single-function domains
    .map(([name, fns]) => ({
      name,
      functions: fns,
      avgDocVector: l2Normalize(averageVectors(fns.map(f => f.docVector))),
    }));
}

// ═══════════════════════════════════════════════════════════════════════
// Page aggregation
// ═══════════════════════════════════════════════════════════════════════

interface DocPage {
  path: string;
  type: PageType;
  sections: DocSectionEntry[];
  avgNlpVector: number[];
  content?: string; // full text for reference/concept checks
}

/** Aggregate doc sections from the vector store into per-page groups with type classification. avgNlpVector is deferred (set to []). */
async function groupByPage(
  vectorStore: VectorStore,
  scope: GapDetectionScope,
): Promise<DocPage[]> {
  const sections = await vectorStore.listDocSections(scope);

  // Group sections by file path
  const map = new Map<string, DocSectionEntry[]>();
  for (const s of sections) {
    const list = map.get(s.filePath) ?? [];
    list.push(s);
    map.set(s.filePath, list);
  }

  // For each page, get the nlp_vectors to compute average
  const pages: DocPage[] = [];
  for (const [path, secs] of map) {
    // Get vectors for averaging — we need raw vectors from the store
    // Use section summaries as proxy (they're embedded in nlp_vector)
    // For now, use a simple approach: search for each section's own content
    pages.push({
      path,
      type: classifyPage(path),
      sections: secs,
      avgNlpVector: [], // computed below
      content: secs.map(s => `${s.name}\n${s.summary}`).join('\n\n'),
    });
  }

  return pages;
}

// ═══════════════════════════════════════════════════════════════════════
// Strategy 1: Module pages — domain vector matching
// ═══════════════════════════════════════════════════════════════════════

/** Strategy 1: match code domains to module pages via macro (domain→page) + micro (function→page) vector similarity. */
async function strategy1_moduleDomains(
  domains: Domain[],
  modulePages: DocPage[],
  vectorStore: VectorStore,
  scope: GapDetectionScope,
  opts: GapDetectionV2Options,
): Promise<DomainReport[]> {
  const domainGap = opts.domainGapThreshold ?? 0.55;
  const domainDrift = opts.domainDriftThreshold ?? 0.75;
  const fnGap = opts.functionGapThreshold ?? 0.50;
  const fnDrift = opts.functionDriftThreshold ?? 0.75;

  const reports: DomainReport[] = [];

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    opts.onProgress?.('modules', i + 1, domains.length);

    // Find best matching module page
    let bestPage: DocPage | null = null;
    let bestSim = 0;

    if (domain.avgDocVector.length > 0 && !domain.avgDocVector.every(v => v === 0)) {
      // Search doc sections with the domain's average vector
      const results = await vectorStore.searchDocSections(domain.avgDocVector, 5, 0.0, scope);

      // Group results by page and pick the page with highest average match
      const pageScores = new Map<string, number[]>();
      for (const r of results) {
        const scores = pageScores.get(r.card.filePath) ?? [];
        scores.push(r.score);
        pageScores.set(r.card.filePath, scores);
      }

      for (const [pagePath, scores] of pageScores) {
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (avgScore > bestSim) {
          bestSim = avgScore;
          bestPage = modulePages.find(p => p.path === pagePath) ?? null;
        }
      }
    }

    const classification = bestSim > domainDrift ? 'COVERED'
      : bestSim > domainGap ? 'LOW_RELEVANCE'
        : 'NOT_FOUND';

    // Micro drill-down: only if we have a matched page
    let functionsCovered = 0;
    let functionsLowRelevance = 0;
    const functionsMissing: Array<{ name: string; file: string; docSummary: string }> = [];

    if (bestPage && classification !== 'NOT_FOUND') {
      for (const { card, docVector } of domain.functions) {
        if (!docVector || docVector.length === 0 || docVector.every(v => v === 0)) {
          functionsMissing.push({ name: card.name, file: card.filePath, docSummary: card.docSummary ?? '' });
          continue;
        }

        // Search only within the matched page's sections
        const fnResults = await vectorStore.searchDocSections(docVector, 3, 0.0, scope);
        const pageResults = fnResults.filter(r => r.card.filePath === bestPage!.path);

        if (pageResults.length === 0 || pageResults[0].score < fnGap) {
          functionsMissing.push({ name: card.name, file: card.filePath, docSummary: card.docSummary ?? '' });
        } else if (pageResults[0].score < fnDrift) {
          functionsLowRelevance++;
        } else {
          functionsCovered++;
        }
      }
    } else {
      // All functions missing — no page exists
      for (const { card } of domain.functions) {
        functionsMissing.push({ name: card.name, file: card.filePath, docSummary: card.docSummary ?? '' });
      }
    }

    reports.push({
      domain: domain.name,
      functionCount: domain.functions.length,
      matchedPage: bestPage?.path ?? null,
      similarity: bestSim,
      classification,
      functionsCovered,
      functionsLowRelevance,
      functionsMissing,
    });
  }

  return reports;
}

// ═══════════════════════════════════════════════════════════════════════
// Strategy 3: Conceptual pages — key concept coverage
// ═══════════════════════════════════════════════════════════════════════

/** Strategy 3: identify top key concepts by frequency and check if they appear in conceptual pages. */
function strategy3_conceptualPages(
  conceptualPages: DocPage[],
  allCards: FunctionCard[],
  opts: GapDetectionV2Options,
): ConceptReport[] {
  const topN = opts.conceptTopN ?? 30;
  const minFreq = opts.conceptMinFrequency ?? 5;

  // Aggregate concept frequency
  const freq = new Map<string, number>();
  for (const card of allCards) {
    for (const concept of card.keyConcepts ?? []) {
      const normalized = concept.toLowerCase().trim();
      if (normalized.length < 2) continue;
      freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
    }
  }

  // Top N concepts above min frequency
  const topConcepts = [...freq.entries()]
    .filter(([, count]) => count >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  // Combine all conceptual page content
  const allConceptualContent = conceptualPages
    .map(p => p.content ?? '')
    .join('\n')
    .toLowerCase();

  // Check each concept
  const reports: ConceptReport[] = [];
  for (const [concept, frequency] of topConcepts) {
    const searchTerms = [
      concept,
      concept.replace(/-/g, ' '),
      concept.replace(/-/g, ''),
    ];
    const mentioned = searchTerms.some(t => allConceptualContent.includes(t));

    // Suggest best page by matching concept against existing page paths/content
    let suggestedPage = conceptualPages[0]?.path ?? 'index.md';
    let bestMatchScore = 0;
    for (const page of conceptualPages) {
      const pageLower = (page.path + ' ' + (page.content ?? '')).toLowerCase();
      for (const term of searchTerms) {
        if (pageLower.includes(term) && term.length > bestMatchScore) {
          bestMatchScore = term.length;
          suggestedPage = page.path;
        }
      }
    }

    reports.push({ concept, frequency, mentioned, suggestedPage });
  }

  return reports;
}

// ═══════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════

/** Runs the V2 documentation gap detection pipeline, producing a {@link GapReportV2} with domain, reference, and concept coverage. */
export async function detectDocGapsV2(
  vectorStore: VectorStore,
  options?: GapDetectionV2Options,
): Promise<GapReportV2> {
  const scope = options?.scope ?? 'internal';
  const target = scope === 'internal' ? '.anatoly/docs/' : (options?.projectDocsPath ?? 'docs/');

  // Load data
  const cardsWithVectors = await vectorStore.listAllWithDocVectors();
  const allCards = cardsWithVectors.map(c => c.card);
  const pages = await groupByPage(vectorStore, scope);

  // Classify pages
  const modulePages = pages.filter(p => p.type === 'module');
  const conceptualPages = pages.filter(p => p.type === 'conceptual');

  // Group code by domain
  const domains = groupByDomain(cardsWithVectors);

  // Strategy 1: Module pages
  options?.onProgress?.('modules', 0, domains.length);
  const domainReports = await strategy1_moduleDomains(domains, modulePages, vectorStore, scope, options ?? {});

  // Strategy 3: Conceptual pages
  options?.onProgress?.('concepts', 0, 1);
  const conceptReports = strategy3_conceptualPages(conceptualPages, allCards, options ?? {});

  // Compute summaries
  const coveredDomains = domainReports.filter(d => d.classification === 'COVERED').length;
  const mentionedConcepts = conceptReports.filter(c => c.mentioned).length;

  // Actionable lists — derive modules directory from existing module pages
  const modulesDir = modulePages.length > 0
    ? modulePages[0].path.split('/').slice(0, -1).join('/')
    : 'Modules';
  const pagesToCreate = domainReports
    .filter(d => d.classification === 'NOT_FOUND')
    .map(d => `${modulesDir}/${d.domain}.md`);

  const pagesToUpdate = [...new Set([
    ...domainReports
      .filter(d => d.functionsMissing.length > 0 && d.matchedPage)
      .map(d => d.matchedPage!),
  ])];

  const conceptsToDocument = conceptReports
    .filter(c => !c.mentioned)
    .map(c => ({ concept: c.concept, frequency: c.frequency, suggestedPage: c.suggestedPage }));

  return {
    scope,
    target,
    domains: domainReports,
    moduleCoverage: { covered: coveredDomains, total: domainReports.length },
    concepts: conceptReports,
    conceptCoverage: { mentioned: mentionedConcepts, total: conceptReports.length },
    pagesToCreate,
    pagesToUpdate,
    conceptsToDocument,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Formatting for CLI display
// ═══════════════════════════════════════════════════════════════════════

/** Formats a {@link GapReportV2} into a human-readable CLI summary with coverage stats and action items. */
export function formatGapReportV2(report: GapReportV2): string {
  const lines: string[] = [
    `Documentation Health Report for ${report.target}`,
    '═'.repeat(50),
    '',
    `Module coverage:     ${report.moduleCoverage.covered}/${report.moduleCoverage.total} domains documented`,
    `Conceptual coverage: ${report.conceptCoverage.mentioned}/${report.conceptCoverage.total} key concepts mentioned`,
  ];

  // Domain details
  if (report.domains.length > 0) {
    lines.push('', 'Domains:');
    for (const d of report.domains) {
      const icon = d.classification === 'COVERED' ? '✓' : d.classification === 'LOW_RELEVANCE' ? '!' : '✗';
      const page = d.matchedPage ? ` → ${d.matchedPage}` : '';
      const coverage = d.matchedPage ? ` (${d.functionsCovered}/${d.functionCount} functions)` : '';
      lines.push(`  ${icon} ${d.domain} (${d.functionCount} fns)${page}${coverage}`);
    }
  }

  // Missing functions (top gaps)
  const allMissing = report.domains.flatMap(d => d.functionsMissing.map(f => ({ ...f, domain: d.domain, page: d.matchedPage })));
  if (allMissing.length > 0) {
    lines.push('', `Missing functions (${allMissing.length} total):`);
    for (const f of allMissing.slice(0, 10)) {
      lines.push(`  - ${f.name} (${f.file})`);
    }
    if (allMissing.length > 10) {
      lines.push(`  … and ${allMissing.length - 10} more`);
    }
  }

  // Concept gaps
  const missingConcepts = report.concepts.filter(c => !c.mentioned);
  if (missingConcepts.length > 0) {
    lines.push('', `Missing concepts (${missingConcepts.length}):`);
    for (const c of missingConcepts.slice(0, 10)) {
      lines.push(`  - "${c.concept}" (${c.frequency} functions) → ${c.suggestedPage}`);
    }
  }

  // Actionable summary
  lines.push('');
  if (report.pagesToCreate.length > 0) {
    lines.push(`Pages to create: ${report.pagesToCreate.join(', ')}`);
  }
  if (report.pagesToUpdate.length > 0) {
    lines.push(`Pages to update: ${report.pagesToUpdate.join(', ')}`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Vector math helpers
// ═══════════════════════════════════════════════════════════════════════

function averageVectors(vectors: number[][]): number[] {
  const validVectors = vectors.filter(v => v.length > 0 && !v.every(x => x === 0));
  if (validVectors.length === 0) return [];

  const dim = validVectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of validVectors) {
    for (let i = 0; i < dim; i++) avg[i] += v[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= validVectors.length;
  return avg;
}

function l2Normalize(v: number[]): number[] {
  if (v.length === 0) return v;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map(x => x / norm);
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy v1 exports (kept for backward compat during migration)
// ═══════════════════════════════════════════════════════════════════════

/** @deprecated Use detectDocGapsV2 instead */
export type GapClassification = 'NOT_FOUND' | 'FOUND_LOW_RELEVANCE' | 'FOUND_COVERED' | 'ORPHAN_DOC';
/** Legacy V1 gap detection result with flat per-function classifications. @deprecated Use {@link GapReportV2} instead. */
export interface GapDetectionResult {
  totalFunctions: number;
  totalDocSections: number;
  notFound: Array<{ functionCard: FunctionCard; classification: 'NOT_FOUND'; bestMatch: DocSectionEntry | null; similarity: number }>;
  lowRelevance: Array<{ functionCard: FunctionCard; classification: 'FOUND_LOW_RELEVANCE'; bestMatch: DocSectionEntry | null; similarity: number }>;
  covered: Array<{ functionCard: FunctionCard; classification: 'FOUND_COVERED'; bestMatch: DocSectionEntry | null; similarity: number }>;
  orphans: Array<{ docSection: DocSectionEntry; classification: 'ORPHAN_DOC'; bestMatchFunction: string | null; similarity: number }>;
  byPage: Map<string, { pagePath: string; notFound: unknown[]; lowRelevance: unknown[]; covered: unknown[]; orphans: unknown[] }>;
}
/** @deprecated Use {@link detectDocGapsV2} instead. Note: `gapThreshold`/`driftThreshold` options are ignored when delegating to V2. */
export async function detectDocGaps(vectorStore: VectorStore, options?: { scope?: GapDetectionScope; projectDocsPath?: string; gapThreshold?: number; driftThreshold?: number; onProgress?: (c: number, t: number) => void }): Promise<GapDetectionResult> {
  // Delegate to v2 and map back to v1 format
  const v2 = await detectDocGapsV2(vectorStore, { scope: options?.scope, projectDocsPath: options?.projectDocsPath });
  const notFound = v2.domains.flatMap(d => d.functionsMissing.map(f => ({ functionCard: { name: f.name, filePath: f.file } as FunctionCard, classification: 'NOT_FOUND' as const, bestMatch: null, similarity: 0 })));
  return { totalFunctions: v2.domains.reduce((s, d) => s + d.functionCount, 0), totalDocSections: 0, notFound, lowRelevance: [], covered: [], orphans: [], byPage: new Map() };
}
/** @deprecated Use formatGapReportV2 instead */
export function formatGapSummary(result: GapDetectionResult, _scope?: GapDetectionScope, _docsPath?: string): string {
  return `(v1 deprecated — use v2 report)`;
}
