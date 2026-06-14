// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Invariants phase (NOT an axis — a pre-deliberation pipeline phase).
 *
 * Runs AFTER the review phase (axes done, reviews on disk) and BEFORE the
 * refinement/deliberation gate. It reads the reviews the axes already
 * produced, runs a cheap STRUCTURAL matcher (no LLM) to surface a small set
 * of suspect candidate PAIRS, hands only those to an adversarial LLM judge
 * (default = NO finding), and writes confirmed findings back onto the reviews
 * (`SymbolReview.invariant_findings`) so deliberation (tier 2 escalation) and
 * the report (applyInvariantFindingsToReviews fold) pick them up.
 *
 * Increment 1 carries exactly ONE invariant: INTER-REPRESENTATION
 * CONSISTENCY scoped to CODE-vs-CODE only — two code symbols that compute the
 * same named quantity but disagree in value or direction. Code-vs-doc is the
 * existing doc-16 doc-conflict pipeline's lane and is explicitly out of scope
 * here (the judge findings are also de-duped against doc-16 pending conflicts
 * so the two sources never self-contradict on the same anchor).
 *
 * FP-safety is paramount (this is a brand-new finding source): the matcher is
 * NARROW (RAG-gated, high cosine floor, requires a divergent numeric/sign
 * literal, capped + deduped), and the judge defaults HARD to "no finding"
 * unless the two passages genuinely contradict on the same quantity. When RAG
 * is off / there is no vector store, the matcher yields zero candidates and
 * the phase is a no-op (accepted).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getLogger } from '../../../utils/logger.js';
import { loadReviews } from '../../reporting/index.js';
import { writeReviewOutput } from '../../reporting/index.js';
import { getEffectiveSourceRoot } from '../../worktree/index.js';
import { resolveAxisCache, writeProjectReviewAtHash } from '../../run/index.js';
import { buildFunctionId } from '../../../rag/index.js';
import { computeContentHash } from '../../../utils/cache.js';
import { runSingleTurnQuery } from '../../evaluation/index.js';
import { loadPendingConflictsAsDocConflicts } from '../../documentation/index.js';
import { recordLlmCost } from '../cost.js';
import type { ReviewFile, SymbolReview, InvariantFinding } from '../../../schemas/review.js';
import type { FunctionCard } from '../../../rag/index.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { RunContext } from '../../../commands/run.js';

// ---------------------------------------------------------------------------
// Tuning constants — all deliberately conservative (FP-safety paramount).
// ---------------------------------------------------------------------------

/**
 * Pseudo-axis id under which this phase records its per-file freshness key in
 * the (open string-map) review index. NOT a real axis (SymbolFindingSchema's
 * enum is closed); the cache layer keys by arbitrary axis-id strings.
 */
const INVARIANTS_PSEUDO_AXIS = 'invariants';

/**
 * The structural-matcher + judge contract, versioned inline. Folded into the
 * per-file cache prompt-hash so a change here invalidates stale invariant
 * caches (mirrors how an axis system-prompt hash gates reuse).
 */
const INVARIANT_RULESET =
  'inter_representation/v1: two code symbols compute the SAME named quantity ' +
  'but disagree in value or direction; candidate requires a high code+nlp ' +
  'cosine match AND a divergent numeric/sign literal in the two bodies; the ' +
  'judge confirms ONLY a genuine same-quantity contradiction, else no finding.';

/** Hybrid-search cosine floor — high so only strong same-concept neighbours pass. */
const MIN_HYBRID_SCORE = 0.82;
/** Hard cap on candidate pairs handed to the judge in one run (defends prompt size + cost). */
const MAX_CANDIDATES = 10;
/** Judge batch size (mirrors doc-16 batchPairs / doc 16 §7 dec. 2). */
const JUDGE_BATCH_SIZE = 10;
/** Drop any judge finding below this confidence (FP-safety floor). */
const MIN_CONFIDENCE = 70;

