// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Task, SymbolInfo } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { embedCode, embedNlp, embedCodeBatch, embedNlpBatch, buildEmbedCode, buildEmbedNlp, getNlpDim } from './embeddings.js';
import { atomicWriteJson } from '../utils/cache.js';
import type { NlpSummary } from './nlp-summarizer.js';

export interface RagCache {
  /** Map of functionId → file hash at time of indexing */
  entries: Record<string, string>;
}

// ---------------------------------------------------------------------------
// NLP Summary Cache — per-function caching keyed by body content hash
// ---------------------------------------------------------------------------

export interface NlpSummaryCacheEntry {
  /** SHA-256 of the function body at time of summarization. */
  bodyHash: string;
  /** Cached NLP summary for this function. */
  summary: NlpSummary;
}

export interface NlpSummaryCache {
  /** Map of functionId → cached summary entry. */
  entries: Record<string, NlpSummaryCacheEntry>;
}

/**
 * Build a deterministic ID for a function based on file path and line range.
 */
export function buildFunctionId(filePath: string, lineStart: number, lineEnd: number): string {
  const input = `${filePath}:${lineStart}-${lineEnd}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Extract the signature of a function/method from source code using line range.
 */
export function extractSignature(source: string, symbol: SymbolInfo): string {
  const lines = source.split('\n');
  const startLine = symbol.line_start - 1;

  // Take the first line(s) up to the opening brace or arrow
  let sig = '';
  for (let i = startLine; i < Math.min(startLine + 3, lines.length); i++) {
    sig += lines[i].trim() + ' ';
    if (lines[i].includes('{') || lines[i].includes('=>')) break;
  }

  return sig.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Extract the source body of a function from the full file source.
 */
export function extractFunctionBody(source: string, symbol: SymbolInfo): string {
  const lines = source.split('\n');
  return lines.slice(symbol.line_start - 1, symbol.line_end).join('\n');
}

/**
 * Compute cyclomatic complexity from source lines of a function.
 * Counts branching constructs: if, else if, case, &&, ||, ternary, catch.
 */
export function computeComplexity(source: string, symbol: SymbolInfo): number {
  const body = extractFunctionBody(source, symbol);

  let complexity = 1; // base path
  const patterns = [
    /(?<!else\s)\bif\s*\(/g,  // standalone if (excludes else if)
    /\belse\s+if\s*\(/g,
    /\bcase\s+/g,
    /&&/g,
    /\|\|/g,
    /\?(?![?.:])/g,   // ternary (avoid ?., ?.[], ?.(), ??, ?:)
    /\bcatch\s*\(/g,
  ];

  for (const pattern of patterns) {
    const matches = body.match(pattern);
    if (matches) complexity += matches.length;
  }

  // Map to 1-5 scale
  if (complexity <= 2) return 1;
  if (complexity <= 5) return 2;
  if (complexity <= 10) return 3;
  if (complexity <= 20) return 4;
  return 5;
}

/**
 * Extract internal function calls from the body of a function.
 * Looks for identifiers that match other symbols in the same file.
 */
export function extractCalledInternals(
  source: string,
  symbol: SymbolInfo,
  allSymbols: SymbolInfo[],
): string[] {
  const body = extractFunctionBody(source, symbol);

  const otherNames = allSymbols
    .filter((s) => s.name !== symbol.name)
    .map((s) => s.name);

  const called: string[] = [];
  for (const name of otherNames) {
    // Match function calls: name( or name<
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*[(<]`, 'g');
    if (pattern.test(body)) {
      called.push(name);
    }
  }

  return [...new Set(called)];
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build FunctionCards from AST-derived data only (no LLM dependency).
 */
export function buildFunctionCards(
  task: Task,
  source: string,
): FunctionCard[] {
  const now = new Date().toISOString();
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  const cards: FunctionCard[] = [];

  for (const symbol of functionSymbols) {
    const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    const signature = extractSignature(source, symbol);
    const complexityScore = computeComplexity(source, symbol);
    const calledInternals = extractCalledInternals(source, symbol, task.symbols);

    cards.push({
      id,
      filePath: task.file,
      name: symbol.name,
      signature,
      complexityScore,
      calledInternals,
      lastIndexed: now,
    });
  }

  return cards;
}

