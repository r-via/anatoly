import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Task, SymbolInfo } from '../schemas/task.js';
import type { FunctionCard } from './types.js';
import { embed, buildEmbedCode, buildEmbedNlp } from './embeddings.js';
import { atomicWriteJson } from '../utils/cache.js';
import type { NlpSummary } from './nlp-summarizer.js';

export interface RagCache {
  /** Map of functionId → file hash at time of indexing */
  entries: Record<string, string>;
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
  const embeddings: number[][] = [];
  for (const card of cards) {
    const symbol = symbols.find(
      (s) => s.name === card.name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    );
    if (!symbol) {
      // Fallback: embed just the signature
      embeddings.push(await embed(buildEmbedCode(card.name, card.signature, '')));
      continue;
    }
    const body = extractFunctionBody(source, symbol);
    const codeText = buildEmbedCode(card.name, card.signature, body);
    embeddings.push(await embed(codeText));
  }
  return embeddings;
}

/**
 * Apply NLP summaries to function cards and generate NLP embeddings.
 * Cards without a corresponding NLP summary get a zero-vector placeholder.
 */
export async function applyNlpSummaries(
  cards: FunctionCard[],
  nlpSummaries: Map<string, NlpSummary>,
): Promise<{ enrichedCards: FunctionCard[]; nlpEmbeddings: number[][] }> {
  const enrichedCards: FunctionCard[] = [];
  const nlpEmbeddings: number[][] = [];

  for (const card of cards) {
    const summary = nlpSummaries.get(card.id);
    if (summary) {
      enrichedCards.push({
        ...card,
        summary: summary.summary,
        keyConcepts: summary.keyConcepts,
        behavioralProfile: summary.behavioralProfile,
      });
      const nlpText = buildEmbedNlp(card.name, summary.summary, summary.keyConcepts, summary.behavioralProfile);
      nlpEmbeddings.push(await embed(nlpText));
    } else {
      enrichedCards.push(card);
      // Generate a minimal NLP embedding from just the function name + signature
      const fallbackText = buildEmbedNlp(card.name, '', [], 'utility');
      nlpEmbeddings.push(await embed(fallbackText));
    }
  }

  return { enrichedCards, nlpEmbeddings };
}

/**
 * Load the RAG cache from disk.
 * Returns a fresh empty cache if file doesn't exist or is corrupted.
 */
export function loadRagCache(projectRoot: string): RagCache {
  const cachePath = resolve(projectRoot, '.anatoly', 'rag', 'cache.json');
  if (!existsSync(cachePath)) {
    return { entries: {} };
  }
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as RagCache;
  } catch {
    return { entries: {} };
  }
}

/**
 * Save the RAG cache to disk atomically.
 */
export function saveRagCache(projectRoot: string, cache: RagCache): void {
  const cachePath = resolve(projectRoot, '.anatoly', 'rag', 'cache.json');
  atomicWriteJson(cachePath, cache);
}