// ---------------------------------------------------------------------------
// Candidate pair (code-vs-code)
// ---------------------------------------------------------------------------

/** A reviewed symbol paired with its source slice + RAG card, ready to judge. */
interface CodeSide {
  file: string;
  symbol: string;
  line_start: number;
  line_end: number;
  /** Source slice of the symbol body (best-effort; empty when unreadable). */
  body: string;
  signature: string;
}

/** A suspect code-vs-code pair (same quantity, divergent literal). */
interface CandidatePair {
  a: CodeSide;
  b: CodeSide;
  score: number;
}

// ---------------------------------------------------------------------------
// Judge response schema (default-to-no-finding)
// ---------------------------------------------------------------------------

/**
 * The judge returns a (possibly empty) `findings` array. EMPTY is the default
 * and correct answer for any batch whose pairs do not genuinely contradict —
 * the system prompt makes that explicit. Each entry anchors one side of a pair
 * with the contradicting counterpart.
 */
const JudgeResponseSchema = z.object({
  findings: z.array(z.object({
    file: z.string(),
    symbol: z.string(),
    line_start: z.int().min(1),
    line_end: z.int().min(1),
    confidence: z.int().min(0).max(100),
    detail: z.string().min(10),
    counterpart: z.object({
      file: z.string(),
      symbol: z.string(),
    }),
  })).default([]),
});

type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

