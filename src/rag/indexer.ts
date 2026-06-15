// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { createHash } from 'node:crypto';
import type { Task, SymbolInfo } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { embedCodeBatch, embedNlpBatch, buildEmbedCode, buildEmbedNlp, getNlpDim } from './embeddings.js';
import { atomicWriteJson } from '../utils/cache.js';
import { writeCacheWithMeta, loadCacheWithMeta } from '../utils/cache-meta.js';
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

/** Symbol kinds indexed as LLM-summarized function cards. */
export const FUNCTION_KINDS: ReadonlySet<SymbolInfo['kind']> = new Set([
  'function',
  'method',
  'hook',
]);

/**
 * Symbol kinds indexed as non-callable declaration cards (AST summary, no LLM).
 * `class` is intentionally excluded: its methods are already indexed as function
 * cards, and the class shell carries little routing signal on its own.
 */
export const DECLARATION_KINDS: ReadonlySet<SymbolInfo['kind']> = new Set([
  'constant',
  'variable',
  'type',
  'enum',
]);

/** True for symbol kinds indexed as function cards. */
export function isFunctionKind(kind: SymbolInfo['kind']): boolean {
  return FUNCTION_KINDS.has(kind);
}

/** True for symbol kinds indexed as declaration cards. */
export function isDeclarationKind(kind: SymbolInfo['kind']): boolean {
  return DECLARATION_KINDS.has(kind);
}

/** True for any symbol kind the RAG index represents as a card. */
export function isIndexableKind(kind: SymbolInfo['kind']): boolean {
  return isFunctionKind(kind) || isDeclarationKind(kind);
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
    /\?[^?:]/g,   // ternary (avoid ?. and ??)
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
 * Extract the project symbols this function references from OTHER files — the
 * cross-file reference edge. Takes the imported NAMES declared at file scope
 * (`task.imports`) and keeps those that actually appear in the function body
 * (word-boundary), so a stale import that the function never touches is not
 * recorded. Name-only: file-level resolution is the usage graph's job at query
 * time. Namespace imports (`import * as X`) and bare default imports are skipped
 * (their source-side names are not the local binding used in the body).
 */
export function extractReferencedImports(
  body: string,
  imports: Task['imports'],
): string[] {
  if (!imports || imports.length === 0) return [];

  const names = new Set<string>();
  for (const imp of imports) {
    if (imp.namespace) continue;
    for (const name of imp.symbols ?? []) {
      if (name && name !== 'default') names.add(name);
    }
  }

  const referenced: string[] = [];
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    if (pattern.test(body)) referenced.push(name);
  }
  return [...new Set(referenced)];
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
    const referencedImports = extractReferencedImports(
      extractFunctionBody(source, symbol),
      task.imports,
    );

    cards.push({
      id,
      filePath: task.file,
      name: symbol.name,
      signature,
      complexityScore,
      calledInternals,
      referencedImports,
      kind: 'function',
      lastIndexed: now,
    });
  }

  return cards;
}

/** Human label for a declaration's symbol kind, used in its synthetic summary. */
const DECLARATION_KIND_LABEL: Record<string, string> = {
  constant: 'Constant',
  variable: 'Variable',
  type: 'Type definition',
  enum: 'Enum',
};

/**
 * Synthesize an LLM-free natural-language summary for a declaration from its AST
 * signature. This is what gives the card a real (non-zero) NLP vector via
 * {@link generateNlpEmbeddings} without an LLM round-trip, so data-only files
 * (constants/types only, no functions) still contribute to the per-file average
 * NLP vector used for reference-doc routing.
 */
export function buildDeclarationSummary(symbol: SymbolInfo, signature: string): string {
  const label = DECLARATION_KIND_LABEL[symbol.kind] ?? 'Declaration';
  return `${label} ${symbol.name}. ${signature}`.slice(0, 400);
}

/**
 * Build declaration cards (const/variable/type/enum) from AST data only.
 *
 * Unlike function cards these carry a pre-set AST summary and `kind:
 * 'declaration'`, so the NLP phase skips them for LLM summarization (see the
 * guards in the orchestrator / {@link enrichCardsWithSummaries}) yet they still
 * receive a real NLP embedding. complexityScore is a flat 1 and calledInternals
 * is empty (a declaration calls nothing); referencedImports is still captured so
 * the cross-file reference graph stays complete.
 */
