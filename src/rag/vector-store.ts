// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { FunctionCard, SimilarityResult, RagStats, DocSectionEntry } from './types.js';
import { getCodeDim, getNlpDim } from './embeddings.js';
const DEFAULT_TABLE_NAME = 'function_cards';

/**
 * Validate that an ID is a 16-char hex string (as produced by buildFunctionId).
 * Throws if the ID doesn't match, preventing injection via filter predicates.
 */
export function sanitizeId(id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id)) {
    throw new Error(`Invalid function ID: expected 16-char hex string, got "${id}"`);
  }
  return id;
}

/**
 * Escape single quotes in file paths for LanceDB filter strings.
 * Prevents injection via filePath values in SQL-like WHERE clauses.
 */
export function sanitizeFilePath(path: string): string {
  return path.replace(/'/g, "''");
}

interface VectorRow {
  [key: string]: unknown;
  id: string;
  filePath: string;
  name: string;
  summary: string;
  keyConcepts: string;       // JSON-serialized string[]
  signature: string;
  behavioralProfile: string;
  complexityScore: number;
  calledInternals: string;   // JSON-serialized string[]
  lastIndexed: string;
  vector: number[];
  nlp_vector: number[];
  /** Discriminator: 'function' (default) or 'doc_section'. */
  type: string;
}

/** Options for upserting cards with optional NLP embeddings. */
export interface UpsertOptions {
  nlpEmbeddings?: number[][];
}

export class VectorStore {
  private dbPath: string;
  private projectRoot: string;
  private tableName: string;
  private db: Connection | null = null;
  private table: Table | null = null;
  private onLog: (message: string) => void = () => {};
  private _hasDualEmbedding = false;
  private _cachedCodeDim: number | undefined;
  private _cachedNlpDim: number | undefined;

  constructor(projectRoot: string, tableName?: string, onLog?: (message: string) => void) {
    this.projectRoot = projectRoot;
    this.tableName = tableName ?? DEFAULT_TABLE_NAME;
    this.dbPath = resolve(projectRoot, '.anatoly', 'rag', 'lancedb');
    if (onLog) this.onLog = onLog;
  }

  /** Whether the index contains NLP vectors (dual embedding). */
  get hasDualEmbedding(): boolean {
    return this._hasDualEmbedding;
  }

  async init(): Promise<void> {
    mkdirSync(this.dbPath, { recursive: true });
    this.onLog(`vector-store: connecting to ${this.dbPath} (table: ${this.tableName})`);
    this.db = await connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    this.onLog(`vector-store: existing tables: ${tableNames.length > 0 ? tableNames.join(', ') : '(none)'}`);

    if (tableNames.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);

      // Detect dual embedding and warn on dimension mismatches
      try {
        const sample = await this.table.query().limit(1).toArray();
        if (sample.length > 0) {
          // Cache and warn if stored code vector dimension doesn't match current model
          const storedCodeDim = toNumberArray(sample[0].vector).length;
          if (storedCodeDim > 0) this._cachedCodeDim = storedCodeDim;
          const expectedCodeDim = getCodeDim();
          if (storedCodeDim > 0 && storedCodeDim !== expectedCodeDim) {
            this.onLog(`⚠️ dimension mismatch: stored code vectors are ${storedCodeDim}-dim but current model expects ${expectedCodeDim}-dim — run 'anatoly rag-index --rebuild' to fix`);
          }

          if ('nlp_vector' in sample[0]) {
            const nlpVec = toNumberArray(sample[0].nlp_vector);
            if (nlpVec.length > 0 && nlpVec.some((v) => v !== 0)) {
              this._hasDualEmbedding = true;
              this._cachedNlpDim = nlpVec.length;
              // Warn if stored NLP vector dimension doesn't match current model
              const expectedNlpDim = getNlpDim();
              if (nlpVec.length !== expectedNlpDim) {
                this.onLog(`⚠️ dimension mismatch: stored NLP vectors are ${nlpVec.length}-dim but current model expects ${expectedNlpDim}-dim — run 'anatoly rag-index --rebuild' to fix`);
              }
            }
          }
        }
      } catch {
        // Table may be empty or have unexpected schema — proceed normally
      }
    }
  }

  /**
   * Upsert FunctionCards with their embedding vectors into the store.
   * Optionally includes NLP embedding vectors for dual-embedding mode.
   */
  async upsert(cards: FunctionCard[], embeddings: number[][], options?: UpsertOptions): Promise<void> {
    if (cards.length === 0) return;
    if (!this.db) throw new Error('VectorStore not initialized');

    const nlpEmbeddings = options?.nlpEmbeddings;

    const rows: VectorRow[] = cards.map((card, i) => ({
      id: card.id,
      filePath: card.filePath,
      name: card.name,
      summary: card.summary ?? '',
      keyConcepts: JSON.stringify(card.keyConcepts ?? []),
      signature: card.signature,
      behavioralProfile: card.behavioralProfile ?? 'utility',
      complexityScore: card.complexityScore,
      calledInternals: JSON.stringify(card.calledInternals),
      lastIndexed: card.lastIndexed,
      vector: embeddings[i],
      // Fresh zero-vector per row to avoid shared reference mutation by Arrow serialization
      nlp_vector: nlpEmbeddings?.[i] ?? new Array(getNlpDim()).fill(0),
      type: 'function',
    }));

    if (!this.table) {
      // Create table with first batch
      this.onLog(`vector-store: creating table ${this.tableName} (${rows.length} rows, vector dim=${rows[0].vector.length})`);
      this.table = await this.db.createTable(this.tableName, rows);
      if (nlpEmbeddings) this._hasDualEmbedding = true;
      return;
    }

    // Delete existing rows with matching IDs, then add new ones
    const ids = cards.map((c) => sanitizeId(c.id));
    try {
      await this.table.delete(`id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
    } catch {
      // Table might be empty or IDs don't exist — that's fine
    }
    await this.table.add(rows);
    if (nlpEmbeddings) this._hasDualEmbedding = true;
  }

  /**
   * Search for similar functions by embedding vector (code-only).
   */
  async search(
    queryEmbedding: number[],
    limit: number = 8,
    minScore: number = 0.75,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .search(queryEmbedding)
      .limit(limit)
      .toArray();

    return results.flatMap((row) => {
      if (row.type === 'doc_section') return [];
      const score = distanceToCosineSimilarity(row._distance ?? 0);
      return score >= minScore ? [{ card: rowToCard(row), score }] : [];
    });
  }

  /**
   * Search for similar functions by NLP embedding vector.
   * Excludes doc_section rows (use searchDocSections for those).
   */
  async searchByNlpVector(
    queryEmbedding: number[],
    limit: number = 8,
    minScore: number = 0.65,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .vectorSearch(queryEmbedding)
      .column('nlp_vector')
      .limit(limit)
      .toArray();

    return results.flatMap((row: Record<string, unknown>) => {
      if (row.type === 'doc_section') return [];
      const score = distanceToCosineSimilarity(Number(row._distance ?? 0));
      return score >= minScore ? [{ card: rowToCard(row), score }] : [];
    });
  }

  /**
   * Search doc sections by NLP embedding vector.
   * Returns only type='doc_section' cards — used by the documentation axis.
   */
  async searchDocSections(
    queryEmbedding: number[],
    limit: number = 5,
    minScore: number = 0.50,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .vectorSearch(queryEmbedding)
      .column('nlp_vector')
      .limit(limit * 3)
      .toArray();

    return results
      .filter((row: Record<string, unknown>) => row.type === 'doc_section')
      .flatMap((row: Record<string, unknown>) => {
        const score = distanceToCosineSimilarity(Number(row._distance ?? 0));
        return score >= minScore ? [{ card: rowToCard(row), score }] : [];
      })
      .slice(0, limit);
  }

  /**
   * Search by function ID: find the card, then search by its code embedding.
   */
  async searchById(
    functionId: string,
    limit: number = 8,
    minScore: number = 0.75,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const safeId = sanitizeId(functionId);
    const matches = await this.table
      .query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();

    if (matches.length === 0) return [];

    const queryCard = rowToCard(matches[0]);
    const embedding = toNumberArray(matches[0].vector);
    const results = await this.search(embedding, limit + 1, minScore);

    // Exclude self-matches: same ID (exact) or same file+name (stale entries from re-indexation)
    return results.filter(
      (r) => r.card.id !== functionId && !(r.card.filePath === queryCard.filePath && r.card.name === queryCard.name),
    );
  }

  /**
   * Hybrid search by function ID: combines code similarity and NLP similarity.
   * Uses weighted scoring: final = codeWeight * codeScore + (1 - codeWeight) * nlpScore.
   *
   * Falls back to code-only search if NLP vectors are not available.
   */
  async searchByIdHybrid(
    functionId: string,
    codeWeight: number = 0.6,
    limit: number = 8,
    minScore: number = 0.70,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const safeId = sanitizeId(functionId);
    const matches = await this.table
      .query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();

    if (matches.length === 0) return [];

    const queryCard = rowToCard(matches[0]);
    const codeEmbedding = toNumberArray(matches[0].vector);
    const nlpEmbedding = toNumberArray(matches[0].nlp_vector);

    // If no NLP vector or it's all zeros, fall back to code-only search
    if (nlpEmbedding.length === 0 || nlpEmbedding.every((v) => v === 0)) {
      return this.searchById(functionId, limit, minScore);
    }

    const nlpWeight = 1 - codeWeight;

    // Run both searches in parallel with lower individual thresholds
    const [codeResults, nlpResults] = await Promise.all([
      this.search(codeEmbedding, limit * 2, 0.5),
      this.searchByNlpVector(nlpEmbedding, limit * 2, 0.5),
    ]);

    // Build a unified score map: card.id → { codeScore, nlpScore }
    const scoreMap = new Map<string, { card: FunctionCard; codeScore: number; nlpScore: number }>();

    for (const r of codeResults) {
      scoreMap.set(r.card.id, { card: r.card, codeScore: r.score, nlpScore: 0 });
    }
    for (const r of nlpResults) {
      const existing = scoreMap.get(r.card.id);
      if (existing) {
        existing.nlpScore = r.score;
      } else {
        scoreMap.set(r.card.id, { card: r.card, codeScore: 0, nlpScore: r.score });
      }
    }

    // Compute hybrid score and filter
    const hybridResults: SimilarityResult[] = [];
    for (const [id, entry] of scoreMap) {
      // Exclude self-matches
      if (id === functionId) continue;
      if (entry.card.filePath === queryCard.filePath && entry.card.name === queryCard.name) continue;

      const hybridScore = codeWeight * entry.codeScore + nlpWeight * entry.nlpScore;
      if (hybridScore >= minScore) {
        hybridResults.push({ card: entry.card, score: hybridScore });
      }
    }

    // Sort by hybrid score descending, take top N
    hybridResults.sort((a, b) => b.score - a.score);
    return hybridResults.slice(0, limit);
  }

  /**
   * Upsert doc section cards with NLP embedding vectors into the store.
   * Code vectors are set to zero (doc sections are NLP-only).
   */
  async upsertDocSections(
    sections: Array<{ id: string; filePath: string; name: string; summary: string }>,
    nlpEmbeddings: number[][],
  ): Promise<void> {
    if (sections.length === 0) return;
    if (!this.db) throw new Error('VectorStore not initialized');

    const rows: VectorRow[] = sections.map((sec, i) => ({
      id: sec.id,
      filePath: sec.filePath,
      name: sec.name,
      summary: sec.summary,
      keyConcepts: '[]',
      signature: '',
      behavioralProfile: '',
      complexityScore: 0,
      calledInternals: '[]',
      lastIndexed: new Date().toISOString(),
      vector: new Array(getCodeDim()).fill(0),
      nlp_vector: nlpEmbeddings[i],
      type: 'doc_section',
    }));

    if (!this.table) {
      this.onLog(`vector-store: creating table ${this.tableName} (${rows.length} doc section rows)`);
      this.table = await this.db.createTable(this.tableName, rows);
      return;
    }

    // Delete existing doc sections for the same files, then add new ones
    const files = [...new Set(sections.map((s) => s.filePath))];
    for (const file of files) {
      try {
        await this.table.delete(`filePath = '${sanitizeFilePath(file)}' AND type = 'doc_section'`);
      } catch {
        // Might not exist or table might not have type column yet
      }
    }
    await this.table.add(rows);
  }

  /**
   * Delete specific doc section cards by their IDs.
   */
  async deleteDocSections(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    for (const id of ids) {
      try {
        await this.table.delete(`id = '${id}' AND type = 'doc_section'`);
      } catch {
        // May not exist
      }
    }
  }

  /**
   * Get function cards for a specific file (excludes doc_section rows).
   */
  async getCardsByFile(filePath: string): Promise<FunctionCard[]> {
    if (!this.table) return [];
    const rows = await this.table
      .query()
      .where(`filePath = '${sanitizeFilePath(filePath)}'`)
      .select(['id', 'filePath', 'name', 'summary', 'keyConcepts', 'signature', 'behavioralProfile', 'complexityScore', 'calledInternals', 'lastIndexed', 'type'])
      .toArray();
    return rows.filter(r => r.type !== 'doc_section').map(rowToCard);
  }

  /**
   * Get the average NLP vector for all function cards in a file.
   * Returns null if no cards or no NLP vectors are available.
   */
  async getAverageNlpVectorByFile(filePath: string): Promise<number[] | null> {
    if (!this.table) return null;
    const rows = await this.table
      .query()
      .where(`filePath = '${sanitizeFilePath(filePath)}' AND type != 'doc_section'`)
      .select(['nlp_vector'])
      .toArray();

    if (rows.length === 0) return null;

    const vectors = rows
      .map((r) => toNumberArray(r.nlp_vector))
      .filter((v) => v.some((x) => x !== 0)); // skip zero vectors

    if (vectors.length === 0) return null;

    // Average all NLP vectors and L2-normalize for cosine similarity
    const dim = vectors[0].length;
    const avg = new Array(dim).fill(0);
    for (const vec of vectors) {
      for (let i = 0; i < dim; i++) avg[i] += vec[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= vectors.length;

    // L2-normalize so cosine distance thresholds behave consistently
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) avg[i] /= norm;
    }
    return avg;
  }

  /**
   * List all cards (without embedding vectors).
   */
  async listAll(): Promise<FunctionCard[]> {
    if (!this.table) return [];
    const rows = await this.table
      .query()
      .select(['id', 'filePath', 'name', 'summary', 'keyConcepts', 'signature', 'behavioralProfile', 'complexityScore', 'calledInternals', 'lastIndexed', 'type'])
      .toArray();
    return rows.filter((r) => r.type !== 'doc_section').map(rowToCard);
  }

  /**
   * List all doc_section rows in the index.
   */
  async listDocSections(): Promise<DocSectionEntry[]> {
    if (!this.table) return [];
    const rows = await this.table
      .query()
      .select(['id', 'filePath', 'name', 'summary', 'lastIndexed', 'type'])
      .toArray();
    return rows
      .filter((r) => r.type === 'doc_section')
      .map((r) => ({
        id: r.id as string,
        filePath: r.filePath as string,
        name: r.name as string,
        summary: r.summary as string,
        lastIndexed: r.lastIndexed as string,
      }));
  }

  /**
   * Find cards by function name (case-insensitive substring match).
   */
  async searchByName(name: string): Promise<FunctionCard[]> {
    const all = await this.listAll();
    const lower = name.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(lower));
  }

  /**
   * Delete all cards for a given file path.
   */
  async deleteByFile(filePath: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`filePath = '${sanitizeFilePath(filePath)}'`);
    } catch {
      // File might not have any cards — that's fine
    }
  }

  /**
   * Drop and recreate the table (for --rebuild-rag).
   */
  async rebuild(): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized');
    try {
      await this.db.dropTable(this.tableName);
    } catch {
      // Table might not exist
    }
    this.table = null;
    this._hasDualEmbedding = false;
    this._cachedCodeDim = undefined;
    this._cachedNlpDim = undefined;
  }

  /**
   * Return the set of distinct file paths currently in the index.
   */
  async listIndexedFiles(): Promise<Set<string>> {
    if (!this.table) return new Set();
    const rows = await this.table
      .query()
      .select(['filePath'])
      .toArray();
    return new Set(rows.map((r) => r.filePath as string));
  }

  /**
   * Get stats about the index.
   */
  async stats(): Promise<RagStats> {
    if (!this.table) {
      return { totalCards: 0, totalFiles: 0, lastIndexed: null, dualEmbedding: false, docSections: 0, cardsWithSummary: 0 };
    }

    // Fetch filePath, lastIndexed, type, and summary for aggregation
    const rows = await this.table
      .query()
      .select(['filePath', 'lastIndexed', 'type', 'summary'])
      .toArray();

    let docSections = 0;
    let cardsWithSummary = 0;
    const files = new Set<string>();
    let lastIndexed = '';

    for (const r of rows) {
      const fp = r.filePath as string;
      const ts = r.lastIndexed as string;
      if (ts > lastIndexed) lastIndexed = ts;

      if (r.type === 'doc_section') {
        docSections++;
      } else {
        files.add(fp);
        const summary = r.summary as string | undefined;
        if (summary && summary.length > 0) cardsWithSummary++;
      }
    }

    const totalCards = rows.length - docSections;

    return {
      totalCards,
      totalFiles: files.size,
      lastIndexed: lastIndexed || null,
      dualEmbedding: this._hasDualEmbedding,
      codeDim: this._cachedCodeDim,
      nlpDim: this._cachedNlpDim,
      docSections,
      cardsWithSummary,
    };
  }
}

/**
 * Convert LanceDB L2 distance to cosine similarity.
 *
 * LanceDB default metric is L2 (euclidean). The `_distance` field contains the
 * **squared** L2 distance (L2²). For normalized vectors, the relationship is:
 *   cosine_similarity = 1 - L2² / 2
 */
function distanceToCosineSimilarity(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - distance / 2));
}

/**
 * Convert a LanceDB Arrow FloatVector to a plain number[].
 * LanceDB returns vectors as Apache Arrow FloatVector objects, which lack
 * standard Array methods like .every() and .some(). Array.from() safely
 * converts any iterable (including FloatVector) to a real number[].
 */
function toNumberArray(vec: unknown): number[] {
  if (Array.isArray(vec)) return vec;
  if (vec && typeof (vec as Iterable<number>)[Symbol.iterator] === 'function') {
    return Array.from(vec as Iterable<number>);
  }
  return [];
}

function safeParseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const VALID_BEHAVIORAL_PROFILES = new Set([
  'pure', 'sideEffectful', 'async', 'memoized', 'stateful', 'utility',
]);

function rowToCard(row: Record<string, unknown>): FunctionCard {
  const profile = String(row.behavioralProfile ?? 'utility');
  return {
    id: String(row.id ?? ''),
    filePath: String(row.filePath ?? ''),
    name: String(row.name ?? ''),
    signature: String(row.signature ?? ''),
    summary: String(row.summary ?? ''),
    keyConcepts: safeParseJsonArray(row.keyConcepts),
    behavioralProfile: (VALID_BEHAVIORAL_PROFILES.has(profile)
      ? profile
      : 'utility') as FunctionCard['behavioralProfile'],
    complexityScore: typeof row.complexityScore === 'number' ? row.complexityScore : 1,
    calledInternals: safeParseJsonArray(row.calledInternals),
    lastIndexed: String(row.lastIndexed ?? ''),
  };
}
