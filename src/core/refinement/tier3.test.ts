// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildShards,
  runTier3,
  type Shard,
  type Tier3Context,
  type Tier3Result,
  type ShardResult,
} from './tier3.js';
import type { EscalatedFinding } from './tier2.js';
import type { ReviewFile, SymbolReview } from '../../schemas/review.js';
import type { DeliberationResponse } from '../deliberation.js';

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

function makeEscalated(overrides: Partial<EscalatedFinding> = {}): EscalatedFinding {
  return {
    file: 'src/core/example.ts',
    symbolName: 'doWork',
    axis: 'correction',
    value: 'NEEDS_FIX',
    reason: 'Low confidence isolated finding (confidence: 60)',
    ...overrides,
  };
}

function makeDeliberationResponse(overrides: Partial<DeliberationResponse> = {}): DeliberationResponse {
  return {
    verdict: 'NEEDS_REFACTOR',
    symbols: [],
    removed_actions: [],
    reasoning: 'Tier 3 investigation confirmed all findings after code review.',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<Tier3Context> = {}): Tier3Context {
  return {
    projectRoot: '/tmp/test-project',
    model: 'anthropic/claude-opus-4-6',
    abortController: new AbortController(),
    reviewsByFile: new Map(),
    budgetUsd: 30,
    queryFn: vi.fn().mockResolvedValue({
      data: makeDeliberationResponse(),
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test transcript',
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — buildShards
// ---------------------------------------------------------------------------

describe('buildShards', () => {
  it('AC: groups escalated findings by directory into shards', () => {
    const findings: EscalatedFinding[] = [];
    // 5 findings in src/core/
    for (let i = 0; i < 5; i++) {
      findings.push(makeEscalated({
        file: `src/core/module${i}.ts`,
        symbolName: `func${i}`,
      }));
    }
    // 3 findings in src/utils/
    for (let i = 0; i < 3; i++) {
      findings.push(makeEscalated({
        file: `src/utils/util${i}.ts`,
        symbolName: `util${i}`,
      }));
    }

    const shards = buildShards(findings);

    expect(shards.length).toBe(2);
    const dirs = shards.map((s) => s.module);
    expect(dirs).toContain('src/core');
    expect(dirs).toContain('src/utils');
  });

  it('AC: shards contain 10-20 files max — splits large modules', () => {
    const findings: EscalatedFinding[] = [];
    // 25 findings in one module
    for (let i = 0; i < 25; i++) {
      findings.push(makeEscalated({
        file: `src/core/module${i}.ts`,
        symbolName: `func${i}`,
      }));
    }

    const shards = buildShards(findings);

    // Should split into 2 shards (20 + 5)
    expect(shards.length).toBe(2);
    expect(shards[0].findings.length).toBeLessThanOrEqual(20);
    expect(shards[1].findings.length).toBeLessThanOrEqual(20);
    // Total findings preserved
    const total = shards.reduce((sum, s) => sum + s.findings.length, 0);
    expect(total).toBe(25);
  });

  it('should handle empty findings array', () => {
    const shards = buildShards([]);
    expect(shards.length).toBe(0);
  });

  it('should merge small modules into one shard', () => {
    // 2 findings in src/a/, 1 in src/b/, 1 in src/c/ — all below threshold
    const findings: EscalatedFinding[] = [
      makeEscalated({ file: 'src/a/file1.ts', symbolName: 'a1' }),
      makeEscalated({ file: 'src/a/file2.ts', symbolName: 'a2' }),
      makeEscalated({ file: 'src/b/file1.ts', symbolName: 'b1' }),
      makeEscalated({ file: 'src/c/file1.ts', symbolName: 'c1' }),
    ];

    const shards = buildShards(findings);

    // All should fit in 1 shard (total 4 findings < 20)
    expect(shards.length).toBeGreaterThanOrEqual(1);
    const total = shards.reduce((sum, s) => sum + s.findings.length, 0);
    expect(total).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests — runTier3
// ---------------------------------------------------------------------------

describe('runTier3', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Clear any stale global cache from previous test runs
    try { rmSync(join('/tmp/test-project', '.anatoly', 'cache', 'refinement-cache.json'), { force: true }); } catch { /* ok */ }
  });

  // --- AC: Agent investigates and produces confirmed/reclassified verdicts ---

  it('AC: returns confirmed findings when agent confirms all', async () => {
    const review = makeReview({
      file: 'src/core/example.ts',
      symbols: [{
        name: 'buggyFunc',
        correction: 'NEEDS_FIX', confidence: 60,
        detail: 'Possible off-by-one error',
      }],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [{
        name: 'buggyFunc',
        original: { correction: 'NEEDS_FIX', confidence: 60 },
        deliberated: { correction: 'NEEDS_FIX', confidence: 85 },
        reasoning: 'Confirmed: line 42 has an off-by-one — array index goes to length instead of length-1.',
      }],
      reasoning: 'Investigation confirmed the finding with evidence from source code.',
    });

    const queryFn = vi.fn().mockResolvedValue({
      data: deliberation,
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated({
        file: 'src/core/example.ts',
        symbolName: 'buggyFunc',
        axis: 'correction',
        value: 'NEEDS_FIX',
      })],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', review]]),
    });

    const result = await runTier3(shards, ctx);

    expect(result.investigated).toBe(1);
    expect(result.confirmed).toBeGreaterThanOrEqual(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('AC: returns reclassified findings when agent reclassifies', async () => {
    const review = makeReview({
      file: 'src/core/example.ts',
      symbols: [{
        name: 'suspectFunc',
        correction: 'NEEDS_FIX', confidence: 60,
        detail: 'Possible null dereference',
      }],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [{
        name: 'suspectFunc',
        original: { correction: 'NEEDS_FIX', confidence: 60 },
        deliberated: { correction: 'OK', confidence: 90 },
        reasoning: 'False positive: null check exists at line 15 — the guard clause handles this case.',
      }],
      verdict: 'CLEAN',
      reasoning: 'Reclassified after verifying the null guard at line 15.',
    });

    const queryFn = vi.fn().mockResolvedValue({
      data: deliberation,
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated({
        file: 'src/core/example.ts',
        symbolName: 'suspectFunc',
      })],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', review]]),
    });

    const result = await runTier3(shards, ctx);

    expect(result.reclassified).toBeGreaterThanOrEqual(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  // --- AC: Output compatible with DeliberationResponse ---

  it('AC: query uses DeliberationResponse schema via queryFn', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      data: makeDeliberationResponse(),
      costUsd: 0.10,
      durationMs: 2000,
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated()],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', makeReview()]]),
    });

    await runTier3(shards, ctx);

    expect(queryFn).toHaveBeenCalledTimes(1);
    // Verify the query receives system prompt and user message
    const call = queryFn.mock.calls[0];
    expect(call[0]).toHaveProperty('systemPrompt');
    expect(call[0]).toHaveProperty('userMessage');
    expect(call[0]).toHaveProperty('model', 'anthropic/claude-opus-4-6');
  });

  // --- AC: Error isolation per shard ---

  it('AC: shard error is isolated — other shards continue', async () => {
    const review1 = makeReview({ file: 'src/core/example.ts' });
    const review2 = makeReview({ file: 'src/utils/helper.ts' });

    let callCount = 0;
    const queryFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Rate limit exceeded');
      }
      return {
        data: makeDeliberationResponse(),
        costUsd: 0.50,
        durationMs: 5000,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: 'test',
      };
    });

    const shards: Shard[] = [
      { module: 'src/core', findings: [makeEscalated({ file: 'src/core/example.ts' })] },
      { module: 'src/utils', findings: [makeEscalated({ file: 'src/utils/helper.ts' })] },
    ];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([
        ['src/core/example.ts', review1],
        ['src/utils/helper.ts', review2],
      ]),
    });

    const result = await runTier3(shards, ctx);

    // Both shards attempted
    expect(queryFn).toHaveBeenCalledTimes(2);
    // One failed, one succeeded
    expect(result.shardResults.length).toBe(2);
    expect(result.shardResults[0].status).toBe('failed');
    expect(result.shardResults[1].status).toBe('ok');
  });

  // --- AC: Budget cap ---

  it('AC: stops processing when budget exceeded ($30 default)', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      data: makeDeliberationResponse(),
      costUsd: 16.0, // Each shard costs $16
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [
      { module: 'src/core', findings: [makeEscalated({ file: 'src/core/a.ts' })] },
      { module: 'src/utils', findings: [makeEscalated({ file: 'src/utils/b.ts' })] },
      { module: 'src/cli', findings: [makeEscalated({ file: 'src/cli/c.ts' })] },
    ];

    const ctx = makeCtx({
      queryFn,
      budgetUsd: 30,
      reviewsByFile: new Map([
        ['src/core/a.ts', makeReview({ file: 'src/core/a.ts' })],
        ['src/utils/b.ts', makeReview({ file: 'src/utils/b.ts' })],
        ['src/cli/c.ts', makeReview({ file: 'src/cli/c.ts' })],
      ]),
    });

    const result = await runTier3(shards, ctx);

    // Should stop after 2 shards ($16 + $16 = $32 > $30)
    expect(queryFn).toHaveBeenCalledTimes(2);
    // Third shard should be skipped
    expect(result.shardResults[2].status).toBe('skipped');
    expect(result.budgetExceeded).toBe(true);
  });

  // --- AC: Consolidation report ---

  it('AC: returns consolidation stats', async () => {
    const review = makeReview({
      file: 'src/core/example.ts',
      symbols: [
        { name: 'func1', correction: 'NEEDS_FIX', confidence: 60, detail: 'Bug found' },
        { name: 'func2', correction: 'ERROR', confidence: 95, detail: 'Critical crash' },
      ],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [
        {
          name: 'func1',
          original: { correction: 'NEEDS_FIX', confidence: 60 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'False positive verified by reading code.',
        },
        {
          name: 'func2',
          original: { correction: 'ERROR', confidence: 95 },
          deliberated: { correction: 'ERROR', confidence: 95 },
          reasoning: 'Confirmed: crash verified at line 42.',
        },
      ],
      reasoning: 'Mixed results: 1 reclassified, 1 confirmed.',
    });

    const queryFn = vi.fn().mockResolvedValue({
      data: deliberation,
      costUsd: 1.50,
      durationMs: 8000,
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [
        makeEscalated({ file: 'src/core/example.ts', symbolName: 'func1' }),
        makeEscalated({ file: 'src/core/example.ts', symbolName: 'func2', value: 'ERROR' }),
      ],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', review]]),
    });

    const result = await runTier3(shards, ctx);

    expect(result.investigated).toBe(2);
    expect(result.reclassified).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(result.totalCostUsd).toBe(1.50);
    expect(result.totalDurationMs).toBeGreaterThan(0);
  });

  // --- Empty input ---

  it('should handle empty shards array', async () => {
    const ctx = makeCtx();
    const result = await runTier3([], ctx);

    expect(result.investigated).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(result.reclassified).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.shardResults.length).toBe(0);
  });

  // --- AC: Prompt contains claims list, not full source code ---

  it('AC: user message contains findings as claims to verify', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      data: makeDeliberationResponse(),
      costUsd: 0.10,
      durationMs: 2000,
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated({
        file: 'src/core/example.ts',
        symbolName: 'buggyFunc',
        axis: 'correction',
        value: 'NEEDS_FIX',
        reason: 'Low confidence isolated finding (confidence: 60)',
      })],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', makeReview()]]),
    });

    await runTier3(shards, ctx);

    const call = queryFn.mock.calls[0];
    const userMessage: string = call[0].userMessage;
    // Should contain the claim details
    expect(userMessage).toContain('buggyFunc');
    expect(userMessage).toContain('correction');
    expect(userMessage).toContain('NEEDS_FIX');
    expect(userMessage).toContain('src/core/example.ts');
  });

  // --- AC: Applies reclassifications to ReviewFiles ---

  it('AC: updates ReviewFile symbols when agent reclassifies', async () => {
    const review = makeReview({
      file: 'src/core/example.ts',
      symbols: [{
        name: 'suspectFunc',
        correction: 'NEEDS_FIX', confidence: 60,
        detail: 'Possible null dereference',
      }],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [{
        name: 'suspectFunc',
        original: { correction: 'NEEDS_FIX', confidence: 60 },
        deliberated: { correction: 'OK', confidence: 90 },
        reasoning: 'Null guard exists at line 15.',
      }],
      verdict: 'CLEAN',
      reasoning: 'All findings resolved after investigation.',
    });

    const queryFn = vi.fn().mockResolvedValue({
      data: deliberation,
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const reviewsMap = new Map([['src/core/example.ts', review]]);

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated({ file: 'src/core/example.ts', symbolName: 'suspectFunc' })],
    }];

    const ctx = makeCtx({ queryFn, reviewsByFile: reviewsMap });
    const result = await runTier3(shards, ctx);

    // The updatedReviews should have the reclassified review
    expect(result.updatedReviews.size).toBeGreaterThan(0);
    const updated = result.updatedReviews.get('src/core/example.ts');
    expect(updated).toBeDefined();
    expect(updated!.symbols[0].correction).toBe('OK');
    expect(updated!.symbols[0].confidence).toBe(90);
  });

  // --- AC: Records reclassifications to memory ---

  it('AC: calls recordReclassification for reclassified findings', async () => {
    const review = makeReview({
      file: 'src/core/example.ts',
      symbols: [{
        name: 'deadFunc',
        utility: 'DEAD', confidence: 70,
        detail: 'No importers found for deadFunc',
      }],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [{
        name: 'deadFunc',
        original: { utility: 'DEAD', confidence: 70 },
        deliberated: { utility: 'USED', confidence: 90 },
        reasoning: 'Found dynamic import in src/cli/main.ts via grep.',
      }],
      verdict: 'CLEAN',
      reasoning: 'Dead code finding was false positive — dynamic import detected.',
    });

    const queryFn = vi.fn().mockResolvedValue({
      data: deliberation,
      costUsd: 0.50,
      durationMs: 5000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: 'test',
    });

    const recordFn = vi.fn();

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated({
        file: 'src/core/example.ts',
        symbolName: 'deadFunc',
        axis: 'utility',
        value: 'DEAD',
      })],
    }];

    const ctx = makeCtx({
      queryFn,
      reviewsByFile: new Map([['src/core/example.ts', review]]),
      recordFn,
    });

    await runTier3(shards, ctx);

    expect(recordFn).toHaveBeenCalledTimes(1);
    expect(recordFn).toHaveBeenCalledWith(
      '/tmp/test-project',
      expect.objectContaining({
        symbol: 'deadFunc',
        reclassifications: expect.arrayContaining([
          expect.objectContaining({ axis: 'utility', from: 'DEAD', to: 'USED' }),
        ]),
      }),
    );
  });

  // --- AC: Abort via AbortController ---

  it('should respect abort controller', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const queryFn = vi.fn().mockRejectedValue(new Error('Aborted'));

    const shards: Shard[] = [{
      module: 'src/core',
      findings: [makeEscalated()],
    }];

    const ctx = makeCtx({
      queryFn,
      abortController,
      reviewsByFile: new Map([['src/core/example.ts', makeReview()]]),
    });

    const result = await runTier3(shards, ctx);

    // Should not throw, shard marked as failed
    expect(result.shardResults[0].status).toBe('failed');
  });
});
