import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { FunctionCard, SimilarityResult, RagStats } from './types.js';
import { EMBEDDING_DIM } from './embeddings.js';
import { atomicWriteJson } from '../utils/cache.js';

const TABLE_NAME = 'function_cards';

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
}

/** Options for upserting cards with optional NLP embeddings. */
export interface UpsertOptions {
  nlpEmbeddings?: number[][];
}

export class VectorStore {
  private dbPath: string;
  private projectRoot: string;
  private db: Connection | null = null;
  private table: Table | null = null;
  private onLog: (message: string) => void = () => {};
  private _hasDualEmbedding = false;

  constructor(projectRoot: string, onLog?: (message: string) => void) {
    this.projectRoot = projectRoot;
    this.dbPath = resolve(projectRoot, '.anatoly', 'rag', 'lancedb');
    if (onLog) this.onLog = onLog;
  }

  /** Whether the index contains NLP vectors (dual embedding). */
  get hasDualEmbedding(): boolean {
    return this._hasDualEmbedding;
  }

  async init(): Promise<void> {
    mkdirSync(this.dbPath, { recursive: true });
    this.db = await connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);

      // Detect dimension mismatch and auto-rebuild
      try {
        const sample = await this.table.query().limit(1).toArray();
        if (sample.length > 0) {
          const storedDim = (sample[0].vector as number[]).length;
          if (storedDim !== EMBEDDING_DIM) {
            this.onLog(`dimension mismatch: index has ${storedDim}-dim vectors, model expects ${EMBEDDING_DIM}-dim — rebuilding index`);
            await this.rebuild();
            // Clear RAG cache atomically to force full re-indexation
            const cachePath = resolve(this.projectRoot, '.anatoly', 'rag', 'cache.json');
            atomicWriteJson(cachePath, { entries: {} });
          }

          // Detect whether NLP vectors are present
          if (sample[0].nlp_vector) {
            const nlpVec = sample[0].nlp_vector as number[];
            this._hasDualEmbedding = nlpVec.length === EMBEDDING_DIM && nlpVec.some((v) => v !== 0);
          }
        }
      } catch {
        // If we can't read a sample, proceed normally — table may be empty
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
      nlp_vector: nlpEmbeddings?.[i] ?? new Array(EMBEDDING_DIM).fill(0),
    }));

    if (!this.table) {
      // Create table with first batch
      this.table = await this.db.createTable(TABLE_NAME, rows);
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
      const score = distanceToCosineSimilarity(row._distance ?? 0);
      return score >= minScore ? [{ card: rowToCard(row), score }] : [];
    });
  }

  /**
   * Search for similar functions by NLP embedding vector.
   */
  async searchByNlpVector(
    queryEmbedding: number[],
    limit: number = 8,
    minScore: number = 0.65,
  ): Promise<SimilarityResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .search(queryEmbedding)
      .column('nlp_vector')
      .limit(limit)
      .toArray();

    return results.flatMap((row) => {
      const score = distanceToCosineSimilarity(row._distance ?? 0);
      return score >= minScore ? [{ card: rowToCard(row), score }] : [];
    });
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
    const embedding = matches[0].vector as number[];
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
    const codeEmbedding = matches[0].vector as number[];
    const nlpEmbedding = matches[0].nlp_vector as number[] | undefined;

    // If no NLP vector or it's all zeros, fall back to code-only search
    if (!nlpEmbedding || nlpEmbedding.every((v) => v === 0)) {
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
   * List all cards (without embedding vectors).
   */
  async listAll(): Promise<FunctionCard[]> {
    if (!this.table) return [];
    const rows = await this.table
      .query()
      .select(['id', 'filePath', 'name', 'summary', 'keyConcepts', 'signature', 'behavioralProfile', 'complexityScore', 'calledInternals', 'lastIndexed'])
      .toArray();
    return rows.map(rowToCard);
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
      await this.db.dropTable(TABLE_NAME);
    } catch {
      // Table might not exist
    }
    this.table = null;
    this._hasDualEmbedding = false;
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
      return { totalCards: 0, totalFiles: 0, lastIndexed: null, dualEmbedding: false };
    }

    const totalCards = await this.table.countRows();

    // Fetch only filePath and lastIndexed for aggregation
    const rows = await this.table
      .query()
      .select(['filePath', 'lastIndexed'])
      .toArray();

    const files = new Set(rows.map((r) => r.filePath as string));
    const lastIndexed = rows.reduce((max, r) => {
      const d = r.lastIndexed as string;
      return d > max ? d : max;
    }, '');

    return {
      totalCards,
      totalFiles: files.size,
      lastIndexed: lastIndexed || null,
      dualEmbedding: this._hasDualEmbedding,
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
