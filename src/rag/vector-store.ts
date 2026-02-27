import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { FunctionCard, SimilarityResult, RagStats } from './types.js';
import { EMBEDDING_DIM } from './embeddings.js';

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
}

export class VectorStore {
  private dbPath: string;
  private projectRoot: string;
  private db: Connection | null = null;
  private table: Table | null = null;
  private onLog: (message: string) => void = () => {};

  constructor(projectRoot: string, onLog?: (message: string) => void) {
    this.projectRoot = projectRoot;
    this.dbPath = resolve(projectRoot, '.anatoly', 'rag', 'lancedb');
    if (onLog) this.onLog = onLog;
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
            // Clear RAG cache to force full re-indexation
            const cachePath = resolve(this.projectRoot, '.anatoly', 'rag', 'cache.json');
            const { writeFileSync } = await import('node:fs');
            writeFileSync(cachePath, JSON.stringify({ entries: {} }));
          }
        }
      } catch {
        // If we can't read a sample, proceed normally — table may be empty
      }
    }
  }

  /**
   * Upsert FunctionCards with their embedding vectors into the store.
   */
  async upsert(cards: FunctionCard[], embeddings: number[][]): Promise<void> {
    if (cards.length === 0) return;
    if (!this.db) throw new Error('VectorStore not initialized');

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
    }));

    if (!this.table) {
      // Create table with first batch
      this.table = await this.db.createTable(TABLE_NAME, rows);
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
  }

  /**
   * Search for similar functions by embedding vector.
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
   * Search by function ID: find the card, then search by its embedding.
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
      return { totalCards: 0, totalFiles: 0, lastIndexed: null };
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
  return 1 - distance / 2;
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