const JUDGE_SYSTEM_PROMPT =
  'You are an adversarial reviewer checking INTER-REPRESENTATION CONSISTENCY ' +
  'between TWO code symbols. Each candidate pair was flagged by a structural ' +
  'pre-filter because the two symbols look like they compute the SAME named ' +
  'quantity yet contain a differing numeric or sign literal.\n\n' +
  'Confirm a finding ONLY when BOTH hold:\n' +
  '1. The two symbols genuinely compute the SAME named quantity (same domain ' +
  'concept / return meaning), not merely similar-looking code.\n' +
  '2. They DISAGREE in value or direction (a different constant, a flipped ' +
  'sign, an inverted comparison) such that one of them is wrong relative to ' +
  'the other.\n\n' +
  'DEFAULT TO NO FINDING. If you are not certain both hold — if the symbols ' +
  'compute different quantities, if the literals legitimately differ by ' +
  'design, if you cannot tell — return an EMPTY findings array. A false ' +
  'positive here is far worse than a miss. Do NOT invent contradictions, do ' +
  'NOT compare code against documentation (out of scope), and only report a ' +
  'symbol that appears in the candidate pairs given.';

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export async function runInvariantsPhase(
  ctx: RunContext,
  _handoff: Handoff,
  ragContext: RagContext,
): Promise<void> {
  const log = getLogger();

  // (a) Disabled ⇒ no-op. The flag is resolved onto RunContext from
  // --invariants / config.invariants.enabled (default false).
  if (!ctx.invariants) return;

  // RAG is the matcher's only candidate source. No store / RAG off ⇒ zero
  // candidates ⇒ no-op (accepted by design — increment 1 is RAG-only).
  const vectorStore = ragContext.vectorStore;
  if (!ragContext.ragEnabled || !vectorStore) {
    ctx.pipelineState?.completeTask('invariants', 'skipped (rag inactive)');
    return;
  }

  // (b) Reviews the axes already produced this run.
  const reviews = loadReviews(ctx.projectRoot, ctx.runDir);
  if (reviews.length === 0) {
    ctx.pipelineState?.completeTask('invariants', 'no reviews');
    return;
  }

  ctx.pipelineState?.startTask('invariants', '…');

  // (c) Per-file invariants cache key. The ruleset + judge model drive the
  // prompt-hash; a fresh 'invariants' key means the judge already ran on this
  // exact content under this exact ruleset, so we skip re-judging it (its
  // already-folded findings persist on the cached blob, copied into runDir by
  // the review phase). prompt_hash = sha256(ruleset + '\n' + judgeModel).
  const judgeModel = ctx.config.models.quality;
  const invariantsPromptHash =
    'sha256:' + createHash('sha256').update(`${INVARIANT_RULESET}\n${judgeModel}`).digest('hex');
  const axisPromptHashes: Record<string, string> = { [INVARIANTS_PSEUDO_AXIS]: invariantsPromptHash };
  const axisModelIds: Record<string, string> = { [INVARIANTS_PSEUDO_AXIS]: judgeModel };

  const sourceRootEff = getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot);

  // Build a lookup of reviewed symbols and decide which files still need
  // judging (stale 'invariants' key). Skip-cached files keep whatever
  // invariant findings they already carry — no work, no change.
  const reviewByFile = new Map<string, ReviewFile>();
  const fileContent = new Map<string, string | null>();
  const fileFresh = new Map<string, boolean>(); // file -> invariants key fresh?
  for (const r of reviews) {
    reviewByFile.set(r.file, r);
    let content: string | null = null;
    try { content = readFileSync(resolve(sourceRootEff, r.file), 'utf-8'); } catch { /* unreadable */ }
    fileContent.set(r.file, content);
    if (content === null || ctx.noCache) {
      fileFresh.set(r.file, false);
      continue;
    }
    const res = resolveAxisCache(
      ctx.projectRoot, r.file, content, [INVARIANTS_PSEUDO_AXIS], axisPromptHashes, axisModelIds,
    );
    fileFresh.set(r.file, res.staleAxes.length === 0);
  }

  // (d) STRUCTURAL MATCHER (no LLM): surface code-vs-code candidate pairs.
  const candidates = await buildCandidates({
    reviews,
    reviewByFile,
    fileContent,
    fileFresh,
    vectorStore,
    codeWeight: ctx.config.rag.code_weight,
  });

  if (candidates.length === 0) {
    ctx.pipelineState?.completeTask('invariants', 'clean');
    log.info('invariants: no candidate pairs surfaced — phase clean');
    return;
  }

  // (e) JUDGE — adversarial, default-to-no-finding, in small batches.
  const judged: Array<{ file: string; symbol: string; finding: InvariantFinding }> = [];
  const conversationDir = undefined; // single-turn dumps optional; omit for this internal phase
  let aborted = false;
  for (const batch of batchCandidates(candidates, JUDGE_BATCH_SIZE)) {
    if (ctx.interrupted) { aborted = true; break; }
    const abortController = new AbortController();
    ctx.activeAborts.add(abortController);
    try {
      const userMessage = buildJudgeUserMessage(batch);
      const result = await runSingleTurnQuery<JudgeResponse>(
        {
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          userMessage,
          model: judgeModel,
          projectRoot: ctx.projectRoot,
          abortController,
          conversationDir,
          router: ctx.router,
          composer: 'phases.invariants',
          primitive: 'phases.invariants',
          timeoutMs: ctx.config.runtime.timeout_per_call * 1000,
        },
        JudgeResponseSchema,
      );
      // Cost rollup (same accounting seam doc-conflict uses).
      recordLlmCost(ctx, {
        provider: 'anthropic',
        phase: 'invariants',
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        calls: 1,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
      });

      const validPairs = new Set(batch.flatMap((p) => [pairKey(p.a), pairKey(p.b)]));
      for (const f of result.data.findings) {
        if (f.confidence < MIN_CONFIDENCE) continue; // FP-safety floor
        // The judge may only flag a side that was actually in the batch.
        if (!validPairs.has(`${f.file}::${f.symbol}`)) continue;
        judged.push({
          file: f.file,
          symbol: f.symbol,
          finding: {
            invariant: 'inter_representation',
            line_start: f.line_start,
            line_end: f.line_end,
            detail: f.detail,
            confidence: f.confidence,
            counterpart: { file: f.counterpart.file, symbol: f.counterpart.symbol },
          },
        });
      }
    } catch (err) {
      // A judge failure is non-fatal: this is an additive, opt-in finding
      // source. Log and continue (never crash the run for an invariant).
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'invariants: judge batch failed — skipping batch');
    } finally {
      ctx.activeAborts.delete(abortController);
    }
  }

  // (f) DE-DUP vs doc-16: drop any judged finding whose (file,symbol) already
  // has a doc-conflict pending entry, so the invariants phase and the doc-16
  // doc-conflict pipeline never both flag the same anchor (self-contradiction
  // / double-count). doc-16 owns code-vs-doc; we own code-vs-code.
  const docConflictAnchors = new Set<string>();
  try {
    for (const c of loadPendingConflictsAsDocConflicts(ctx.projectRoot)) {
      if (c.symbol) docConflictAnchors.add(`${c.file}::${c.symbol}`);
    }
  } catch { /* no store / unreadable — nothing to dedupe against */ }

  // (g) Write confirmed findings onto the matching SymbolReview and persist.
  const touchedFiles = new Set<string>();
  let written = 0;
  for (const j of judged) {
    if (docConflictAnchors.has(`${j.file}::${j.symbol}`)) continue; // doc-16 owns it
    const rf = reviewByFile.get(j.file);
    if (!rf) continue;
    const sym = rf.symbols.find((s) => s.name === j.symbol);
    if (!sym) continue;
    // One inter-representation pair per symbol in increment 1; first wins.
    if (sym.invariant_findings && sym.invariant_findings.length > 0) continue;
    sym.invariant_findings = [j.finding];
    touchedFiles.add(j.file);
    written++;
  }

  // Persist every file we judged this run (whether or not it produced a
  // finding): touched files get the new findings written back, and ALL judged
  // files get a fresh 'invariants' cache key so a re-run skips re-judging
  // unchanged content. (Files skipped as fresh keep their existing key.)
  for (const r of reviews) {
    const content = fileContent.get(r.file);
    if (content === null || content === undefined) continue; // unreadable — cannot key
    if (fileFresh.get(r.file)) continue; // already fresh — judged this content before
    const rf = reviewByFile.get(r.file)!;
    if (touchedFiles.has(r.file)) {
      writeReviewOutput(ctx.projectRoot, rf, ctx.runDir);
    }
    if (!ctx.noCache) {
      try {
        writeProjectReviewAtHash(
          ctx.projectRoot, rf, computeContentHash(content),
          { [INVARIANTS_PSEUDO_AXIS]: { prompt_hash: invariantsPromptHash, model_id: judgeModel } },
          [INVARIANTS_PSEUDO_AXIS],
        );
      } catch (err) {
        log.debug({ file: r.file, err }, 'invariants: failed to write cache key (non-fatal)');
      }
    }
  }

  const detail = aborted ? `${written} findings (interrupted)` : (written > 0 ? `${written} findings` : 'clean');
  ctx.pipelineState?.completeTask('invariants', detail);
  log.info({ candidates: candidates.length, confirmed: written }, 'invariants phase complete');
}

