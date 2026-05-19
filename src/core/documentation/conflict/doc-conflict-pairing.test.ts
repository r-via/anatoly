// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc 16 PR 2b — doc-conflict-pairing unit tests. Fully hermetic: the
 * matchers' embedding function is injected (no real embedding call), and
 * the vector store is a stub (the no-LLM/embeddings-in-tests rule).
 */

import { describe, it, expect } from 'vitest';
import {
  segmentDocs,
  cosine,
  dedupePairs,
  batchPairs,
  vectorStorePairMatcher,
  inMemoryPairMatcher,
  type CandidatePair,
  type DocSegment,
} from './doc-conflict-pairing.js';

const seg = (filePath: string, heading: string, content: string): DocSegment => ({
  filePath, heading, content, embedText: content, neighbor: '',
});

describe('segmentDocs', () => {
  it('splits by H2 and precomputes the in-file neighbour', () => {
    const md = '# Title\n\n## Alpha\n\nThe alpha section explains the first concept in enough words to pass the prose floor.\n\n## Beta\n\nThe beta section explains the second concept in enough words to pass the prose floor.\n';
    const segs = segmentDocs([{ path: 'README.md', content: md }]);
    const headings = segs.map(s => s.heading);
    expect(headings).toContain('Alpha');
    expect(headings).toContain('Beta');
    const alpha = segs.find(s => s.heading === 'Alpha')!;
    expect(alpha.neighbor).toContain('beta section');
  });

  it('falls back to a whole-document segment when nothing chunks (no silent drop)', () => {
    const segs = segmentDocs([{ path: 'x.md', content: '# H1 only\n\ntiny' }]);
    expect(segs).toHaveLength(1);
    expect(segs[0].heading).toBe('(whole document)');
    expect(segs[0].content).toContain('tiny');
  });

  it('skips an empty document', () => {
    expect(segmentDocs([{ path: 'e.md', content: '   \n' }])).toEqual([]);
  });
});

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, 0 for degenerate', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('dedupePairs', () => {
  it('keeps the best reference match per internal section, sorted, capped', () => {
    const a = seg('R.md', 'A', 'a'), b = seg('R.md', 'B', 'b');
    const x = seg('I.md', 'X', 'x'), y = seg('I.md', 'Y', 'y');
    const pairs: CandidatePair[] = [
      { ref: a, internal: x, score: 0.6 },
      { ref: b, internal: x, score: 0.9 }, // same internal X — higher wins
      { ref: a, internal: y, score: 0.7 },
    ];
    const out = dedupePairs(pairs);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBe(0.9); // sorted desc
    expect(out[0].internal.heading).toBe('X');
    expect(out[0].ref.heading).toBe('B');
    expect(dedupePairs(pairs, 1)).toHaveLength(1);
  });
});

describe('batchPairs', () => {
  it('splits into batches of at most the given size', () => {
    const p = seg('R', 'h', 'c');
    const pairs: CandidatePair[] = Array.from({ length: 23 }, () => ({ ref: p, internal: p, score: 1 }));
    const batches = batchPairs(pairs, 10);
    expect(batches.map(b => b.length)).toEqual([10, 10, 3]);
  });
});

describe('inMemoryPairMatcher (injected embed stub)', () => {
  it('pairs reference to the nearest internal by cosine over the threshold', async () => {
    // Deterministic 2-D embeddings: ref0 ~ int0, far from int1.
    const vecs: Record<string, number[]> = {
      'ref rtp': [1, 0],
      'int rtp': [0.99, 0.1],
      'int misc': [0, 1],
    };
    const embed = async (texts: string[]) => texts.map(t => vecs[t] ?? [0, 0]);
    const matcher = inMemoryPairMatcher(embed, { topK: 1, minScore: 0.5 });
    const pairs = await matcher(
      [seg('R.md', 'RTP', 'ref rtp')],
      [seg('I.md', 'RTP', 'int rtp'), seg('I.md', 'Misc', 'int misc')],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].internal.heading).toBe('RTP');
    expect(pairs[0].score).toBeGreaterThan(0.9);
  });

  it('returns [] when nothing clears the threshold', async () => {
    // ref text 'x' → [1,0], internal text 'y' → [0,1] (orthogonal, cosine 0).
    const embed = async (texts: string[]) => texts.map(t => (t === 'x' ? [1, 0] : [0, 1]));
    const matcher = inMemoryPairMatcher(embed, { minScore: 0.9 });
    expect(await matcher([seg('R', 'a', 'x')], [seg('I', 'b', 'y')])).toEqual([]);
  });
});

describe('vectorStorePairMatcher (stub store + injected embed)', () => {
  it('joins a store hit back to the local internal section by filePath+heading', async () => {
    const internal = seg('05-modules/engine.md', 'RTP', 'multiplied by 1.05 in the player favour');
    const fakeStore = {
      searchDocSections: async () => [
        { card: { filePath: '05-modules/engine.md', name: 'RTP' }, score: 0.88 },
      ],
    } as unknown as Parameters<typeof vectorStorePairMatcher>[0];
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const matcher = vectorStorePairMatcher(fakeStore, embed);
    const pairs = await matcher([seg('README.md', 'RTP', 'house edge 5% against the player')], [internal]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].internal).toBe(internal); // local section (full content), not the card
    expect(pairs[0].score).toBe(0.88);
  });

  it('drops a store hit that cannot be anchored to a local section', async () => {
    const fakeStore = {
      searchDocSections: async () => [{ card: { filePath: 'ghost.md', name: 'Nope' }, score: 0.9 }],
    } as unknown as Parameters<typeof vectorStorePairMatcher>[0];
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const matcher = vectorStorePairMatcher(fakeStore, embed);
    expect(await matcher([seg('R.md', 'A', 'a')], [seg('I.md', 'B', 'b')])).toEqual([]);
  });
});
