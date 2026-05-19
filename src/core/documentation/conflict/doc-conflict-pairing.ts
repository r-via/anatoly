// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * doc-conflict-pairing — doc 16 PR 2b
 *
 * Cosine-matched inter-doc pairing. Instead of sending the whole reference
 * and internal corpora to one LLM call (the monolithic shape that always
 * timed out at `DETECTION_TIMEOUT_MS`, see doc 16 §6), this:
 *
 *   1. segments both sides by H2/H3 (reuses `smartChunkDoc`),
 *   2. finds, for each reference section, the nearest internal section(s)
 *      by NLP cosine similarity (a small set of suspect pairs),
 *   3. dedupes and expands each side to its H2 neighbour for context,
 *
 * so the LLM only ever verifies a handful of matched passage pairs. The
 * matcher is injectable (DI): default reuses the already-populated RAG
 * vector store; an in-memory variant embeds both sides when no store is
 * available; tests inject a deterministic stub so no real embedding or
 * LLM call happens (the no-LLM/embeddings-in-tests rule).
 */

import { getLogger } from '../../../utils/logger.js';
import { smartChunkDoc } from '../../../rag/doc-indexer.js';
import type { VectorStore } from '../../../rag/vector-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One H2/H3 segment of a doc, with its in-file neighbours precomputed. */
export interface DocSegment {
  /** Doc-relative path (reference doc path, or internal fragment relPath). */
  filePath: string;
  /** Section heading (H2, or "H2 — H3"). */
  heading: string;
  /** Full section markdown (what the LLM reads). */
  content: string;
  /** Prose-only text (what is embedded for similarity). */
  embedText: string;
  /** Adjacent same-file section content, joined for context (may be empty). */
  neighbor: string;
}

/** A reference section matched to an internal section by similarity. */
export interface CandidatePair {
  ref: DocSegment;
  internal: DocSegment;
  /** Cosine similarity in [0,1]. */
  score: number;
}

/**
 * Find candidate pairs given the segmented reference and internal sides.
 * Implementations must not throw: on any failure they return `[]` and the
 * caller treats it as "no new conflicts" (never crash the run).
 */
export type DocPairMatcher = (
  reference: DocSegment[],
  internal: DocSegment[],
) => Promise<CandidatePair[]>;

/** Default similarity floor — mirrors the prior art in per-file-doc-retrieval. */
export const DEFAULT_MIN_SCORE = 0.5;
/** Nearest internal sections considered per reference section. */
export const DEFAULT_TOP_K = 3;
/** Hard cap on pairs sent to the LLM in one run (defends prompt size). */
export const MAX_PAIRS = 60;

// ---------------------------------------------------------------------------
// Segmentation (smartChunkDoc reuse, with neighbour precompute)
// ---------------------------------------------------------------------------

/**
 * Segment a set of docs into {@link DocSegment}s. Each doc is chunked by
 * `smartChunkDoc` (H2/H3 split, same-paragraph accumulation, neighbour
 * merge, sub-50-char discard); the adjacent section in the same file is
 * stored as `neighbor` for later context expansion. A doc that yields no
 * section (tiny / all non-prose) contributes a single whole-doc segment so
 * no input is silently dropped (the D2 failure mode).
 */
export function segmentDocs(docs: Array<{ path: string; content: string }>): DocSegment[] {
  const out: DocSegment[] = [];
  for (const doc of docs) {
    const sections = smartChunkDoc(doc.path, doc.content);
    if (sections.length === 0) {
      const text = doc.content.trim();
      if (text.length === 0) continue;
      out.push({ filePath: doc.path, heading: '(whole document)', content: text, embedText: text, neighbor: '' });
      continue;
    }
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const before = i > 0 ? sections[i - 1].content : '';
      const after = i < sections.length - 1 ? sections[i + 1].content : '';
      out.push({
        filePath: doc.path,
        heading: s.heading,
        content: s.content,
        embedText: s.embedText,
        neighbor: [before, after].filter(Boolean).join('\n\n'),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cosine
// ---------------------------------------------------------------------------

/** Cosine similarity of two equal-length vectors; 0 on degenerate input. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Dedupe + neighbour expansion
// ---------------------------------------------------------------------------

const segKey = (s: DocSegment): string => `${s.filePath}#${s.heading}`;

/**
 * Keep at most one pair per internal section (the highest-scoring reference
 * match), drop exact duplicates, sort by descending score, cap at
 * {@link MAX_PAIRS}. This is the "dedupe segments of the same paragraph"
 * step: an internal section matched by several reference sections collapses
 * to its single best match.
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
// Matchers (real-run only — they embed; tests inject a stub)
// ---------------------------------------------------------------------------

/**
 * Vector-store matcher: embeds each (small) reference section and queries
 * the already-populated store for the nearest `internal` doc sections, then
 * joins the hit back to the locally-segmented internal section (by
 * filePath+heading) so the LLM gets the real section content and neighbour.
 * The internal side is never re-embedded (the store already has it).
 */
export function vectorStorePairMatcher(
  vectorStore: VectorStore,
  embedBatch: (texts: string[]) => Promise<number[][]>,
  opts: { topK?: number; minScore?: number } = {},
): DocPairMatcher {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  return async (reference, internal) => {
    const log = getLogger();
    if (reference.length === 0 || internal.length === 0) return [];
    const byKey = new Map(internal.map((s) => [segKey(s), s]));
    try {
      const embs = await embedBatch(reference.map((r) => r.embedText));
      const pairs: CandidatePair[] = [];
      for (let i = 0; i < reference.length; i++) {
        const hits = await vectorStore.searchDocSections(embs[i], topK, minScore, 'internal');
        for (const h of hits) {
          const local = byKey.get(`${h.card.filePath}#${h.card.name}`);
          if (!local) continue; // store hit we cannot anchor to a local section — skip (not silent: counted below)
          pairs.push({ ref: reference[i], internal: local, score: h.score });
        }
      }
      log.info({ reference: reference.length, internal: internal.length, pairs: pairs.length },
        'doc-conflict-pairing: vector-store matcher');
      return pairs;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'doc-conflict-pairing: vector-store matcher failed — no pairs');
      return [];
    }
  };
}

/**
 * In-memory matcher: embeds both sides and cosine-pairs them. Used when no
 * vector store is available (RAG off) so detection keeps its value. Costs a
 * real embedding call — never reached in tests (a stub is injected).
 */
export function inMemoryPairMatcher(
  embedBatch: (texts: string[]) => Promise<number[][]>,
  opts: { topK?: number; minScore?: number } = {},
): DocPairMatcher {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  return async (reference, internal) => {
    const log = getLogger();
    if (reference.length === 0 || internal.length === 0) return [];
    try {
      const refEmb = await embedBatch(reference.map((r) => r.embedText));
      const intEmb = await embedBatch(internal.map((s) => s.embedText));
      const pairs: CandidatePair[] = [];
      for (let i = 0; i < reference.length; i++) {
        const scored = internal
          .map((s, j) => ({ s, score: cosine(refEmb[i], intEmb[j]) }))
          .filter((x) => x.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        for (const m of scored) pairs.push({ ref: reference[i], internal: m.s, score: m.score });
      }
      log.info({ reference: reference.length, internal: internal.length, pairs: pairs.length },
        'doc-conflict-pairing: in-memory matcher');
      return pairs;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'doc-conflict-pairing: in-memory matcher failed — no pairs');
      return [];
    }
  };
}
