// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 56.10 — KPI 2: Run-metrics schema v2 validation.
 *
 * Validates the LlmCallEvent schema, CostSummary, and CostVariance
 * interfaces structurally to ensure the contract is stable.
 */

import { describe, it, expect } from 'vitest';
import { CANONICAL_PHASES } from '../core/orchestration/run-phase.js';
import type {
  LlmCallEvent,
  CostSummary,
  CostVariance,
  CostBucket,
  VarianceEntry,
} from '../utils/llm-calls-sink.js';
import { LLM_CALLS_SCHEMA_VERSION } from '../utils/llm-calls-sink.js';

// ---------------------------------------------------------------------------
// KPI 2a: LlmCallEvent schema v2 has required fields
// ---------------------------------------------------------------------------

describe('KPI 2a: LlmCallEvent schema v2 field contract', () => {
  it('schema version is 2', () => {
    expect(LLM_CALLS_SCHEMA_VERSION).toBe(2);
  });

  it('LlmCallEvent type-checks with all required v2 fields', () => {
    // Compile-time assertion: if this compiles, the interface has the fields
    const event: LlmCallEvent = {
      schemaVersion: LLM_CALLS_SCHEMA_VERSION,
      t: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      phase: 'review',
      composer: 'axes.utility',
      primitive: 'axes.utility',
      callId: 'call-123',
      planId: 'plan-456',
      costSource: 'actual',
      pricingModel: 'api-token-based',
      estimatedUsd: 0.01,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      costUsd: 0.005,
      durationMs: 1200,
      attempt: 1,
      success: true,
      retryReason: undefined,
      error: undefined,
      conversationFile: 'conversations/review__axes.utility__call-123.md',
    };
    // Verify critical v2 fields exist
    expect(event.schemaVersion).toBe(2);
    expect(event.phase).toBe('review');
    expect(event.composer).toBe('axes.utility');
    expect(event.primitive).toBe('axes.utility');
    expect(event.callId).toBe('call-123');
    expect(event.planId).toBe('plan-456');
    expect(event.costSource).toBe('actual');
    expect(event.pricingModel).toBe('api-token-based');
    expect(event.estimatedUsd).toBe(0.01);
  });

  it('costUsd accepts null for subscription transports', () => {
    const event: LlmCallEvent = {
      schemaVersion: LLM_CALLS_SCHEMA_VERSION,
      t: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      costSource: 'unknown',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      durationMs: 1200,
      success: true,
    };
    expect(event.costUsd).toBeNull();
    expect(event.costSource).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// KPI 2b: CostSummary schema has required aggregation buckets
// ---------------------------------------------------------------------------

describe('KPI 2b: CostSummary schema contract', () => {
  it('CostSummary has all required bucket categories', () => {
    const summary: CostSummary = {
      byPhase: {},
      byComposer: {},
      byPrimitive: {},
      byProvider: {},
      byModel: {},
    };
    expect(summary).toHaveProperty('byPhase');
    expect(summary).toHaveProperty('byComposer');
    expect(summary).toHaveProperty('byPrimitive');
    expect(summary).toHaveProperty('byProvider');
    expect(summary).toHaveProperty('byModel');
  });

  it('CostBucket has all required numeric fields', () => {
    const bucket: CostBucket = {
      totalUsd: 0.05,
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      totalCacheReadTokens: 1000,
      callCount: 3,
    };
    expect(typeof bucket.totalUsd).toBe('number');
    expect(typeof bucket.totalInputTokens).toBe('number');
    expect(typeof bucket.totalOutputTokens).toBe('number');
    expect(typeof bucket.totalCacheReadTokens).toBe('number');
    expect(typeof bucket.callCount).toBe('number');
  });

  it('canonical phases can key into CostSummary.byPhase', () => {
    const summary: CostSummary = {
      byPhase: {},
      byComposer: {},
      byPrimitive: {},
      byProvider: {},
      byModel: {},
    };
    const bucket: CostBucket = {
      totalUsd: 0.01,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 0,
      callCount: 1,
    };
    // All canonical phases are valid keys in byPhase
    for (const phase of CANONICAL_PHASES) {
      summary.byPhase[phase] = bucket;
    }
    expect(Object.keys(summary.byPhase)).toHaveLength(CANONICAL_PHASES.length);
  });
});

// ---------------------------------------------------------------------------
// KPI 2c: CostVariance schema contract
// ---------------------------------------------------------------------------

describe('KPI 2c: CostVariance schema contract', () => {
  it('CostVariance has byComposer and byPhase buckets', () => {
    const variance: CostVariance = {
      byComposer: {},
      byPhase: {},
    };
    expect(variance).toHaveProperty('byComposer');
    expect(variance).toHaveProperty('byPhase');
  });

  it('VarianceEntry has estimatedUsd, actualUsd, deviationPct', () => {
    const entry: VarianceEntry = {
      estimatedUsd: 0.10,
      actualUsd: 0.08,
      deviationPct: -20,
    };
    expect(typeof entry.estimatedUsd).toBe('number');
    expect(typeof entry.actualUsd).toBe('number');
    expect(typeof entry.deviationPct).toBe('number');
  });
});
