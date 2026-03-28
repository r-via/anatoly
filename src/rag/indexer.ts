// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Task, SymbolInfo } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { embedCodeBatch, embedNlpBatch, buildEmbedCode, buildEmbedNlp, getNlpDim } from './embeddings.js';
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
 * @param filePath - Absolute or relative path to the source file.
 * @param lineStart - 1-based start line of the function.
 * @param lineEnd - 1-based end line of the function.
 * @returns A 16-character hex string (truncated SHA-256).
 */
export function buildFunctionId(filePath: string, lineStart: number, lineEnd: number): string {
  const input = `${filePath}:${lineStart}-${lineEnd}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Extract the signature of a function/method from source code using line range.
 * Scans up to 3 lines from the symbol start looking for `{` or `=>`, then
 * collapses whitespace and truncates to 200 characters.
 * @param source - Full file source text.
 * @param symbol - Symbol metadata with 1-based line_start.
 * @returns The extracted signature string (max 200 chars).
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
 * @param source - Full file source text.
 * @param symbol - Symbol metadata with 1-based line_start and line_end.
 * @returns The source lines from line_start to line_end (inclusive), joined with newlines.
 */
export function extractFunctionBody(source: string, symbol: SymbolInfo): string {
  const lines = source.split('\n');
  return lines.slice(symbol.line_start - 1, symbol.line_end).join('\n');
}

/**
 * Compute cyclomatic complexity from source lines of a function.
 * Counts branching constructs: if, else if, case, &&, ||, ternary, catch.
 * Maps the raw count to a 1–5 scale: ≤2→1, ≤5→2, ≤10→3, ≤20→4, >20→5.
 * @param source - Full file source text.
 * @param symbol - Symbol metadata with 1-based line_start and line_end.
 * @returns Complexity score on a 1–5 scale.
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
 * @param source - Full file source text.
 * @param symbol - The symbol whose body is searched for call sites.
 * @param allSymbols - All symbols in the file (self is excluded from results).
 * @returns Deduplicated array of symbol names called within the function body.
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
 * Filters task symbols to function/method/hook kinds, then computes
 * ID, signature, complexity, and internal call edges for each.
 * @param task - The parsed task containing file path and symbol list.
 * @param source - Full file source text.
 * @returns Array of FunctionCards (one per function/method/hook symbol).
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
 * @param cache - The RAG cache mapping function IDs to file hashes.
 * @param card - The function card to check.
 * @param fileHash - The current hash of the card's source file.
 * @returns `true` if the cached hash is missing or differs from fileHash.
 */
export function needsReindex(cache: RagCache, card: FunctionCard, fileHash: string): boolean {
  return cache.entries[card.id] !== fileHash;
}

/**
 * Generate embeddings for a list of cards using code-direct embedding.
 * Requires the source text and symbol info to extract function bodies.
 * @param cards - Function cards to embed.
 * @param source - Full file source text for body extraction.
 * @param symbols - Symbol metadata array for looking up each card's body.
 * @returns Promise resolving to a 2-D array of embedding vectors (one per card).
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
 * @param cards - Function cards to enrich with summary data.
 * @param nlpSummaries - Map of functionId → NlpSummary from the summariser.
 * @returns Promise resolving to `{ enrichedCards, nlpEmbeddings, docEmbeddings, nlpFailedIds }`
 *   where `nlpFailedIds` contains IDs of cards that had no summary available.
 */
export async function applyNlpSummaries(
  cards: FunctionCard[],
  nlpSummaries: Map<string, NlpSummary>,
): Promise<{ enrichedCards: FunctionCard[]; nlpEmbeddings: number[][]; docEmbeddings: number[][]; nlpFailedIds: Set<string> }> {
  const { enrichedCards, nlpFailedIds } = enrichCardsWithSummaries(cards, nlpSummaries);
  const nlpEmbeddings = await generateNlpEmbeddings(enrichedCards);
  const docEmbeddings = await generateDocEmbeddings(enrichedCards);
  return { enrichedCards, nlpEmbeddings, docEmbeddings, nlpFailedIds };
}

/**
 * Enrich function cards with NLP summary data without generating embeddings.
 * Used when NLP embedding is deferred to a batch phase after code embedding.
 * @param cards - Function cards to enrich.
 * @param nlpSummaries - Map of functionId → NlpSummary.
 * @returns `{ enrichedCards, nlpFailedIds }` where enrichedCards have summary
 *   fields merged and nlpFailedIds tracks cards with no available summary.
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

async function generateEmbeddingsBatch(
  cards: FunctionCard[],
  textExtractor: (card: FunctionCard) => string | undefined,
): Promise<number[][]> {
  const nlpDimSize = getNlpDim();
  const zeroVector = new Array(nlpDimSize).fill(0);

  const textsToEmbed: string[] = [];
  const textIndices: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const text = textExtractor(cards[i]);
    if (text) {
      textsToEmbed.push(text);
      textIndices.push(i);
    }
  }

  const batchResults = await embedNlpBatch(textsToEmbed);

  const embeddings: number[][] = cards.map(() => [...zeroVector]);
  for (let j = 0; j < textIndices.length; j++) {
    embeddings[textIndices[j]] = batchResults[j];
  }

  return embeddings;
}

/**
 * Generate NLP embeddings for enriched function cards.
 * Cards without a summary get a zero-vector so they don't
 * falsely activate hybrid NLP search.
 * @param cards - Enriched function cards (with optional summary fields).
 * @returns Promise resolving to a 2-D array of NLP embedding vectors (one per card).
 */
export async function generateNlpEmbeddings(
  cards: FunctionCard[],
): Promise<number[][]> {
  return generateEmbeddingsBatch(cards, (card) =>
    card.summary
      ? buildEmbedNlp(card.name, card.summary, card.keyConcepts ?? [], card.behavioralProfile ?? '')
      : undefined,
  );
}

/**
 * Generate doc-oriented NLP embeddings for gap detection.
 * Uses docSummary (falls back to summary) for each card.
 * @param cards - Enriched function cards (with optional docSummary/summary).
 * @returns Promise resolving to a 2-D array of doc embedding vectors (one per card).
 */
export async function generateDocEmbeddings(
  cards: FunctionCard[],
): Promise<number[][]> {
  return generateEmbeddingsBatch(cards, (card) =>
    card.docSummary || card.summary || undefined,
  );
}

function ragFilePath(projectRoot: string, prefix: string, cacheSuffix?: string): string {
  const file = cacheSuffix ? `${prefix}_${cacheSuffix}.json` : `${prefix}.json`;
  return resolve(projectRoot, '.anatoly', 'rag', file);
}

export function cachePath(projectRoot: string, cacheSuffix?: string): string {
  return ragFilePath(projectRoot, 'cache', cacheSuffix);
}

function nlpCachePath(projectRoot: string, cacheSuffix?: string): string {
  return ragFilePath(projectRoot, 'nlp_summary_cache', cacheSuffix);
}

/**
 * Load the RAG cache from disk.
 * Returns a fresh empty cache if file doesn't exist or is corrupted.
 * When cacheSuffix is provided, loads `cache_<suffix>.json` instead of `cache.json`.
 * Falls back to the legacy unsuffixed `cache.json` when the mode-specific file is absent.
 * @param projectRoot - Absolute path to the project root directory.
 * @param cacheSuffix - Optional mode suffix (e.g. `"lite"`) for the cache filename.
 * @returns The loaded RagCache, or an empty cache on missing/corrupted file.
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
 * When cacheSuffix is provided, saves to `cache_<suffix>.json` instead of `cache.json`.
 * @param projectRoot - Absolute path to the project root directory.
 * @param cache - The RagCache object to persist.
 * @param cacheSuffix - Optional mode suffix for the cache filename.
 */
export function saveRagCache(projectRoot: string, cache: RagCache, cacheSuffix?: string): void {
  atomicWriteJson(cachePath(projectRoot, cacheSuffix), cache);
}

// ---------------------------------------------------------------------------
// NLP Summary Cache I/O
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of a function body for NLP summary cache invalidation.
 * @param body - The function body source text to hash.
 * @returns A 16-character hex string (truncated SHA-256).
 */
export function computeBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Load the NLP summary cache from disk.
 * Returns a fresh empty cache if file doesn't exist or is corrupted.
 * @param projectRoot - Absolute path to the project root directory.
 * @param cacheSuffix - Optional mode suffix for the cache filename.
 * @returns The loaded NlpSummaryCache, or an empty cache on missing/corrupted file.
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
 * @param projectRoot - Absolute path to the project root directory.
 * @param cache - The NlpSummaryCache object to persist.
 * @param cacheSuffix - Optional mode suffix for the cache filename.
 */
export function saveNlpSummaryCache(projectRoot: string, cache: NlpSummaryCache, cacheSuffix?: string): void {
  atomicWriteJson(nlpCachePath(projectRoot, cacheSuffix), cache);
}