// ---------------------------------------------------------------------------
// Structural matcher (no LLM)
// ---------------------------------------------------------------------------

const pairKey = (s: { file: string; symbol: string }): string => `${s.file}::${s.symbol}`;

/**
 * Surface a small set of suspect CODE-vs-CODE pairs. For each reviewed symbol
 * that has a RAG FunctionCard, query the store for its nearest code+nlp
 * neighbour above a HIGH cosine floor; keep the pair only when BOTH sides
 * carry a divergent numeric/sign literal (cheap regex over the body slices) —
 * the "same quantity, different value/direction" structural signal. Dedupe per
 * unordered symbol pair, cap at {@link MAX_CANDIDATES}. Never throws: any
 * failure yields fewer (or zero) candidates, never a crashed run.
 */
async function buildCandidates(args: {
  reviews: ReviewFile[];
  reviewByFile: Map<string, ReviewFile>;
  fileContent: Map<string, string | null>;
  fileFresh: Map<string, boolean>;
  vectorStore: NonNullable<RagContext['vectorStore']>;
  codeWeight: number;
}): Promise<CandidatePair[]> {
  const { reviews, reviewByFile, fileContent, fileFresh, vectorStore, codeWeight } = args;
  const log = getLogger();
  const out: CandidatePair[] = [];
  const seen = new Set<string>(); // unordered pair keys already added

  // Per-file card index, lazily fetched + memoised.
  const cardsByFile = new Map<string, FunctionCard[]>();
  const cardsFor = async (file: string): Promise<FunctionCard[]> => {
    const hit = cardsByFile.get(file);
    if (hit) return hit;
    let cards: FunctionCard[] = [];
    try { cards = await vectorStore.getCardsByFile(file); } catch { cards = []; }
    cardsByFile.set(file, cards);
    return cards;
  };

  const sideFor = (file: string, sym: SymbolReview, card: FunctionCard | undefined): CodeSide => ({
    file,
    symbol: sym.name,
    line_start: sym.line_start,
    line_end: sym.line_end,
    body: sliceBody(fileContent.get(file) ?? null, sym.line_start, sym.line_end),
    signature: card?.signature ?? '',
  });

  outer:
  for (const review of reviews) {
    // Only judge files whose invariants key is stale (skip fresh-cached ones).
    if (fileFresh.get(review.file)) continue;
    const cards = await cardsFor(review.file);
    if (cards.length === 0) continue;
    const cardByName = new Map(cards.map((c) => [c.name, c] as const));

    for (const sym of review.symbols) {
      if (out.length >= MAX_CANDIDATES) break outer;
      // Only functions/methods carry the "compute a quantity" shape we match.
      if (sym.kind !== 'function' && sym.kind !== 'method') continue;
      const card = cardByName.get(sym.name);
      if (!card) continue;

      const aContent = fileContent.get(review.file) ?? null;
      const aBody = sliceBody(aContent, sym.line_start, sym.line_end);
      const aLiterals = extractLiterals(aBody);
      if (aLiterals.size === 0) continue; // no numeric/sign literal ⇒ nothing to disagree on

      const functionId = buildFunctionId(review.file, sym.line_start, sym.line_end);
      let neighbours;
      try {
        neighbours = await vectorStore.searchByIdHybrid(functionId, codeWeight, 5, MIN_HYBRID_SCORE);
      } catch { continue; }

      for (const n of neighbours) {
        if (out.length >= MAX_CANDIDATES) break outer;
        const otherFile = n.card.filePath;
        const otherReview = reviewByFile.get(otherFile);
        if (!otherReview) continue; // counterpart must be a reviewed symbol
        const otherSym = otherReview.symbols.find((s) => s.name === n.card.name);
        if (!otherSym) continue;
        if (otherSym.kind !== 'function' && otherSym.kind !== 'method') continue;
        // Skip self.
        if (otherFile === review.file && otherSym.name === sym.name) continue;

        const bBody = sliceBody(fileContent.get(otherFile) ?? null, otherSym.line_start, otherSym.line_end);
        const bLiterals = extractLiterals(bBody);
        if (bLiterals.size === 0) continue;

        // Divergence signal: the two bodies must carry DIFFERING literals (a
        // different constant or a flipped sign) — same literals ⇒ no value
        // disagreement to investigate, drop it (precision over recall).
        if (!literalsDiverge(aLiterals, bLiterals)) continue;

        const key = unorderedKey(review.file, sym.name, otherFile, otherSym.name);
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          a: sideFor(review.file, sym, card),
          b: sideFor(otherFile, otherSym, n.card),
          score: n.score,
        });
      }
    }
  }

  log.info({ candidates: out.length }, 'invariants: structural matcher surfaced candidate pairs');
  // Strongest matches first; the cap already bounds the set.
  return out.sort((x, y) => y.score - x.score).slice(0, MAX_CANDIDATES);
}

