// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc-conflict-pairing — doc 16 PR 2b
 *
 * Cosine-matched inter-doc pairing, store-only. The monolithic
 * whole-corpus detection call always aborted at the 120s
 * `DETECTION_TIMEOUT_MS` (doc 16 §6). Instead this finds, for each stored
 * reference doc-section, the nearest internal doc-section(s) using the
 * vectors **already persisted in the RAG store** (no re-embedding, no
 * re-chunking), resolves the real full passage text from the doc chunk
 * cache (which already holds the untruncated `smartChunkDoc` content keyed
 * exactly as the store rows: `${filePath}#${heading}` == `${filePath}#${name}`),
 * dedupes, and hands only the suspect pairs to the LLM in small batches.
 *
 * The matcher is injected (DI): production uses {@link storePairMatcher};
 * tests inject a deterministic stub so no real embedding/LLM/store call
 * happens (the no-LLM/embeddings-in-tests rule).
 */

import { getLogger } from '../../../utils/logger.js';
import { loadDocSectionTexts } from '../../../rag/index.js';
import type { VectorStore } from '../../../rag/vector-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One doc section with its in-file neighbour, ready for LLM verification. */
export interface DocSegment {
  /** Doc path as stored (vector-store row filePath / chunk-cache key part). */
  filePath: string;
  /** Section heading (== stored row `name` == chunk-cache section heading). */
  heading: string;
  /** Full section markdown (from the chunk cache, untruncated). */
  content: string;
  /** Adjacent same-file section content, joined for context (may be empty). */
  neighbor: string;
}

/** A reference section matched to an internal section by vector similarity. */
export interface CandidatePair {
  ref: DocSegment;
  internal: DocSegment;
  /** Cosine similarity in [0,1]. */
  score: number;
}

/**
 * Produce candidate pairs. Implementations must not throw: on any failure
 * they return `[]` and the caller treats it as "no new conflicts" (never
 * crash the run).
 */
export type DocPairMatcher = () => Promise<CandidatePair[]>;

/** Default similarity floor — mirrors the prior art in per-file-doc-retrieval. */
export const DEFAULT_MIN_SCORE = 0.5;
/** Nearest internal sections considered per reference section. */
export const DEFAULT_TOP_K = 3;
/** Hard cap on pairs sent to the LLM in one run (defends prompt size). */
export const MAX_PAIRS = 60;

// ---------------------------------------------------------------------------
// Dedupe + batching
// ---------------------------------------------------------------------------

const segKey = (s: DocSegment): string => `${s.filePath}#${s.heading}`;

/**
 * Keep at most one pair per internal section (the highest-scoring reference
 * match), drop exact duplicates, sort by descending score, cap at
 * {@link MAX_PAIRS}. An internal section matched by several reference
 * sections collapses to its single best match.
 */
export function dedupePairs(pairs: CandidatePair[], cap: number = MAX_PAIRS): CandidatePair[] {
  const bestByInternal = new Map<string, CandidatePair>();
  for (const p of pairs) {
    const k = segKey(p.internal);
    const cur = bestByInternal.get(k);
    if (!cur || p.score > cur.score) bestByInternal.set(k, p);
  }
  return [...bestByInternal.values()].sort((x, y) => y.score - x.score).slice(0, cap);
}

/** Split pairs into batches of at most `size` (default 10, doc 16 §7 dec. 2). */
export function batchPairs(pairs: CandidatePair[], size = 10): CandidatePair[][] {
  const out: CandidatePair[][] = [];
  for (let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Store matcher (real run — reuses persisted vectors + chunk-cache text)
// ---------------------------------------------------------------------------

/**
 * For each stored reference doc-section, query the store for the nearest
 * internal doc-sections (cosine over the already-persisted NLP vectors),
 * then resolve the real full passage text + in-file neighbour for both
 * sides from the doc chunk cache by `${filePath}#${name}`. No embedding,
 * no re-chunking. A section whose text is not in the chunk cache is
 * skipped (rare: the cache is rebuilt alongside the store each run).
 */
export function storePairMatcher(
  vectorStore: VectorStore,
  projectRoot: string,
  opts: { topK?: number; minScore?: number } = {},
): DocPairMatcher {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  return async () => {
    const log = getLogger();
    try {
      const texts = loadDocSectionTexts(projectRoot);
      const refRows = await vectorStore.listDocSectionVectors('project');
      if (refRows.length === 0) {
        log.info('doc-conflict-pairing: no reference doc-sections in store — no pairs');
        return [];
      }
      const pairs: CandidatePair[] = [];
      let unresolvedRef = 0;
      let unresolvedInt = 0;
      for (const r of refRows) {
        const refText = texts.get(`${r.filePath}#${r.name}`);
        if (!refText) { unresolvedRef++; continue; }
        const hits = await vectorStore.searchDocSections(r.nlpVector, topK, minScore, 'internal');
        for (const h of hits) {
          const it = texts.get(`${h.card.filePath}#${h.card.name}`);
          if (!it) { unresolvedInt++; continue; }
          pairs.push({
            ref: { filePath: r.filePath, heading: r.name, content: refText.content, neighbor: refText.neighbor },
            internal: { filePath: h.card.filePath, heading: h.card.name, content: it.content, neighbor: it.neighbor },
            score: h.score,
          });
        }
      }
      log.info(
        { refRows: refRows.length, pairs: pairs.length, unresolvedRef, unresolvedInt },
        'doc-conflict-pairing: store matcher',
      );
      return pairs;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'doc-conflict-pairing: store matcher failed — no pairs',
      );
      return [];
    }
  };
}
