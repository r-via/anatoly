import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Task, SymbolInfo } from '../schemas/task.js';
import type { FunctionCard, FunctionCardLLMOutput } from './types.js';
import { embed, buildEmbedText } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { atomicWriteJson } from '../utils/cache.js';

interface RagCache {
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
 * Compute cyclomatic complexity from source lines of a function.
 * Counts branching constructs: if, else if, case, &&, ||, ternary, catch.
 */
export function computeComplexity(source: string, symbol: SymbolInfo): number {
  const lines = source.split('\n');
  const body = lines.slice(symbol.line_start - 1, symbol.line_end).join('\n');

  let complexity = 1; // base path
  const patterns = [
    /\bif\s*\(/g,
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
  const lines = source.split('\n');
  const body = lines.slice(symbol.line_start - 1, symbol.line_end).join('\n');

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
 * Build complete FunctionCards by merging LLM output with AST-derived data.
 */
export function buildFunctionCards(
  task: Task,
  source: string,
  llmCards: FunctionCardLLMOutput[],
): FunctionCard[] {
  const now = new Date().toISOString();
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  const cards: FunctionCard[] = [];

  for (const symbol of functionSymbols) {
    const llmCard = llmCards.find((c) => c.name === symbol.name);
    if (!llmCard) continue;

    const id = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    const signature = extractSignature(source, symbol);
    const complexityScore = computeComplexity(source, symbol);
    const calledInternals = extractCalledInternals(source, symbol, task.symbols);

    cards.push({
      id,
      filePath: task.file,
      name: symbol.name,
      signature,
      summary: llmCard.summary,
      keyConcepts: llmCard.keyConcepts,
      behavioralProfile: llmCard.behavioralProfile,
      complexityScore,
      calledInternals,
      lastIndexed: now,
    });
  }

  return cards;
}

/**
 * Index FunctionCards into the vector store.
 * Handles incremental updates: only re-embeds cards whose file hash changed.
 */
export async function indexCards(
  projectRoot: string,
  store: VectorStore,
  cards: FunctionCard[],
  fileHash: string,
): Promise<number> {
  if (cards.length === 0) return 0;

  const cachePath = resolve(projectRoot, '.anatoly', 'rag', 'cache.json');
  const cache = loadRagCache(cachePath);

  // Check which cards need re-indexing
  const toIndex = cards.filter((card) => {
    const cached = cache.entries[card.id];
    return cached !== fileHash;
  });

  if (toIndex.length === 0) return 0;

  // Generate embeddings
  const embeddings: number[][] = [];
  for (const card of toIndex) {
    const text = buildEmbedText(card);
    embeddings.push(await embed(text));
  }

  // Upsert into vector store
  await store.upsert(toIndex, embeddings);

  // Update cache
  for (const card of toIndex) {
    cache.entries[card.id] = fileHash;
  }
  atomicWriteJson(cachePath, cache);

  return toIndex.length;
}

function loadRagCache(cachePath: string): RagCache {
  if (!existsSync(cachePath)) {
    return { entries: {} };
  }
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as RagCache;
  } catch {
    return { entries: {} };
  }
}
