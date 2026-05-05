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
    dbPath = join(dir, '.anatoly', 'rag', 'lancedb');
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
