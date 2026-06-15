// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '@lancedb/lancedb';
import { VectorStore, sanitizeId, sanitizeFilePath } from './vector-store.js';

describe('sanitizeId', () => {
  it('accepts a valid 16-char hex string', () => {
    expect(sanitizeId('a1b2c3d4e5f6a7b8')).toBe('a1b2c3d4e5f6a7b8');
  });

  it('throws on SQL injection attempt', () => {
    expect(() => sanitizeId("' OR 1=1 --")).toThrow('Invalid function ID');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeId('')).toThrow('Invalid function ID');
  });

  it('throws on uppercase hex', () => {
    expect(() => sanitizeId('A1B2C3D4E5F6A7B8')).toThrow('Invalid function ID');
  });

  it('throws on wrong length', () => {
    expect(() => sanitizeId('a1b2c3')).toThrow('Invalid function ID');
  });

  it('throws on special characters', () => {
    expect(() => sanitizeId('a1b2c3d4e5f6a7b!')).toThrow('Invalid function ID');
  });
});

describe('sanitizeFilePath', () => {
  it('returns normal paths unchanged', () => {
    expect(sanitizeFilePath('src/utils/cache.ts')).toBe('src/utils/cache.ts');
  });

  it('escapes single quotes', () => {
    expect(sanitizeFilePath("src/it's-a-file.ts")).toBe("src/it''s-a-file.ts");
  });

  it('escapes multiple single quotes', () => {
    expect(sanitizeFilePath("a'b'c")).toBe("a''b''c");
  });

  it('handles SQL injection attempt in file path', () => {
    expect(sanitizeFilePath("'; DROP TABLE cards; --")).toBe("''; DROP TABLE cards; --");
  });
});

// ---------------------------------------------------------------------------
// Dimension drift handling — integration tests against a real LanceDB store
// ---------------------------------------------------------------------------

describe('VectorStore — dimension drift', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vs-drift-'));
    dbPath = join(dir, '.anatoly', 'cache', 'rag', 'lancedb');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Seed a `function_cards` table with one row whose vector dimensions are
   * supplied by the caller. Used to fabricate drift relative to the current
   * `getCodeDim()` / `getNlpDim()` (which default to 768 / 384).
   */
  async function seedTable(codeDim: number, nlpDim: number): Promise<void> {
    mkdirSync(dbPath, { recursive: true });
    const db = await connect(dbPath);
    await db.createTable('function_cards', [{
      id: 'aaaaaaaaaaaaaaaa',
      filePath: 'src/foo.ts',
      name: 'foo',
      summary: '',
      docSummary: '',
      keyConcepts: '[]',
      signature: '',
      behavioralProfile: '',
      complexityScore: 0,
      calledInternals: '[]',
      referencedImports: '[]',
      lastIndexed: '2024-01-01',
      vector: new Array(codeDim).fill(0.1),
      nlp_vector: new Array(nlpDim).fill(0.2),
      doc_vector: new Array(nlpDim).fill(0),
      type: 'function',
      source: '',
    }]);
  }

  async function listTables(): Promise<string[]> {
    const db = await connect(dbPath);
    return db.tableNames();
  }

  it('drops the table when stored dim differs from active dim and rebuildOnDrift=true', async () => {
    // Default getCodeDim()=768, getNlpDim()=384 → seed with 1024 to force drift.
    await seedTable(1024, 1024);
    expect(await listTables()).toContain('function_cards');

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (msg) => logs.push(msg), true);
    await store.init();

    expect(await listTables()).not.toContain('function_cards');
    expect(logs.some((m) => m.includes('drift detected') && m.includes('auto-rebuilding'))).toBe(true);
    expect(store.wasTableReset()).toBe(true);
  });

  it('preserves the table when rebuildOnDrift=false (warn-only legacy behavior)', async () => {
    await seedTable(1024, 1024);

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (msg) => logs.push(msg), false);
    await store.init();

    expect(await listTables()).toContain('function_cards');
    expect(logs.some((m) => m.includes('drift detected') && m.includes("'anatoly run --rebuild-rag'"))).toBe(true);
  });

  it('preserves the table when no drift (dims match active model)', async () => {
    // 768/384 are the defaults from MODEL_REGISTRY for the lite tier.
    await seedTable(768, 384);

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (msg) => logs.push(msg), true);
    await store.init();

    expect(await listTables()).toContain('function_cards');
    expect(logs.some((m) => m.includes('drift detected'))).toBe(false);
  });

  it('defaults rebuildOnDrift to false when constructor arg is omitted', async () => {
    await seedTable(1024, 1024);

    const store = new VectorStore(dir);
    await store.init();

    // No opt-in → table preserved.
    expect(await listTables()).toContain('function_cards');
  });
});

// ---------------------------------------------------------------------------
// Schema drift handling — a column the write path emits is absent from an
// older table (the referencedImports regression). Integration tests against a
// real LanceDB store.
// ---------------------------------------------------------------------------