/** Unordered key for a symbol pair so (A,B) and (B,A) collapse to one. */
function unorderedKey(fa: string, sa: string, fb: string, sb: string): string {
  const a = `${fa}::${sa}`;
  const b = `${fb}::${sb}`;
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

/** Best-effort source slice of [lineStart, lineEnd] (1-based, inclusive). */
function sliceBody(content: string | null, lineStart: number, lineEnd: number): string {
  if (!content) return '';
  const lines = content.split('\n');
  if (lineStart < 1 || lineStart > lines.length) return '';
  return lines.slice(lineStart - 1, Math.min(lineEnd, lines.length)).join('\n');
}

/**
 * Extract numeric / sign literals from a code body as normalised tokens. We
 * capture signed numbers (incl. decimals and percents written as `0.05`) and
 * the comparison/sign operators that carry direction (`<`, `>`, `<=`, `>=`,
 * unary `-`). This is intentionally crude — it is only a CHEAP pre-filter to
 * decide whether a pair is worth a judge call, never a verdict.
 */
function extractLiterals(body: string): Set<string> {
  const out = new Set<string>();
  if (!body) return out;
  // Strip line comments to avoid matching numbers in prose.
  const code = body.replace(/\/\/[^\n]*/g, '');
  const numRe = /-?\b\d+(?:\.\d+)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(code)) !== null) {
    // Ignore the trivial 0/1 array-index / loop noise that rarely encodes a
    // domain quantity and would generate spurious "divergence".
    const v = m[0];
    if (v === '0' || v === '1') continue;
    out.add(v);
  }
  return out;
}

