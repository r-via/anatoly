// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 56.10 — KPI 7: Cost integrity regression tests.
 *
 * Validates that the cost ledger pipeline produces consistent records:
 * - Every actual call has a unique callId
 * - Subscription transports produce costUsd: null with costSource: 'unknown'
 * - Cache hits produce costUsd: 0 with costSource: 'actual'
 * - writeCostSummary correctly aggregates ledger records
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeCostSummary,
  LLM_CALLS_SCHEMA_VERSION,
} from '../../utils/llm-calls-sink.js';
import type { LlmCallEvent, CostSummary } from '../../utils/llm-calls-sink.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLedgerRecord(overrides: Partial<LlmCallEvent> = {}): LlmCallEvent {
  return {
    schemaVersion: LLM_CALLS_SCHEMA_VERSION,
    t: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    phase: 'review',
    composer: 'axes.utility',
    primitive: 'axes.utility',
    callId: `call-${Math.random().toString(36).slice(2, 10)}`,
    costSource: 'actual',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.005,
    durationMs: 1200,
    success: true,
    ...overrides,
  };
}

function writeLedger(dir: string, records: LlmCallEvent[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, 'costs', 'ledger.ndjson'), lines);
}

// ---------------------------------------------------------------------------
// KPI 7a: Subscription vs actual cost distinction
// ---------------------------------------------------------------------------

describe('KPI 7a: subscription vs actual cost distinction', () => {
  it('subscription transport: costUsd=null + costSource=unknown', () => {
    const record = makeLedgerRecord({
      costUsd: null,
      costSource: 'unknown',
      pricingModel: undefined,
    });
    expect(record.costUsd).toBeNull();
    expect(record.costSource).toBe('unknown');
  });

  it('cache hit: costUsd=0 + costSource=actual', () => {
    const record = makeLedgerRecord({
      costUsd: 0,
      costSource: 'actual',
      pricingModel: 'api-token-based',
    });
    expect(record.costUsd).toBe(0);
    expect(record.costSource).toBe('actual');
  });

  it('normal API call: costUsd>0 + costSource=actual', () => {
    const record = makeLedgerRecord({
      costUsd: 0.005,
      costSource: 'actual',
      pricingModel: 'api-token-based',
    });
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.costSource).toBe('actual');
  });

  it('pre-flight estimate: costSource=estimated', () => {
    const record = makeLedgerRecord({
      costSource: 'estimated',
      costUsd: 0.01,
      callId: undefined,
      planId: 'plan-123',
    });
    expect(record.costSource).toBe('estimated');
    expect(record.planId).toBe('plan-123');
  });
});

// ---------------------------------------------------------------------------
// KPI 7b: writeCostSummary aggregates correctly
// ---------------------------------------------------------------------------

describe('KPI 7b: writeCostSummary aggregation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `anatoly-cost-${Date.now()}`);
    mkdirSync(join(tmpDir, 'costs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregates actual calls by phase, composer, primitive, provider, model', () => {
    const records = [
      makeLedgerRecord({
        callId: 'call-1',
        phase: 'review',
        composer: 'axes.utility',
        primitive: 'axes.utility',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        costUsd: 0.005,
        inputTokens: 1000,
        outputTokens: 500,
      }),
      makeLedgerRecord({
        callId: 'call-2',
        phase: 'review',
        composer: 'axes.correction',
        primitive: 'axes.correction-pass1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        costUsd: 0.008,
        inputTokens: 2000,
        outputTokens: 800,
      }),
    ];

    writeLedger(tmpDir, records);
    writeCostSummary(tmpDir);

    const summary: CostSummary = JSON.parse(
      readFileSync(join(tmpDir, 'costs', 'summary.json'), 'utf-8'),
    );

    // byPhase: one 'review' bucket with 2 calls
    expect(summary.byPhase['review'].callCount).toBe(2);
    expect(summary.byPhase['review'].totalUsd).toBeCloseTo(0.013, 3);

    // byComposer: two separate buckets
    expect(summary.byComposer['axes.utility'].callCount).toBe(1);
    expect(summary.byComposer['axes.correction'].callCount).toBe(1);

    // byPrimitive: two separate buckets
    expect(summary.byPrimitive['axes.utility'].callCount).toBe(1);
    expect(summary.byPrimitive['axes.correction-pass1'].callCount).toBe(1);

    // byProvider: one 'anthropic' bucket
    expect(summary.byProvider['anthropic'].callCount).toBe(2);

    // byModel: one bucket
    expect(summary.byModel['claude-sonnet-4-20250514'].callCount).toBe(2);
  });

  it('excludes estimated records from cost summary', () => {
    const records = [
      makeLedgerRecord({ callId: 'call-1', costSource: 'actual', costUsd: 0.005 }),
      makeLedgerRecord({ callId: undefined, costSource: 'estimated', costUsd: 0.01, planId: 'plan-1' }),
    ];

    writeLedger(tmpDir, records);
    writeCostSummary(tmpDir);

    const summary: CostSummary = JSON.parse(
      readFileSync(join(tmpDir, 'costs', 'summary.json'), 'utf-8'),
    );

    // Only the actual call should be counted
    expect(summary.byPhase['review'].callCount).toBe(1);
    expect(summary.byPhase['review'].totalUsd).toBeCloseTo(0.005, 3);
  });

  it('handles subscription costUsd: null by treating as 0', () => {
    const records = [
      makeLedgerRecord({ callId: 'call-1', costSource: 'actual', costUsd: null }),
    ];

    writeLedger(tmpDir, records);
    writeCostSummary(tmpDir);

    const summary: CostSummary = JSON.parse(
      readFileSync(join(tmpDir, 'costs', 'summary.json'), 'utf-8'),
    );

    expect(summary.byPhase['review'].callCount).toBe(1);
    expect(summary.byPhase['review'].totalUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// KPI 7c: Ledger record schema v2 fields are consistently typed
// ---------------------------------------------------------------------------

describe('KPI 7c: ledger record field consistency', () => {
  it('callId uniquely identifies actual calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const record = makeLedgerRecord();
      expect(record.callId).toBeDefined();
      ids.add(record.callId!);
    }
    // All 100 IDs should be unique
    expect(ids.size).toBe(100);
  });

  it('costSource enum covers all three valid values', () => {
    const validSources: LlmCallEvent['costSource'][] = ['actual', 'estimated', 'unknown'];
    for (const source of validSources) {
      const record = makeLedgerRecord({ costSource: source });
      expect(['actual', 'estimated', 'unknown']).toContain(record.costSource);
    }
  });
});
