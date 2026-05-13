// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLM_CALLS_SCHEMA_VERSION,
  getActiveSinkPath,
  getActiveSinkTotals,
  recordLlmCall,
  recordPlanEstimate,
  withLlmCallSink,
  writeCostSummary,
  writeCostVariance,
} from './llm-calls-sink.js';
import type { CostSummary, CostVariance } from './llm-calls-sink.js';
import { runWithContext } from './log-context.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anatoly-sink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('llm-calls-sink', () => {
  it('writes one ndjson line per recordLlmCall with schemaVersion 2 + t offset', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0.01, durationMs: 500,
        success: true,
      });
    });

    const events = readEvents(path);
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.schemaVersion).toBe(2);
    expect(typeof e.t).toBe('number');
    expect(e.t).toBeGreaterThanOrEqual(0);
    expect(e.provider).toBe('anthropic');
    expect(e.inputTokens).toBe(100);
    expect(e.costSource).toBe('actual');
  });

  it('appends multiple calls in order on a single line each', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    withLlmCallSink(path, () => {
      for (let i = 0; i < 3; i++) {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: i, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
      }
    });

    const events = readEvents(path);
    expect(events.map((e) => (e as { inputTokens: number }).inputTokens)).toEqual([0, 1, 2]);
  });

  it('inherits phase and composer from the active log context', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    withLlmCallSink(path, () => {
      runWithContext({ phase: 'review', composer: 'axes.correction' }, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect(e.phase).toBe('review');
    expect(e.composer).toBe('axes.correction');
  });

  it('omits phase/composer when no log context is active', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: true,
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect('phase' in e).toBe(false);
    expect('composer' in e).toBe(false);
  });

  it('is a silent no-op when called outside any sink scope', () => {
    const path = join(dir, 'never-created.ndjson');
    expect(() =>
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: true,
      }),
    ).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('persists error metadata for failed calls', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: false,
        attempt: 2,
        retryReason: 'rate_limit',
        error: { code: 'RATE_LIMIT', message: '429' },
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect(e.success).toBe(false);
    expect(e.attempt).toBe(2);
    expect(e.error).toEqual({ code: 'RATE_LIMIT', message: '429' });
  });

  it('exposes the active sink path via getActiveSinkPath()', () => {
    const path = join(dir, 'costs', 'ledger.ndjson');
    expect(getActiveSinkPath()).toBeUndefined();
    withLlmCallSink(path, () => {
      expect(getActiveSinkPath()).toBe(path);
    });
    expect(getActiveSinkPath()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Schema v2 specific tests
  // -------------------------------------------------------------------------

  describe('schema v2', () => {
    it('schemaVersion constant is 2', () => {
      expect(LLM_CALLS_SCHEMA_VERSION).toBe(2);
    });

    it('callId is recorded when provided', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0.01, durationMs: 0, success: true,
          callId: 'abc123',
        });
      });

      const e = readEvents(path)[0] as Record<string, unknown>;
      expect(e.callId).toBe('abc123');
    });

    it('costSource defaults to actual when not provided', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
      });

      const e = readEvents(path)[0] as Record<string, unknown>;
      expect(e.costSource).toBe('actual');
    });

    it('costSource unknown is recorded for subscription mode', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 100, outputTokens: 50,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: null, durationMs: 0, success: true,
          costSource: 'unknown',
          pricingModel: 'subscription-claude-code-sdk',
        });
      });

      const e = readEvents(path)[0] as Record<string, unknown>;
      expect(e.costUsd).toBeNull();
      expect(e.costSource).toBe('unknown');
      expect(e.pricingModel).toBe('subscription-claude-code-sdk');
    });

    it('pricingModel provenance is recorded', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0.01, durationMs: 0, success: true,
          pricingModel: 'api-token-based',
        });
      });

      const e = readEvents(path)[0] as Record<string, unknown>;
      expect(e.pricingModel).toBe('api-token-based');
    });

    it('composer replaces axis in the event schema', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        runWithContext({ phase: 'review', composer: 'axes.utility' }, () => {
          recordLlmCall({
            provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            costUsd: 0, durationMs: 0, success: true,
          });
        });
      });

      const e = readEvents(path)[0] as Record<string, unknown>;
      expect(e.composer).toBe('axes.utility');
      expect('axis' in e).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveSinkTotals
  // -------------------------------------------------------------------------

  describe('getActiveSinkTotals', () => {
    it('returns undefined outside any sink scope', () => {
      expect(getActiveSinkTotals()).toBeUndefined();
    });

    it('starts at zero and accumulates each recordLlmCall', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        expect(getActiveSinkTotals()).toEqual({
          calls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
        });

        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 100, outputTokens: 50,
          cacheReadTokens: 200, cacheCreationTokens: 5,
          costUsd: 0.01, durationMs: 100, success: true,
        });
        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 30, outputTokens: 10,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0.002, durationMs: 50, success: true,
        });

        expect(getActiveSinkTotals()).toEqual({
          calls: 2,
          inputTokens: 130,
          outputTokens: 60,
          cacheReadTokens: 200,
          cacheCreationTokens: 5,
          costUsd: 0.012,
        });
      });
    });

    it('skips null costUsd in accumulation (subscription mode)', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 100, outputTokens: 50,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: null, durationMs: 0, success: true,
          costSource: 'unknown',
        });
        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 50, outputTokens: 25,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0.01, durationMs: 0, success: true,
        });

        const totals = getActiveSinkTotals()!;
        expect(totals.calls).toBe(2);
        expect(totals.inputTokens).toBe(150);
        expect(totals.costUsd).toBe(0.01); // null was skipped
      });
    });

    it('returns a snapshot that is decoupled from later mutations', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
        const snapshot = getActiveSinkTotals();
        recordLlmCall({
          provider: 'a', model: 'm', inputTokens: 99, outputTokens: 99,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
        expect(snapshot?.inputTokens).toBe(1);
        expect(getActiveSinkTotals()?.inputTokens).toBe(100);
      });
    });
  });

  // -------------------------------------------------------------------------
  // recordPlanEstimate
  // -------------------------------------------------------------------------

  describe('recordPlanEstimate', () => {
    it('writes an estimate record with planId and costSource estimated', () => {
      const path = join(dir, 'costs', 'ledger.ndjson');
      withLlmCallSink(path, () => {
        recordPlanEstimate({
          phase: 'review',
          composer: 'axes.utility',
          stepId: 'eval',
          primitive: 'axes.utility',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          pricingModel: 'api-token-based',
          inputTokens: 2000,
          outputTokens: 400,
          costUsd: 0.012,
        });
      });

      const events = readEvents(path);
      expect(events).toHaveLength(1);
      const e = events[0] as Record<string, unknown>;
      expect(e.planId).toBe('plan-review-axes.utility-eval');
      expect(e.costSource).toBe('estimated');
      expect(e.phase).toBe('review');
      expect(e.composer).toBe('axes.utility');
      expect(e.primitive).toBe('axes.utility');
      expect(e.pricingModel).toBe('api-token-based');
      expect(e.costUsd).toBe(0.012);
      expect(e.callId).toBeUndefined();
    });

    it('is a no-op outside any sink scope', () => {
      expect(() =>
        recordPlanEstimate({
          phase: 'review', composer: 'axes.utility', stepId: 'eval',
          primitive: 'axes.utility', provider: 'anthropic',
          model: 'm', pricingModel: 'api-token-based',
          inputTokens: 0, outputTokens: 0, costUsd: 0,
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // writeCostSummary
  // -------------------------------------------------------------------------

  describe('writeCostSummary', () => {
    it('aggregates actual calls by phase, composer, primitive, provider, model', () => {
      const runDir = join(dir, 'run1');
      const ledger = join(runDir, 'costs', 'ledger.ndjson');

      withLlmCallSink(ledger, () => {
        // Two calls in different phases/composers
        runWithContext({ phase: 'review', composer: 'axes.utility', primitive: 'axes.utility' }, () => {
          recordLlmCall({
            provider: 'anthropic', model: 'sonnet',
            inputTokens: 100, outputTokens: 50,
            cacheReadTokens: 10, cacheCreationTokens: 0,
            costUsd: 0.01, durationMs: 100, success: true,
          });
        });

        runWithContext({ phase: 'review', composer: 'axes.duplication', primitive: 'axes.duplication' }, () => {
          recordLlmCall({
            provider: 'anthropic', model: 'haiku',
            inputTokens: 80, outputTokens: 30,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            costUsd: 0.002, durationMs: 50, success: true,
          });
        });

        // An estimate (should NOT be included in summary)
        recordPlanEstimate({
          phase: 'review', composer: 'axes.utility', stepId: 'eval',
          primitive: 'axes.utility', provider: 'anthropic',
          model: 'sonnet', pricingModel: 'api-token-based',
          inputTokens: 2000, outputTokens: 400, costUsd: 0.05,
        });
      });

      writeCostSummary(runDir);

      const summaryPath = join(runDir, 'costs', 'summary.json');
      expect(existsSync(summaryPath)).toBe(true);

      const summary: CostSummary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

      // byPhase: both calls are in 'review'
      expect(summary.byPhase.review.callCount).toBe(2);
      expect(summary.byPhase.review.totalUsd).toBeCloseTo(0.012);

      // byComposer
      expect(summary.byComposer['axes.utility'].callCount).toBe(1);
      expect(summary.byComposer['axes.duplication'].callCount).toBe(1);

      // byProvider
      expect(summary.byProvider.anthropic.callCount).toBe(2);

      // byModel
      expect(summary.byModel.sonnet.callCount).toBe(1);
      expect(summary.byModel.haiku.callCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // writeCostVariance
  // -------------------------------------------------------------------------

  describe('writeCostVariance', () => {
    it('joins estimates against actuals and computes deviation', () => {
      const runDir = join(dir, 'run2');
      const ledger = join(runDir, 'costs', 'ledger.ndjson');

      withLlmCallSink(ledger, () => {
        // Record estimate
        recordPlanEstimate({
          phase: 'review', composer: 'axes.utility', stepId: 'eval',
          primitive: 'axes.utility', provider: 'anthropic',
          model: 'sonnet', pricingModel: 'api-token-based',
          inputTokens: 2000, outputTokens: 400, costUsd: 0.05,
        });

        // Record actual (double the estimated cost)
        runWithContext({ phase: 'review', composer: 'axes.utility', primitive: 'axes.utility' }, () => {
          recordLlmCall({
            provider: 'anthropic', model: 'sonnet',
            inputTokens: 3000, outputTokens: 600,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            costUsd: 0.10, durationMs: 200, success: true,
          });
        });
      });

      writeCostVariance(runDir);

      const variancePath = join(runDir, 'costs', 'variance.json');
      expect(existsSync(variancePath)).toBe(true);

      const variance: CostVariance = JSON.parse(readFileSync(variancePath, 'utf-8'));

      // byComposer: axes.utility estimated $0.05, actual $0.10 → +100%
      expect(variance.byComposer['axes.utility'].estimatedUsd).toBeCloseTo(0.05);
      expect(variance.byComposer['axes.utility'].actualUsd).toBeCloseTo(0.10);
      expect(variance.byComposer['axes.utility'].deviationPct).toBeCloseTo(100);

      // byPhase: review estimated $0.05, actual $0.10 → +100%
      expect(variance.byPhase.review.estimatedUsd).toBeCloseTo(0.05);
      expect(variance.byPhase.review.actualUsd).toBeCloseTo(0.10);
      expect(variance.byPhase.review.deviationPct).toBeCloseTo(100);
    });

    it('handles zero estimates gracefully (deviationPct = 0)', () => {
      const runDir = join(dir, 'run3');
      const ledger = join(runDir, 'costs', 'ledger.ndjson');

      withLlmCallSink(ledger, () => {
        // Actual call with no matching estimate
        runWithContext({ phase: 'review', composer: 'axes.tests' }, () => {
          recordLlmCall({
            provider: 'anthropic', model: 'sonnet',
            inputTokens: 100, outputTokens: 50,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            costUsd: 0.01, durationMs: 100, success: true,
          });
        });
      });

      writeCostVariance(runDir);
      const variance: CostVariance = JSON.parse(
        readFileSync(join(runDir, 'costs', 'variance.json'), 'utf-8'),
      );

      expect(variance.byComposer['axes.tests'].estimatedUsd).toBe(0);
      expect(variance.byComposer['axes.tests'].actualUsd).toBeCloseTo(0.01);
      expect(variance.byComposer['axes.tests'].deviationPct).toBe(0);
    });
  });
});