export function buildDeclarationCards(
  task: Task,
  source: string,
): FunctionCard[] {
  const now = new Date().toISOString();
  const declarationSymbols = task.symbols.filter((s) => isDeclarationKind(s.kind));

  const cards: FunctionCard[] = [];

  for (const symbol of declarationSymbols) {
    const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    const signature = extractSignature(source, symbol);
    const referencedImports = extractReferencedImports(
      extractFunctionBody(source, symbol),
      task.imports,
    );

    cards.push({
      id,
      filePath: task.file,
      name: symbol.name,
      signature,
      summary: buildDeclarationSummary(symbol, signature),
      keyConcepts: [symbol.name],
      complexityScore: 1,
      calledInternals: [],
      referencedImports,
      kind: 'declaration',
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
      (s) => s.name === card.name && isIndexableKind(s.kind),
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
    } else if (card.kind === 'declaration') {
      // Declarations carry an AST-synthesized summary and are never sent to the
      // LLM, so an absent NLP summary is expected — keep the card as-is and do
      // NOT flag it failed (a failed card is dropped from the index cache and
      // retried every run).
      enrichedCards.push(card);
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
  return anatolyPath(projectRoot, 'cache/rag', file);
}

function nlpCachePath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'cache/rag', 'nlp_summary_cache.json');
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
 *
 * The cache is mode-agnostic because summaries depend only on the
 * function body and the configured `models.fast` LLM, not on the RAG
 * embedding backend. (No legacy mode-suffixed migration is performed; a
 * pre-unification cache is regenerated on the next index.)
 */
export function loadNlpSummaryCache(projectRoot: string): NlpSummaryCache {
  const path = nlpCachePath(projectRoot);
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
export function saveNlpSummaryCache(projectRoot: string, cache: NlpSummaryCache): void {
  atomicWriteJson(nlpCachePath(projectRoot), cache);
}

// ---------------------------------------------------------------------------
// Per-tenant NLP Summary Cache — content-addressable in cache/nlp-summaries/
// (derives from user code → not multi-tenant safe, lives under user/ not shared/)
// ---------------------------------------------------------------------------

/** Path to a per-tenant NLP summary: `cache/nlp-summaries/<hash[0:2]>/<hash>.json` */
export function sharedNlpSummaryPath(root: string, bodyHash: string): string {
  return anatolyPath(root, 'cache/nlp-summaries', bodyHash.slice(0, 2), bodyHash + '.json');
}

/** Path to the per-project NLP summary key index. */
function nlpSummaryKeysPath(root: string): string {
  return anatolyPath(root, 'cache/rag', 'nlp-summary-keys.json');
}

export interface NlpSummaryKeysIndex {
  version: 1;
  keys: Record<string, { updated_at: string }>;
}

function loadNlpSummaryKeys(root: string): NlpSummaryKeysIndex {
  const path = nlpSummaryKeysPath(root);
  if (!existsSync(path)) return { version: 1, keys: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NlpSummaryKeysIndex;
  } catch {
    return { version: 1, keys: {} };
  }
}

/**
 * Write an NLP summary to the shared content-addressable store.
 */
export function writeSharedNlpSummary(
  root: string,
  bodyHash: string,
  summary: NlpSummary,
  modelId: string,
): void {
  const path = sharedNlpSummaryPath(root, bodyHash);
  writeCacheWithMeta(path, summary, {
    schema: 1,
    prompt_hash: 'sha256:nlp-summarizer',
    model_id: modelId,
  });

  // Update per-project key index
  const index = loadNlpSummaryKeys(root);
  index.keys[bodyHash] = { updated_at: new Date().toISOString() };
  atomicWriteJson(nlpSummaryKeysPath(root), index);
}

/**
 * Load a shared NLP summary by body hash.
 */
export function loadSharedNlpSummary(root: string, bodyHash: string): NlpSummary | null {
  const path = sharedNlpSummaryPath(root, bodyHash);
  return loadCacheWithMeta<NlpSummary>(path, {
    schema: 1,
    promptHash: 'sha256:nlp-summarizer',
  });
}
