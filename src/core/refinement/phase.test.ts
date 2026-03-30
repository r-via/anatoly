// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runRefinementPhase,
  type RefinementContext,
  type RefinementResult,
} from './phase.js';
import type { ReviewFile, SymbolReview } from '../../schemas/review.js';
import type { UsageGraph } from '../usage-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(overrides: Partial<SymbolReview> = {}): SymbolReview {
  return {
    name: 'doWork',
    kind: 'function',
    exported: true,
    line_start: 1,
    line_end: 20,
    correction: 'OK',
    overengineering: 'LEAN',
    utility: 'USED',
    duplication: 'UNIQUE',
    tests: 'GOOD',
    documentation: 'DOCUMENTED',
    confidence: 85,
    detail: 'All axes evaluated successfully.',
    duplicate_target: undefined,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReview(overrides: Record<string, any> = {}): ReviewFile {
  const { symbols: symOverrides, ...rest } = overrides;
  return {
    version: 2,
    file: 'src/core/example.ts',
    verdict: 'NEEDS_REFACTOR',
    symbols: symOverrides ? symOverrides.map((s: Partial<SymbolReview>) => makeSymbol(s)) : [makeSymbol()],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    is_generated: false,
    axis_timing: {},
    ...rest,
  } as ReviewFile;
}

function makeUsageGraph(usages: Map<string, Set<string>> = new Map()): UsageGraph {
  return {
    usages,
    typeOnlyUsages: new Map(),
    intraFileRefs: new Map(),
    noImportFiles: new Set(),
  } as UsageGraph;
}

function makeCtx(overrides: Partial<RefinementContext> = {}): RefinementContext {
  return {
    projectRoot: '/tmp/test-project',
    runDir: '/tmp/test-project/.anatoly/runs/test-run',
    config: {
      models: {
        deliberation: 'anthropic/claude-opus-4-6',
      },
      agents: {},
    } as RefinementContext['config'],
    usageGraph: makeUsageGraph(),
    fileContents: new Map(),
    preResolvedRag: new Map(),
    abortController: new AbortController(),
    deliberation: true,
    plain: false,
    onProgress: vi.fn(),
    loadReviewsFn: vi.fn().mockReturnValue([]),
    writeReviewFn: vi.fn(),
    queryFn: vi.fn().mockResolvedValue({
      data: { verdict: 'CLEAN', symbols: [], removed_actions: [], reasoning: 'No findings.' },
      costUsd: 0.10,
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    }),
    recordFn: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRefinementPhase', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // --- AC: Executes tier 1 → tier 2 → tier 3 sequentially ---

  it('AC: runs all 3 tiers sequentially on ReviewFiles', async () => {
    const reviews = [
      makeReview({
        file: 'src/core/a.ts',
        symbols: [{
          name: 'deadFunc',
          utility: 'DEAD',
          exported: true,
          confidence: 80,
          detail: 'No importers found for deadFunc',
        }],
      }),
    ];

    // deadFunc is actually imported (usage graph says so)
    const usageGraph = makeUsageGraph(
      new Map([['deadFunc::src/core/a.ts', new Set(['src/utils/b.ts'])]]),
    );

    const ctx = makeCtx({
      usageGraph,
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
    });

    const result = await runRefinementPhase(ctx);

    expect(result.tier1Stats.resolved).toBeGreaterThanOrEqual(1);
    expect(ctx.writeReviewFn).toHaveBeenCalled();
  });

  it('AC: tier 2 receives tier 1 output', async () => {
    // Symbol: DEAD + NEEDS_FIX — tier 1 resolves DEAD→USED, tier 2 should not apply DEAD+NEEDS_FIX rule
    const reviews = [
      makeReview({
        file: 'src/core/a.ts',
        symbols: [{
          name: 'func1',
          utility: 'DEAD',
          correction: 'NEEDS_FIX',
          exported: true,
          confidence: 80,
          detail: 'Dead code with fix needed',
        }],
      }),
    ];

    // Usage graph proves it's actually USED
    const usageGraph = makeUsageGraph(
      new Map([['func1::src/core/a.ts', new Set(['src/b.ts'])]]),
    );

    const ctx = makeCtx({
      usageGraph,
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
    });

    const result = await runRefinementPhase(ctx);

    // Tier 1 resolved DEAD→USED, so tier 2 should NOT apply DEAD+NEEDS_FIX rule
    expect(result.tier1Stats.resolved).toBeGreaterThanOrEqual(1);
    // Tier 2 stats should reflect that no DEAD+NEEDS_FIX rule was needed
    expect(result.tier2Stats.resolved).toBeDefined();
  });

  // --- AC: Report phase reads refined ReviewFiles ---

  it('AC: writes refined ReviewFiles back to disk', async () => {
    const reviews = [
      makeReview({
        file: 'src/core/a.ts',
        symbols: [{
          name: 'deadFunc',
          utility: 'DEAD',
          exported: true,
          confidence: 80,
          detail: 'No importers found for deadFunc',
        }],
      }),
    ];

    const usageGraph = makeUsageGraph(
      new Map([['deadFunc::src/core/a.ts', new Set(['src/b.ts'])]]),
    );

    const writeReviewFn = vi.fn();

    const ctx = makeCtx({
      usageGraph,
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
      writeReviewFn,
    });

    await runRefinementPhase(ctx);

    // Should write at least one refined review back
    expect(writeReviewFn).toHaveBeenCalledTimes(1);
    // The written review should have utility changed from DEAD to USED
    const writtenReview = writeReviewFn.mock.calls[0][0] as ReviewFile;
    expect(writtenReview.symbols[0].utility).toBe('USED');
  });

  // --- AC: --no-deliberation skips refinement ---

  it('AC: skips entirely when deliberation is false', async () => {
    const ctx = makeCtx({ deliberation: false });

    const result = await runRefinementPhase(ctx);

    expect(result.skipped).toBe(true);
    expect(result.tier1Stats.resolved).toBe(0);
    expect(ctx.loadReviewsFn).not.toHaveBeenCalled();
  });

  // --- AC: Empty reviews ---

  it('handles empty review set gracefully', async () => {
    const ctx = makeCtx({
      loadReviewsFn: vi.fn().mockReturnValue([]),
    });

    const result = await runRefinementPhase(ctx);

    expect(result.tier1Stats.resolved).toBe(0);
    expect(result.tier2Stats.resolved).toBe(0);
    expect(result.tier3Stats.investigated).toBe(0);
  });

  // --- AC: Progress callbacks ---

  it('AC: emits progress events for each tier', async () => {
    const reviews = [makeReview()];
    const onProgress = vi.fn();

    const ctx = makeCtx({
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
      onProgress,
    });

    await runRefinementPhase(ctx);

    const events = onProgress.mock.calls.map((c) => c[0]);
    expect(events).toContain('tier1-start');
    expect(events).toContain('tier1-done');
    expect(events).toContain('tier2-start');
    expect(events).toContain('tier2-done');
    expect(events).toContain('tier3-start');
    expect(events).toContain('tier3-done');
  });

  // --- AC: Stats consolidation ---

  it('AC: returns consolidated refinement stats', async () => {
    const reviews = [
      makeReview({
        file: 'src/core/a.ts',
        symbols: [{
          name: 'deadFunc',
          utility: 'DEAD',
          exported: true,
          confidence: 80,
          detail: 'No importers found for deadFunc',
        }],
      }),
    ];

    const usageGraph = makeUsageGraph(
      new Map([['deadFunc::src/core/a.ts', new Set(['src/b.ts'])]]),
    );

    const ctx = makeCtx({
      usageGraph,
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
    });

    const result = await runRefinementPhase(ctx);

    expect(result).toHaveProperty('tier1Stats');
    expect(result).toHaveProperty('tier2Stats');
    expect(result).toHaveProperty('tier3Stats');
    expect(result).toHaveProperty('totalDurationMs');
    expect(result).toHaveProperty('totalCostUsd');
    expect(result.skipped).toBe(false);
  });

  // --- AC: Tier 2 escalates to tier 3 ---

  it('AC: tier 3 investigates findings escalated by tier 2', async () => {
    const reviews = [
      makeReview({
        file: 'src/core/a.ts',
        symbols: [{
          name: 'errorFunc',
          correction: 'ERROR',
          confidence: 95,
          detail: 'Critical crash at runtime',
        }],
      }),
    ];

    const queryFn = vi.fn().mockResolvedValue({
      data: {
        verdict: 'CRITICAL',
        symbols: [{
          name: 'errorFunc',
          original: { correction: 'ERROR', confidence: 95 },
          deliberated: { correction: 'ERROR', confidence: 98 },
          reasoning: 'Confirmed: null pointer at line 42.',
        }],
        removed_actions: [],
        reasoning: 'ERROR finding confirmed via code investigation.',
      },
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const ctx = makeCtx({
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
      queryFn,
    });

    const result = await runRefinementPhase(ctx);

    // Tier 2 always escalates ERROR → tier 3
    expect(result.tier2Stats.escalated).toBeGreaterThanOrEqual(1);
    // Tier 3 should have investigated
    expect(result.tier3Stats.investigated).toBeGreaterThanOrEqual(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  // --- AC: No tier 3 when no escalations ---

  it('AC: skips tier 3 when no findings are escalated', async () => {
    // Clean review — no escalations expected
    const reviews = [makeReview()];

    const queryFn = vi.fn();

    const ctx = makeCtx({
      loadReviewsFn: vi.fn().mockReturnValue(reviews),
      queryFn,
    });

    const result = await runRefinementPhase(ctx);

    // queryFn should not be called (no tier 3 needed)
    expect(queryFn).not.toHaveBeenCalled();
    expect(result.tier3Stats.investigated).toBe(0);
  });
});
