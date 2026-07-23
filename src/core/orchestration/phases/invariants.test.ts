// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyInvariantFindingsToReviews } from '../../reporting/doc-divergences.js';
import { applyTier2 } from '../../evaluation/refinement/tier2.js';
import { runInvariantsPhase } from './invariants.js';
import * as reporting from '../../reporting/index.js';
import * as runCache from '../../run/index.js';
import * as evaluation from '../../evaluation/index.js';
import * as documentation from '../../documentation/index.js';
import * as worktree from '../../worktree/index.js';
import type { ReviewFile, SymbolReview, InvariantFinding } from '../../../schemas/review.js';
import type { FunctionCard, SimilarityResult } from '../../../rag/index.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { RunContext } from '../../../commands/run.js';
import { RateLimitStandbyError } from '../../../utils/rate-limiter.js';

// ---------------------------------------------------------------------------
// Hermetic tests for the invariants phase consumer paths: the report fold
// (applyInvariantFindingsToReviews) and the deliberation read (tier2
// escalation). No real LLM calls — the judge seam is exercised in the
// detector-style tests; here we verify the two paths that read what the phase
// writes onto SymbolReview.invariant_findings. FP-safety (dedupe + opt-in) is
// the property under test.
// ---------------------------------------------------------------------------

function sym(overrides: Partial<SymbolReview> = {}): SymbolReview {
  return {
    name: 'computePayout',
    kind: 'function',
    exported: true,
    line_start: 10,
    line_end: 20,
    correction: 'OK',
    overengineering: '-',
    utility: 'USED',
    duplication: 'UNIQUE',
    tests: '-',
    documentation: '-',
    confidence: 90,
    detail: 'no issues found here',
    ...overrides,
  } as SymbolReview;
}

function invariantFinding(overrides: Partial<InvariantFinding> = {}): InvariantFinding {
  return {
    invariant: 'inter_representation',
    line_start: 10,
    line_end: 20,
    detail: 'two symbols compute payout but disagree on the 5% adjustment direction',
    confidence: 85,
    counterpart: { file: 'src/legacy.ts', symbol: 'computePayoutLegacy' },
    ...overrides,
  };
}

function review(file: string, symbols: SymbolReview[]): ReviewFile {
  return {
    version: 2,
    file,
    is_generated: false,
    verdict: 'NEEDS_REFACTOR',
    symbols,
    actions: [],
    file_level: {} as ReviewFile['file_level'],
  } as unknown as ReviewFile;
}

describe('applyInvariantFindingsToReviews (report fold)', () => {
  it('folds a confirmed invariant finding into correction=NEEDS_FIX when correction is OK', () => {
    const reviews = [review('src/engine.ts', [sym({ invariant_findings: [invariantFinding()] })])];
    const folded = applyInvariantFindingsToReviews(reviews);
    expect(folded).toBe(1);
    const s = reviews[0]!.symbols[0]!;
    expect(s.correction).toBe('NEEDS_FIX');
    expect(s.detail).toContain('Inter-representation inconsistency');
    expect(s.detail).toContain('computePayoutLegacy');
  });

  it('does NOT double-count a symbol the correction axis already flagged (dedupe safety-net)', () => {
    const reviews = [
      review('src/engine.ts', [
        sym({ correction: 'NEEDS_FIX', detail: 'pre-existing correction finding', invariant_findings: [invariantFinding()] }),
      ]),
    ];
    const folded = applyInvariantFindingsToReviews(reviews);
    expect(folded).toBe(0);
    // The original correction detail is preserved (not overwritten).
    expect(reviews[0]!.symbols[0]!.detail).toBe('pre-existing correction finding');
  });

  it('is a no-op when no symbol carries an invariant finding', () => {
    const reviews = [review('src/engine.ts', [sym()])];
    expect(applyInvariantFindingsToReviews(reviews)).toBe(0);
    expect(reviews[0]!.symbols[0]!.correction).toBe('OK');
  });

  it('uses the numerical-target preamble when folding a numerical_target finding', () => {
    const numeric = invariantFinding({
      invariant: 'numerical_target',
      detail: 'DIAMOND weight 30/120 implies RTP ~239%, not the documented 95%',
      counterpart: { file: 'src/engine.ts', symbol: 'computePayout' },
    });
    const reviews = [review('src/reels.ts', [sym({ name: 'DEFAULT_WEIGHTS', kind: 'constant', invariant_findings: [numeric] })])];
    const folded = applyInvariantFindingsToReviews(reviews);
    expect(folded).toBe(1);
    const s = reviews[0]!.symbols[0]!;
    expect(s.correction).toBe('NEEDS_FIX');
    expect(s.detail).toContain('Numerical-target inconsistency');
    expect(s.detail).not.toContain('Inter-representation');
    expect(s.detail).toContain('computePayout');
    expect(s.detail).toContain('239%');
  });
});

