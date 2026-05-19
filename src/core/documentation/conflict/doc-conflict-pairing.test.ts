// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc 16 PR 2b — doc-conflict-pairing unit tests. Fully hermetic: the
 * vector store is a stub and the chunk cache is a temp JSON file (no real
 * embedding/LLM/store — the no-LLM/embeddings-in-tests rule).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dedupePairs,
  batchPairs,
  storePairMatcher,
  type CandidatePair,
  type DocSegment,
} from './doc-conflict-pairing.js';
import { loadDocSectionTexts } from '../../../rag/index.js';
import type { VectorStore } from '../../../rag/vector-store.js';

const seg = (filePath: string, heading: string, content = 'c'): DocSegment => ({
  filePath, heading, content, neighbor: '',
});

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'doc-pairing-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Write a doc chunk cache file under the temp project root. */
function writeChunkCache(suffix: string, cache: Record<string, { sha: string; sections: Array<{ heading: string; embedText: string; content: string }> }>): void {
  const dir = join(tmp, '.anatoly', 'cache', 'rag');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `doc_chunk_cache_${suffix}.json`), JSON.stringify(cache));
}

describe('dedupePairs', () => {
  it('keeps the best reference match per internal section, sorted, capped', () => {
    const a = seg('R.md', 'A'), b = seg('R.md', 'B');
    const x = seg('I.md', 'X'), y = seg('I.md', 'Y');
    const pairs: CandidatePair[] = [
      { ref: a, internal: x, score: 0.6 },
      { ref: b, internal: x, score: 0.9 }, // same internal X — higher wins
      { ref: a, internal: y, score: 0.7 },
    ];
    const out = dedupePairs(pairs);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBe(0.9);
    expect(out[0].internal.heading).toBe('X');
    expect(out[0].ref.heading).toBe('B');
    expect(dedupePairs(pairs, 1)).toHaveLength(1);
  });
});

describe('batchPairs', () => {
  it('splits into batches of at most the given size', () => {
    const p = seg('R', 'h');
    const pairs: CandidatePair[] = Array.from({ length: 23 }, () => ({ ref: p, internal: p, score: 1 }));
    expect(batchPairs(pairs, 10).map(b => b.length)).toEqual([10, 10, 3]);
  });
});

describe('loadDocSectionTexts', () => {
  it('maps `${filePath}#${heading}` to full content + in-file neighbour', () => {
    writeChunkCache('advanced-internal', {
      '.anatoly/state/internal-docs/m.md': {
        sha: 'h',
        sections: [
          { heading: 'Alpha', embedText: 'a', content: 'ALPHA body' },
          { heading: 'Beta', embedText: 'b', content: 'BETA body' },
          { heading: 'Gamma', embedText: 'g', content: 'GAMMA body' },
        ],
      },
    });
    const texts = loadDocSectionTexts(tmp);
    const beta = texts.get('.anatoly/state/internal-docs/m.md#Beta');
    expect(beta?.content).toBe('BETA body');
    expect(beta?.neighbor).toContain('ALPHA body');
    expect(beta?.neighbor).toContain('GAMMA body');
  });

  it('returns an empty map when no chunk cache exists', () => {
    expect(loadDocSectionTexts(tmp).size).toBe(0);
  });
});

describe('storePairMatcher', () => {
  function fakeStore(
    refRows: Array<{ filePath: string; name: string; nlpVector: number[] }>,
    hitsFor: (v: number[]) => Array<{ card: { filePath: string; name: string }; score: number }>,
  ): VectorStore {
    return {
      listDocSectionVectors: async (_s: 'internal' | 'project') => refRows,
      searchDocSections: async (v: number[]) => hitsFor(v),
    } as unknown as VectorStore;
  }

  it('builds pairs from store vectors + chunk-cache text (no embed, no re-chunk)', async () => {
    writeChunkCache('advanced', {
      'README.md': { sha: 'r', sections: [{ heading: 'RTP', embedText: 'e', content: '5% house edge against the player' }] },
    });
    writeChunkCache('advanced-internal', {
      '.anatoly/state/internal-docs/engine.md': {
        sha: 'i',
        sections: [
          { heading: 'Intro', embedText: 'e0', content: 'intro' },
          { heading: 'RTP', embedText: 'e1', content: 'multiplied by 1.05 in the player favour' },
        ],
      },
    });
    const store = fakeStore(
      [{ filePath: 'README.md', name: 'RTP', nlpVector: [1, 0] }],
      () => [{ card: { filePath: '.anatoly/state/internal-docs/engine.md', name: 'RTP' }, score: 0.88 }],
    );
    const pairs = await storePairMatcher(store, tmp)();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].ref.content).toBe('5% house edge against the player');
    expect(pairs[0].internal.content).toBe('multiplied by 1.05 in the player favour');
    expect(pairs[0].internal.neighbor).toContain('intro'); // H2 neighbour resolved
    expect(pairs[0].score).toBe(0.88);
  });

  it('skips a store hit whose passage is not in the chunk cache (no silent crash)', async () => {
    writeChunkCache('advanced', { 'README.md': { sha: 'r', sections: [{ heading: 'RTP', embedText: 'e', content: 'ref' }] } });
    const store = fakeStore(
      [{ filePath: 'README.md', name: 'RTP', nlpVector: [1, 0] }],
      () => [{ card: { filePath: 'ghost.md', name: 'Nope' }, score: 0.9 }],
    );
    expect(await storePairMatcher(store, tmp)()).toEqual([]);
  });

  it('returns [] when the store has no reference doc-sections', async () => {
    const store = fakeStore([], () => []);
    expect(await storePairMatcher(store, tmp)()).toEqual([]);
  });
});