/**
 * Pure function: check if a card needs re-indexing by comparing its cached hash
 * against the current file hash.
 */
export function needsReindex(cache: RagCache, card: FunctionCard, fileHash: string): boolean {
  return cache.entries[card.id] !== fileHash;
}

/**
 * Generate embeddings for a list of cards using code-direct embedding.
 * Requires the source text and symbol info to extract function bodies.
 */
export async function embedCards(cards: FunctionCard[], source: string, symbols: SymbolInfo[]): Promise<number[][]> {
  // Build all code texts first, then batch-embed in a single request
  const texts: string[] = [];
  for (const card of cards) {
    const symbol = symbols.find(
      (s) => s.name === card.name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    );
    if (!symbol) {
      texts.push(buildEmbedCode(card.name, card.signature, ''));
    } else {
      const body = extractFunctionBody(source, symbol);
      texts.push(buildEmbedCode(card.name, card.signature, body));
    }
  }
  return embedCodeBatch(texts);
}

/**
 * Apply NLP summaries to function cards and generate NLP embeddings.
 * Cards without a corresponding NLP summary get a zero-vector so they
 * don't falsely trigger hybrid search (only real NLP embeddings count).
 */
export async function applyNlpSummaries(
  cards: FunctionCard[],
  nlpSummaries: Map<string, NlpSummary>,
): Promise<{ enrichedCards: FunctionCard[]; nlpEmbeddings: number[][]; docEmbeddings: number[][]; nlpFailedIds: Set<string> }> {
  const enrichedCards: FunctionCard[] = [];
  const nlpEmbeddings: number[][] = [];
  const docEmbeddings: number[][] = [];
  const nlpFailedIds = new Set<string>();
  const nlpDimSize = getNlpDim();
  const zeroVector = new Array(nlpDimSize).fill(0);

  for (const card of cards) {
    const summary = nlpSummaries.get(card.id);
    if (summary) {
      enrichedCards.push({
        ...card,
        summary: summary.summary,
        docSummary: summary.docSummary,
        keyConcepts: summary.keyConcepts,
        behavioralProfile: summary.behavioralProfile,
      });
      const nlpText = buildEmbedNlp(card.name, summary.summary, summary.keyConcepts, summary.behavioralProfile ?? '');
      nlpEmbeddings.push(await embedNlp(nlpText));
      // Embed docSummary in doc-oriented semantic space for gap detection
      const docText = summary.docSummary || summary.summary;
      docEmbeddings.push(await embedNlp(docText));
    } else {
      enrichedCards.push(card);
      nlpEmbeddings.push([...zeroVector]);
      docEmbeddings.push([...zeroVector]);
      nlpFailedIds.add(card.id);
    }
  }

  return { enrichedCards, nlpEmbeddings, docEmbeddings, nlpFailedIds };
}

/**
 * Enrich function cards with NLP summary data without generating embeddings.
 * Used when NLP embedding is deferred to a batch phase after code embedding.
 */
export function enrichCardsWithSummaries(
  cards: FunctionCard[],
  nlpSummaries: Map<string, NlpSummary>,
): { enrichedCards: FunctionCard[]; nlpFailedIds: Set<string> } {
  const enrichedCards: FunctionCard[] = [];
  const nlpFailedIds = new Set<string>();

  for (const card of cards) {
    const summary = nlpSummaries.get(card.id);
    if (summary) {
      enrichedCards.push({
        ...card,
        summary: summary.summary,
        docSummary: summary.docSummary,
        keyConcepts: summary.keyConcepts,
        behavioralProfile: summary.behavioralProfile,
      });
    } else {
      enrichedCards.push(card);
      nlpFailedIds.add(card.id);
    }
  }

  return { enrichedCards, nlpFailedIds };
}

/**
 * Generate NLP embeddings for enriched function cards.
 * Cards without a summary get a zero-vector so they don't
 * falsely activate hybrid NLP search.
 */