/**
 * The two literal sets "diverge" when each contains at least one value the
 * other does not — i.e. the bodies are not literal-identical and at least one
 * side carries a constant the other lacks. (Pure subset / equality ⇒ no
 * value/direction disagreement worth a judge call.)
 */
function literalsDiverge(a: Set<string>, b: Set<string>): boolean {
  let aHasUnique = false;
  let bHasUnique = false;
  for (const x of a) if (!b.has(x)) { aHasUnique = true; break; }
  for (const x of b) if (!a.has(x)) { bHasUnique = true; break; }
  return aHasUnique && bHasUnique;
}

// ---------------------------------------------------------------------------
// Judge batching + prompt
// ---------------------------------------------------------------------------

/** Split candidate pairs into batches of at most `size` (mirrors batchPairs). */
function batchCandidates(pairs: CandidatePair[], size = JUDGE_BATCH_SIZE): CandidatePair[][] {
  const out: CandidatePair[][] = [];
  for (let i = 0; i < pairs.length; i += size) out.push(pairs.slice(i, i + size));
  return out;
}

/** Render one batch of candidate pairs into the judge user message. */
function buildJudgeUserMessage(batch: CandidatePair[]): string {
  const parts: string[] = [];
  parts.push(
    'Below are candidate pairs of TWO code symbols flagged as possibly ' +
    'computing the same named quantity with disagreeing literals. For each ' +
    'pair, decide whether they GENUINELY contradict on the same quantity ' +
    '(value or direction). Default to NO finding. Return findings ONLY for ' +
    'confirmed contradictions, anchored to the symbol(s) listed.\n',
  );
  batch.forEach((p, i) => {
    parts.push(`\n### Pair ${i + 1} (cosine ${p.score.toFixed(3)})`);
    parts.push(renderSide('A', p.a));
    parts.push(renderSide('B', p.b));
  });
  return parts.join('\n');
}

function renderSide(label: string, s: CodeSide): string {
  const lines: string[] = [];
  lines.push(`- Side ${label}: \`${s.symbol}\` in \`${s.file}\` (L${s.line_start}–L${s.line_end})`);
  if (s.signature) lines.push(`  signature: ${s.signature}`);
  lines.push('  ```');
  lines.push(s.body || '(source unavailable)');
  lines.push('  ```');
  return lines.join('\n');
}