describe('applyTier2 (invariant findings are NOT escalated to tier 3)', () => {
  // Tier 3 only reclassifies the six real axes and prunes `sym.findings`; it has
  // no path to clear `sym.invariant_findings`. Escalating an invariant finding
  // would burn a tier-3 call with no ability to overturn it (a false safety
  // layer), so tier 2 must NOT escalate on an `invariants` axis. The phase's own
  // adversarial judge is the precision gate.
  it('does not escalate a symbol whose only flag is an invariant finding (correction still OK)', async () => {
    const rf = review('src/engine.ts', [sym({ invariant_findings: [invariantFinding({ confidence: 88 })] })]);
    const { escalated } = await applyTier2(rf);
    expect(escalated.find((e) => e.axis === 'invariants')).toBeUndefined();
    expect(escalated.filter((e) => e.symbolName === 'computePayout')).toHaveLength(0);
  });

  it('an invariant finding never adds a second escalation on top of a correction escalation', async () => {
    // An isolated NEEDS_FIX escalates once on the correction axis; carrying an
    // invariant finding too must not produce any extra escalation.
    const rf = review('src/engine.ts', [
      sym({
        correction: 'NEEDS_FIX',
        // isolated shape (no corroborating axis) ⇒ correction escalates
        overengineering: 'LEAN',
        utility: 'USED',
        duplication: 'UNIQUE',
        tests: '-',
        documentation: '-',
        detail: 'isolated correction finding worth investigating',
        invariant_findings: [invariantFinding()],
      }),
    ]);
    const { escalated } = await applyTier2(rf);
    const forSymbol = escalated.filter((e) => e.symbolName === 'computePayout');
    expect(forSymbol).toHaveLength(1);
    expect(forSymbol[0]!.axis).toBe('correction');
  });

  it('does not escalate a clean symbol with no invariant finding', async () => {
    const rf = review('src/engine.ts', [sym()]);
    const { escalated } = await applyTier2(rf);
    expect(escalated.filter((e) => e.symbolName === 'computePayout')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema round-trip: an invariant_finding survives a real review write + load.
// ---------------------------------------------------------------------------

describe('InvariantFinding schema round-trip (write + load)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'invariants-rt-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('preserves invariant_findings through SymbolReview write then parse', () => {
    const runDir = join(tmp, '.anatoly/runs/r1');
    const finding = invariantFinding();
    const rf = review('src/engine.ts', [sym({ invariant_findings: [finding] })]);
    rf.file_level = { unused_imports: [], circular_dependencies: [], general_notes: '' };

    reporting.writeReviewOutput(tmp, rf, runDir);
    const loaded = reporting.loadReviews(tmp, runDir);

    expect(loaded).toHaveLength(1);
    const s = loaded[0]!.symbols[0]!;
    expect(s.invariant_findings).toBeDefined();
    expect(s.invariant_findings).toHaveLength(1);
    expect(s.invariant_findings![0]).toEqual(finding);
    // The .transform() on SymbolReviewSchema preserves the field untouched.
    expect(s.invariant_findings![0]!.invariant).toBe('inter_representation');
    expect(s.invariant_findings![0]!.counterpart).toEqual(finding.counterpart);
  });
});

// ---------------------------------------------------------------------------
// Phase-level tests (runInvariantsPhase). Every seam the phase imports is
// spied so there is NO disk cache, NO real transport/LLM, NO real RAG store.
// The judge seam (evaluation.runSingleTurnQuery) is mocked exactly the way the
// doc-conflict detector tests mock it. uses_real_llm = false.
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    projectRoot: '/proj',
    sourceRoot: '/proj',
    runDir: '/proj/.anatoly/runs/r1',
    noCache: false,
    interrupted: false,
    invariants: true,
    activeAborts: new Set<AbortController>(),
    incompletePhases: new Set<string>(),
    pipelineState: undefined,
    router: { calls: [] } as unknown as RunContext['router'],
    // Cost rollup buckets recordLlmCost reconciles into (see cost.ts).
    totalCostUsd: 0,
    providerStats: { anthropic: { calls: 0, costUsd: 0 } },
    phaseStats: {},
    axisStats: {},
    config: {
      models: { quality: 'anthropic/claude-sonnet-4-6' },
      rag: { code_weight: 0.6 },
      runtime: { timeout_per_call: 600 },
    } as unknown as RunContext['config'],
    ...overrides,
  } as unknown as RunContext;
}

const emptyHandoff = {} as unknown as Handoff;

/** A FunctionCard stub (only the fields the matcher reads matter). */
function card(file: string, name: string): FunctionCard {
  return {
    id: `${file}:${name}`,
    filePath: file,
    name,
    signature: `${name}()`,
    complexityScore: 1,
    calledInternals: [],
    referencedImports: [],
    lastIndexed: new Date().toISOString(),
  } as unknown as FunctionCard;
}

/**
 * A fake vector store surfacing exactly one strong neighbour for a queried
 * symbol, with per-file cards. Enough to drive the structural matcher.
 */
function fakeVectorStore(args: {
  cardsByFile: Record<string, FunctionCard[]>;
  neighbours: SimilarityResult[];
}): NonNullable<RagContext['vectorStore']> {
  return {
    getCardsByFile: async (file: string) => args.cardsByFile[file] ?? [],
    searchByIdHybrid: async () => args.neighbours,
  } as unknown as NonNullable<RagContext['vectorStore']>;
}

/** Spy the judge seam to return a canned (schema-shaped) response. */
function mockJudge(findings: unknown[]): { calls: number } {
  const counter = { calls: 0 };
  vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async () => {
    counter.calls++;
    return {
      data: { findings },
      costUsd: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: '',
    } as unknown as Awaited<ReturnType<typeof evaluation.runSingleTurnQuery>>;
  });
  return counter;
}

describe('runInvariantsPhase (no-op safety + de-dup + cache)', () => {
  beforeEach(() => {
    // Default: source files readable (matcher slices bodies), cache always
    // stale (so the matcher does not skip), no doc-conflicts, no cost/disk.
    vi.spyOn(worktree, 'getEffectiveSourceRoot').mockReturnValue('/proj');
    vi.spyOn(runCache, 'resolveAxisCache').mockReturnValue({
      cached: null, reusableAxes: [], staleAxes: ['invariants'],
    } as unknown as ReturnType<typeof runCache.resolveAxisCache>);
    vi.spyOn(runCache, 'writeProjectReviewAtHash').mockReturnValue(undefined as unknown as ReturnType<typeof runCache.writeProjectReviewAtHash>);
    vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });
    vi.spyOn(documentation, 'loadPendingConflictsAsDocConflicts').mockReturnValue([]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('is a no-op (judge never called) when the config flag is disabled', async () => {
    const judge = mockJudge([{}]);
    const loadSpy = vi.spyOn(reporting, 'loadReviews').mockReturnValue([]);
    const store = fakeVectorStore({ cardsByFile: {}, neighbours: [] });

    await runInvariantsPhase(
      makeCtx({ invariants: false }),
      emptyHandoff,
      { vectorStore: store, ragEnabled: true },
    );

    expect(judge.calls).toBe(0);
    // Disabled returns before even loading reviews.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('yields zero candidates (judge never called) when RAG is disabled', async () => {
    const judge = mockJudge([{}]);
    const loadSpy = vi.spyOn(reporting, 'loadReviews').mockReturnValue([]);

    await runInvariantsPhase(
      makeCtx(),
      emptyHandoff,
      { vectorStore: undefined, ragEnabled: false },
    );

    expect(judge.calls).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('yields zero candidates (judge never called) when there is no vector store even if ragEnabled', async () => {
    const judge = mockJudge([{}]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue([]);

    await runInvariantsPhase(
      makeCtx(),
      emptyHandoff,
      { vectorStore: undefined, ragEnabled: true },
    );

    expect(judge.calls).toBe(0);
  });

  it('drops a judged finding whose (file,symbol) is already a pending doc-conflict (de-dup vs doc-16)', async () => {
    // Two reviewed code symbols that the matcher pairs; the judge confirms a
    // finding on src/engine.ts::computePayout. But doc-16 already owns that
    // anchor as a pending code-vs-doc conflict ⇒ the finding must be dropped
    // (no self-contradiction / double-count across the two lanes).
    const aSym = sym({ name: 'computePayout', line_start: 1, line_end: 3 });
    const bSym = sym({ name: 'computePayoutLegacy', line_start: 1, line_end: 3 });
    const reviews = [
      review('src/engine.ts', [aSym]),
      review('src/legacy.ts', [bSym]),
    ];
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    // Source bodies must carry divergent literals so the matcher keeps the pair.
    vi.spyOn(documentation, 'loadPendingConflictsAsDocConflicts').mockReturnValue([
      { file: 'src/engine.ts', symbol: 'computePayout' } as unknown as ReturnType<typeof documentation.loadPendingConflictsAsDocConflicts>[number],
    ]);

    const store = fakeVectorStore({
      cardsByFile: {
        'src/engine.ts': [card('src/engine.ts', 'computePayout')],
        'src/legacy.ts': [card('src/legacy.ts', 'computePayoutLegacy')],
      },
      neighbours: [{ card: card('src/legacy.ts', 'computePayoutLegacy'), score: 0.95 }],
    });

    // Judge confirms a finding on the doc-16-owned anchor.
    mockJudge([{
      file: 'src/engine.ts',
      symbol: 'computePayout',
      line_start: 1,
      line_end: 3,
      confidence: 90,
      detail: 'these two disagree on the adjustment direction',
      counterpart: { file: 'src/legacy.ts', symbol: 'computePayoutLegacy' },
    }]);

    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    // Real source files for the body slices (divergent literals 95 vs 105).
    const tmp = mkdtempSync(join(tmpdir(), 'invariants-dedup-'));
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src/engine.ts'), 'function computePayout(){\n  return bet * 95;\n}\n');
      writeFileSync(join(tmp, 'src/legacy.ts'), 'function computePayoutLegacy(){\n  return bet * 105;\n}\n');
      vi.spyOn(worktree, 'getEffectiveSourceRoot').mockReturnValue(tmp);

      await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
        vectorStore: store, ragEnabled: true,
      });

      // The finding targeted a doc-16-owned anchor ⇒ dropped ⇒ no review written.
      expect(writeSpy).not.toHaveBeenCalled();
      expect(reviews[0]!.symbols[0]!.invariant_findings).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips the judge for a file whose invariants cache key is already fresh (preserving prior findings)', async () => {
    const existing = invariantFinding({ detail: 'previously confirmed inter-representation inconsistency' });
    const aSym = sym({ name: 'computePayout', invariant_findings: [existing] });
    const reviews = [review('src/engine.ts', [aSym])];
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);

    // Fresh cache key ⇒ resolveAxisCache reports no stale axes for this file.
    vi.spyOn(runCache, 'resolveAxisCache').mockReturnValue({
      cached: null, reusableAxes: ['invariants'], staleAxes: [],
    } as unknown as ReturnType<typeof runCache.resolveAxisCache>);

    const store = fakeVectorStore({
      cardsByFile: { 'src/engine.ts': [card('src/engine.ts', 'computePayout')] },
      neighbours: [{ card: card('src/engine.ts', 'computePayout'), score: 0.99 }],
    });
    const judge = mockJudge([]);
    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });
    const cacheWriteSpy = vi.spyOn(runCache, 'writeProjectReviewAtHash').mockReturnValue(undefined as unknown as ReturnType<typeof runCache.writeProjectReviewAtHash>);

    const tmp = mkdtempSync(join(tmpdir(), 'invariants-fresh-'));
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src/engine.ts'), 'function computePayout(){\n  return bet * 95;\n}\n');
      vi.spyOn(worktree, 'getEffectiveSourceRoot').mockReturnValue(tmp);

      await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
        vectorStore: store, ragEnabled: true,
      });

      // Fresh ⇒ no judge call, no review re-write, no cache re-key for this file.
      expect(judge.calls).toBe(0);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(cacheWriteSpy).not.toHaveBeenCalled();
      // Prior finding is preserved untouched.
      expect(reviews[0]!.symbols[0]!.invariant_findings).toEqual([existing]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('marks the phase incomplete (not silently done) and skips cache re-keying when the judge hits the usage limit', async () => {
    const aSym = sym({ name: 'computePayout', line_start: 1, line_end: 3 });
    const bSym = sym({ name: 'computePayoutLegacy', line_start: 1, line_end: 3 });
    const reviews = [review('src/engine.ts', [aSym]), review('src/legacy.ts', [bSym])];
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);

    const store = fakeVectorStore({
      cardsByFile: {
        'src/engine.ts': [card('src/engine.ts', 'computePayout')],
        'src/legacy.ts': [card('src/legacy.ts', 'computePayoutLegacy')],
      },
      neighbours: [{ card: card('src/legacy.ts', 'computePayoutLegacy'), score: 0.95 }],
    });

    // The judge call is rejected by the subscription usage limit.
    const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000;
    const judge = vi.spyOn(evaluation, 'runSingleTurnQuery').mockRejectedValue(new RateLimitStandbyError(resetsAtMs));
    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });
    const cacheWriteSpy = vi.spyOn(runCache, 'writeProjectReviewAtHash').mockReturnValue(undefined as unknown as ReturnType<typeof runCache.writeProjectReviewAtHash>);

    const tmp = mkdtempSync(join(tmpdir(), 'invariants-ratelimit-'));
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src/engine.ts'), 'function computePayout(){\n  return bet * 95;\n}\n');
      writeFileSync(join(tmp, 'src/legacy.ts'), 'function computePayoutLegacy(){\n  return bet * 105;\n}\n');
      vi.spyOn(worktree, 'getEffectiveSourceRoot').mockReturnValue(tmp);

      const ctx = makeCtx({ projectRoot: tmp, sourceRoot: tmp });
      await runInvariantsPhase(ctx, emptyHandoff, { vectorStore: store, ragEnabled: true });

      // The judge was attempted (candidate surfaced) and rejected — but the
      // run did NOT crash: the phase returns and records the incompleteness.
      expect(judge).toHaveBeenCalled();
      expect([...ctx.incompletePhases]).toContain('invariants');
      expect(ctx.rateLimitResetAt).toBe(resetsAtMs);
      // No fresh 'invariants' cache key written — otherwise a resume would treat
      // the un-judged files as done and skip re-judging them.
      expect(cacheWriteSpy).not.toHaveBeenCalled();
      // No findings were produced, so nothing was written back either.
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Numerical-target invariant (increment 2): a documented numeric target +
// the contributing constant tables, judged by a rule-12 derivation. The judge
// seam is mocked (no real LLM); the RAG code-vs-code matcher is starved (empty
// store) so only the numerical bundle drives the single judge call.
// ---------------------------------------------------------------------------

const ENGINE_SRC = [
  "import { getReelWeights } from './reels.js';",
  '',
  '/**',
  ' * Applies the house edge to maintain a target RTP of approximately 95%.',
  ' */',
  'function computePayout(bet: number): number {',
  '  return bet;',
  '}',
].join('\n');

const REELS_SRC = [
  'export const DEFAULT_WEIGHTS = { CHERRY: 25, LEMON: 25, BELL: 15, BAR: 10, SEVEN: 5, DIAMOND: 30, WILD: 5, SCATTER: 5 };',
  '',
  'export function weightsToArray(): number[] {',
  '  return Object.values(DEFAULT_WEIGHTS);',
  '}',
].join('\n');

const NUMERIC_FINDING = {
  file: 'src/reels.ts',
  symbol: 'DEFAULT_WEIGHTS.DIAMOND',
  line_start: 1,
  line_end: 1,
  confidence: 92,
  detail: 'DIAMOND weight 30/120 = 0.25 implies RTP ~239%, an order of magnitude above the documented 95%; weight should be ~3',
};

describe('runInvariantsPhase (numerical_target invariant)', () => {
  let tmp: string;

  beforeEach(() => {
    vi.spyOn(runCache, 'resolveAxisCache').mockReturnValue({
      cached: null, reusableAxes: [], staleAxes: ['invariants'],
    } as unknown as ReturnType<typeof runCache.resolveAxisCache>);
    vi.spyOn(runCache, 'writeProjectReviewAtHash').mockReturnValue(undefined as unknown as ReturnType<typeof runCache.writeProjectReviewAtHash>);
    vi.spyOn(documentation, 'loadPendingConflictsAsDocConflicts').mockReturnValue([]);
    tmp = mkdtempSync(join(tmpdir(), 'invariants-num-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src/engine.ts'), ENGINE_SRC);
    writeFileSync(join(tmp, 'src/reels.ts'), REELS_SRC);
    vi.spyOn(worktree, 'getEffectiveSourceRoot').mockReturnValue(tmp);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Empty store ⇒ the code-vs-code matcher surfaces nothing; only numeric drives the judge. */
  const emptyStore = () => fakeVectorStore({ cardsByFile: {}, neighbours: [] });

  function reelsReviews(reelsSymbols: SymbolReview[]): ReviewFile[] {
    return [
      review('src/engine.ts', [sym({ name: 'computePayout', kind: 'function', line_start: 6, line_end: 8 })]),
      review('src/reels.ts', reelsSymbols),
    ];
  }

  it('judges a documented-target bundle and anchors the finding to the named constant', async () => {
    const reviews = reelsReviews([
      sym({ name: 'DEFAULT_WEIGHTS', kind: 'constant', line_start: 1, line_end: 1, correction: 'OK' }),
      sym({ name: 'weightsToArray', kind: 'function', line_start: 3, line_end: 5, correction: 'OK' }),
    ]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    const judge = mockJudge([NUMERIC_FINDING]);
    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
      vectorStore: emptyStore(), ragEnabled: true,
    });

    // Exactly one judge call (the single numeric bundle).
    expect(judge.calls).toBe(1);
    const reels = reviews[1]!;
    const anchored = reels.symbols.find((s) => s.name === 'DEFAULT_WEIGHTS')!;
    expect(anchored.invariant_findings).toHaveLength(1);
    const f = anchored.invariant_findings![0]!;
    expect(f.invariant).toBe('numerical_target');
    expect(f.confidence).toBe(92);
    expect(f.counterpart).toEqual({ file: 'src/engine.ts', symbol: 'computePayout' });
    // engine.ts (the seed/consuming side) carries NO invariant finding.
    expect(reviews[0]!.symbols[0]!.invariant_findings).toBeUndefined();
    expect(writeSpy).toHaveBeenCalled();
  });

  it('folds the numerical finding into a single correction NEEDS_FIX on the table file', async () => {
    const reviews = reelsReviews([
      sym({ name: 'DEFAULT_WEIGHTS', kind: 'constant', line_start: 1, line_end: 1, correction: 'OK' }),
    ]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    mockJudge([NUMERIC_FINDING]);
    vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
      vectorStore: emptyStore(), ragEnabled: true,
    });

    const folded = applyInvariantFindingsToReviews(reviews);
    expect(folded).toBe(1);
    const reels = reviews[1]!;
    const flagged = reels.symbols.filter((s) => s.correction === 'NEEDS_FIX');
    expect(flagged).toHaveLength(1); // exactly one ⇒ no per-file bench FP
    expect(flagged[0]!.name).toBe('DEFAULT_WEIGHTS');
    expect(flagged[0]!.detail).toContain('Numerical-target inconsistency');
  });

  it('default-to-no-finding: an empty judge response writes nothing', async () => {
    const reviews = reelsReviews([
      sym({ name: 'DEFAULT_WEIGHTS', kind: 'constant', line_start: 1, line_end: 1, correction: 'OK' }),
    ]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    const judge = mockJudge([]);
    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
      vectorStore: emptyStore(), ragEnabled: true,
    });

    expect(judge.calls).toBe(1); // bundle judged
    expect(reviews[1]!.symbols[0]!.invariant_findings).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('drops the numeric finding when the table file already carries a correction defect (no double-surface)', async () => {
    // The correction axis already caught DIAMOND ⇒ reels.ts already scores; a
    // 2nd NEEDS_FIX would be a per-file false positive, so the fold is skipped.
    const reviews = reelsReviews([
      sym({ name: 'DEFAULT_WEIGHTS', kind: 'constant', line_start: 1, line_end: 1, correction: 'NEEDS_FIX', detail: 'DIAMOND weight is implausibly high' }),
    ]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    mockJudge([NUMERIC_FINDING]);
    const writeSpy = vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
      vectorStore: emptyStore(), ragEnabled: true,
    });

    const reels = reviews[1]!;
    expect(reels.symbols[0]!.invariant_findings).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('falls back to a clean reviewed symbol when the named constant is not a reviewed symbol', async () => {
    // DEFAULT_WEIGHTS is not in the review; the finding anchors to the first
    // clean reviewed symbol so the file still surfaces exactly one finding.
    const reviews = reelsReviews([
      sym({ name: 'weightsToArray', kind: 'function', line_start: 3, line_end: 5, correction: 'OK' }),
    ]);
    vi.spyOn(reporting, 'loadReviews').mockReturnValue(reviews);
    mockJudge([NUMERIC_FINDING]);
    vi.spyOn(reporting, 'writeReviewOutput').mockReturnValue({ jsonPath: '', mdPath: '' });

    await runInvariantsPhase(makeCtx({ projectRoot: tmp, sourceRoot: tmp }), emptyHandoff, {
      vectorStore: emptyStore(), ragEnabled: true,
    });

    const reels = reviews[1]!;
    const anchored = reels.symbols.find((s) => s.name === 'weightsToArray')!;
    expect(anchored.invariant_findings).toHaveLength(1);
    expect(anchored.invariant_findings![0]!.invariant).toBe('numerical_target');
  });
});