export async function generateNlpEmbeddings(
  cards: FunctionCard[],
): Promise<number[][]> {
  const nlpDimSize = getNlpDim();
  const zeroVector = new Array(nlpDimSize).fill(0);

  // Collect texts and indices for cards that have summaries
  const textsToEmbed: string[] = [];
  const textIndices: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (card.summary) {
      textsToEmbed.push(buildEmbedNlp(card.name, card.summary, card.keyConcepts ?? [], card.behavioralProfile ?? ''));
      textIndices.push(i);
    }
  }

  // Batch-embed all NLP texts in a single request
  const batchResults = await embedNlpBatch(textsToEmbed);

  // Map back to card order, filling zero vectors for cards without summaries
  const nlpEmbeddings: number[][] = cards.map(() => [...zeroVector]);
  for (let j = 0; j < textIndices.length; j++) {
    nlpEmbeddings[textIndices[j]] = batchResults[j];
  }

  return nlpEmbeddings;
}

/**
 * Generate doc-oriented NLP embeddings for gap detection.
 * Uses docSummary (falls back to summary) for each card.
 */
export async function generateDocEmbeddings(
  cards: FunctionCard[],
): Promise<number[][]> {
  const nlpDimSize = getNlpDim();
  const zeroVector = new Array(nlpDimSize).fill(0);

  const textsToEmbed: string[] = [];
  const textIndices: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const text = cards[i].docSummary || cards[i].summary;
    if (text) {
      textsToEmbed.push(text);
      textIndices.push(i);
    }
  }

  const batchResults = await embedNlpBatch(textsToEmbed);

  const docEmbeddings: number[][] = cards.map(() => [...zeroVector]);
  for (let j = 0; j < textIndices.length; j++) {
    docEmbeddings[textIndices[j]] = batchResults[j];
  }

  return docEmbeddings;
}

function cachePath(projectRoot: string, cacheSuffix?: string): string {
  const file = cacheSuffix ? `cache_${cacheSuffix}.json` : 'cache.json';
  return resolve(projectRoot, '.anatoly', 'rag', file);
}

function nlpCachePath(projectRoot: string, cacheSuffix?: string): string {
  const file = cacheSuffix ? `nlp_summary_cache_${cacheSuffix}.json` : 'nlp_summary_cache.json';
  return resolve(projectRoot, '.anatoly', 'rag', file);
}

/**
 * Load the RAG cache from disk.
 * Returns a fresh empty cache if file doesn't exist or is corrupted.
 * When cacheSuffix is provided, loads cache_<suffix>.json instead of cache.json.
 */
export function loadRagCache(projectRoot: string, cacheSuffix?: string): RagCache {
  const path = cachePath(projectRoot, cacheSuffix);

  // Migration: if mode-specific cache doesn't exist, try legacy cache.json
  if (cacheSuffix && !existsSync(path)) {
    const legacyPath = cachePath(projectRoot);
    if (existsSync(legacyPath)) {
      try {
        return JSON.parse(readFileSync(legacyPath, 'utf-8')) as RagCache;
      } catch {
        return { entries: {} };
      }
    }
  }

  if (!existsSync(path)) {
    return { entries: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RagCache;
  } catch {
    return { entries: {} };
  }
}

/**
 * Save the RAG cache to disk atomically.
 * When cacheSuffix is provided, saves to cache_<suffix>.json instead of cache.json.
 */
export function saveRagCache(projectRoot: string, cache: RagCache, cacheSuffix?: string): void {
  atomicWriteJson(cachePath(projectRoot, cacheSuffix), cache);
}

// ---------------------------------------------------------------------------
// NLP Summary Cache I/O
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of a function body for NLP summary cache invalidation.
 */
export function computeBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Load the NLP summary cache from disk.
 * Returns a fresh empty cache if file doesn't exist or is corrupted.
 */
export function loadNlpSummaryCache(projectRoot: string, cacheSuffix?: string): NlpSummaryCache {
  const path = nlpCachePath(projectRoot, cacheSuffix);
  if (!existsSync(path)) {
    return { entries: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NlpSummaryCache;
  } catch {
    return { entries: {} };
  }
}

/**
 * Save the NLP summary cache to disk atomically.
 */
export function saveNlpSummaryCache(projectRoot: string, cache: NlpSummaryCache, cacheSuffix?: string): void {
  atomicWriteJson(nlpCachePath(projectRoot, cacheSuffix), cache);
}