describe('VectorStore — schema drift (missing column)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vs-schema-'));
    dbPath = join(dir, '.anatoly', 'cache', 'rag', 'lancedb');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Seed an OLD-schema `function_cards` table: a function row WITHOUT the
   * `referencedImports` column (added after this row shape shipped), at the
   * default 768/384 dims so the ONLY drift is the missing column. When
   * `withColumn` is true, the current schema is seeded instead.
   */
  async function seedTable(withColumn: boolean): Promise<void> {
    mkdirSync(dbPath, { recursive: true });
    const db = await connect(dbPath);
    await db.createTable('function_cards', [{
      id: 'aaaaaaaaaaaaaaaa',
      filePath: 'src/foo.ts',
      name: 'foo',
      summary: '',
      docSummary: '',
      keyConcepts: '[]',
      signature: '',
      behavioralProfile: '',
      complexityScore: 0,
      calledInternals: '[]',
      ...(withColumn ? { referencedImports: '[]' } : {}),
      lastIndexed: '2024-01-01',
      vector: new Array(768).fill(0.1),
      nlp_vector: new Array(384).fill(0.2),
      doc_vector: new Array(384).fill(0),
      type: 'function',
      source: '',
    }]);
  }

  async function listTables(): Promise<string[]> {
    const db = await connect(dbPath);
    return db.tableNames();
  }

  it('drops the table when a required column is missing and rebuildOnDrift=true', async () => {
    await seedTable(false);
    expect(await listTables()).toContain('function_cards');

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (m) => logs.push(m), true);
    await store.init();

    expect(await listTables()).not.toContain('function_cards');
    expect(logs.some((m) => m.includes('schema drift detected') && m.includes('referencedImports') && m.includes('auto-rebuilding'))).toBe(true);
    // Signals the orchestrator to purge the stale index cache before re-indexing.
    expect(store.wasTableReset()).toBe(true);
  });

  it('warns and preserves the table when rebuildOnDrift=false', async () => {
    await seedTable(false);

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (m) => logs.push(m), false);
    await store.init();

    expect(await listTables()).toContain('function_cards');
    expect(logs.some((m) => m.includes('schema drift detected') && m.includes("'anatoly run --rebuild-rag'"))).toBe(true);
    expect(store.wasTableReset()).toBe(false);
  });

  it('does not flag schema drift when the column is present', async () => {
    await seedTable(true);

    const logs: string[] = [];
    const store = new VectorStore(dir, undefined, (m) => logs.push(m), true);
    await store.init();

    expect(await listTables()).toContain('function_cards');
    expect(logs.some((m) => m.includes('schema drift detected'))).toBe(false);
    expect(store.wasTableReset()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Declaration cards — non-function symbols (const/type/...) indexed so data-only
// files still get a per-file NLP vector for reference-doc routing, while staying
// out of code-similarity / duplication results. Integration against real LanceDB.
// ---------------------------------------------------------------------------

describe('VectorStore — declaration cards', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vs-decl-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const CODE_DIM = 768;
  const NLP_DIM = 384;

  function fnCard(id: string, filePath: string, name: string) {
    return {
      id, filePath, name, signature: `function ${name}()`,
      complexityScore: 1, calledInternals: [] as string[], referencedImports: [] as string[],
      kind: 'function' as const, lastIndexed: '2026-02-24T00:00:00.000Z',
    };
  }

  function declCard(id: string, filePath: string, name: string) {
    return {
      id, filePath, name, signature: `const ${name} = 6`,
      summary: `Constant ${name}. const ${name} = 6`, keyConcepts: [name],
      complexityScore: 1, calledInternals: [] as string[], referencedImports: [] as string[],
      kind: 'declaration' as const, lastIndexed: '2026-02-24T00:00:00.000Z',
    };
  }

  it('persists kind via the type discriminator and includes declarations in the per-file NLP average', async () => {
    const store = new VectorStore(dir, undefined, () => {}, false);
    await store.init();

    // A data-only file: a single declaration card, no functions.
    const card = declCard('aaaaaaaaaaaaaaaa', 'src/timetable.ts', 'DWELL_TICKS');
    await store.upsert(
      [card],
      [new Array(CODE_DIM).fill(0.1)],
      { nlpEmbeddings: [new Array(NLP_DIM).fill(0.2)], docEmbeddings: [new Array(NLP_DIM).fill(0)] },
    );

    // getCardsByFile surfaces the declaration and round-trips its kind.
    const cards = await store.getCardsByFile('src/timetable.ts');
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('declaration');

    // The data-only file now yields a non-null per-file NLP vector — the fix.
    const avg = await store.getAverageNlpVectorByFile('src/timetable.ts');
    expect(avg).not.toBeNull();
    expect(avg!.some((x) => x !== 0)).toBe(true);
  });

  it('excludes declaration cards from code-similarity search (duplication path)', async () => {
    const store = new VectorStore(dir, undefined, () => {}, false);
    await store.init();

    await store.upsert(
      [fnCard('bbbbbbbbbbbbbbbb', 'src/a.ts', 'compute'), declCard('cccccccccccccccc', 'src/a.ts', 'LIMIT')],
      [new Array(CODE_DIM).fill(0.5), new Array(CODE_DIM).fill(0.5)],
      {
        nlpEmbeddings: [new Array(NLP_DIM).fill(0.5), new Array(NLP_DIM).fill(0.5)],
        docEmbeddings: [new Array(NLP_DIM).fill(0), new Array(NLP_DIM).fill(0)],
      },
    );

    // Query exactly matches both rows' code vector; only the function card returns.
    const results = await store.search(new Array(CODE_DIM).fill(0.5), 10, 0);
    expect(results.length).toBe(1);
    expect(results[0].card.name).toBe('compute');
    expect(results.some((r) => r.card.name === 'LIMIT')).toBe(false);
  });
});
