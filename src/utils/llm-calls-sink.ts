// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Per-call LLM event sink (schema v2). Persists every LLM call and pre-flight
 * estimate as one JSON line to `.anatoly/runs/<runId>/costs/ledger.ndjson`.
 * The file is the bit-perfect source of truth for replay, cost analysis,
 * summary aggregation, and estimate-vs-actual variance computation.
 *
 * Scoping is via AsyncLocalStorage: the run command wraps its body in
 * {@link withLlmCallSink}, transports anywhere in the call tree call
 * {@link recordLlmCall} which finds the sink through the ALS context. Calls
 * made outside any active sink are silently dropped.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getLogContext } from './log-context.js';
import { costsLedgerPath, costsSummaryPath, costsVariancePath } from './run-layout.js';

// ---------------------------------------------------------------------------
// Schema v2
// ---------------------------------------------------------------------------

/**
 * One persisted LLM call / estimate record. Append-only; existing fields are
 * stable within a {@link LLM_CALLS_SCHEMA_VERSION} value.
 */
export interface LlmCallEvent {
  schemaVersion: typeof LLM_CALLS_SCHEMA_VERSION;
  /** Milliseconds since the sink was opened. */
  t: number;
  provider: string;
  model: string;
  /** Pipeline phase (from log context). */
  phase?: string;
  /** Composer name (from log context). */
  composer?: string;
  /** Primitive name (from log context). */
  primitive?: string;
  /** Short UUID identifying this specific call. */
  callId?: string;
  /** Identifier for a pre-flight estimate record. */
  planId?: string;
  /** Whether this record is an actual call, a pre-flight estimate, or unknown. */
  costSource: 'actual' | 'estimated' | 'unknown';
  /** Pricing model provenance (e.g. 'api-token-based', 'subscription-claude-code-sdk'). */
  pricingModel?: string;
  /** The estimated cost that was predicted for this call. */
  estimatedUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Actual cost, or null when the provider is subscription-based. */
  costUsd: number | null;
  durationMs: number;
  /** 1-based retry attempt number. */
  attempt?: number;
  success: boolean;
  retryReason?: string;
  error?: { code: string; message: string };
  /** Path of the conversation dump, relative to the run dir. */
  conversationFile?: string;
}

export const LLM_CALLS_SCHEMA_VERSION = 2 as const;

/**
 * Fields the caller must supply. The sink fills in `schemaVersion`, `t`,
 * and pulls `phase`/`composer`/`primitive` from the log context.
 * `costSource` defaults to `'actual'` when not provided.
 */
export type LlmCallInput = Omit<
  LlmCallEvent,
  'schemaVersion' | 't' | 'phase' | 'composer' | 'primitive' | 'costSource'
> & {
  costSource?: 'actual' | 'estimated' | 'unknown';
};

// ---------------------------------------------------------------------------
// Plan estimate input
// ---------------------------------------------------------------------------

/** Input for recording a pre-flight cost estimate. */
export interface PlanEstimateInput {
  phase: string;
  composer: string;
  stepId: string;
  primitive: string;
  provider: string;
  model: string;
  pricingModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage-backed sink context
// ---------------------------------------------------------------------------

/**
 * Running totals updated on every {@link recordLlmCall}. Lets the run
 * summary render token counts without re-reading the ndjson file.
 */
export interface LlmCallTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

interface SinkContext {
  filePath: string;
  startTime: number;
  totals: LlmCallTotals;
  /** In-memory estimate index for matching actuals to their estimates. */
  estimates: Map<string, { planId: string; costUsd: number }>;
}

const als = new AsyncLocalStorage<SinkContext>();

/**
 * Open a sink scope. Every {@link recordLlmCall} made within `fn` (sync or
 * async, including descendants) appends to `filePath`. The parent directory
 * is created if missing.
 */
export function withLlmCallSink<T>(filePath: string, fn: () => T): T {
  mkdirSync(dirname(filePath), { recursive: true });
  return als.run(
    { filePath, startTime: Date.now(), totals: emptyTotals(), estimates: new Map() },
    fn,
  );
}

/**
 * Imperative variant: opens the sink for the remainder of the current async
 * chain. Use this at the top of a long-lived run body where wrapping the
 * whole body in a callback would force a massive re-indent.
 */
export function enterLlmCallSink(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  als.enterWith({
    filePath,
    startTime: Date.now(),
    totals: emptyTotals(),
    estimates: new Map(),
  });
}

function emptyTotals(): LlmCallTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

/**
 * Append one LLM call record to the active sink. No-op when called outside
 * any {@link withLlmCallSink} scope. Never throws.
 */
export function recordLlmCall(event: LlmCallInput): void {
  const sinkCtx = als.getStore();
  if (!sinkCtx) return;

  const logCtx = getLogContext();
  const costSource = event.costSource ?? 'actual';

  // Look up estimated cost if this call has a matching estimate
  let estimatedUsd = event.estimatedUsd;
  if (estimatedUsd === undefined && logCtx?.composer && logCtx?.primitive) {
    const key = `${logCtx.phase ?? ''}-${logCtx.composer}-${logCtx.primitive}`;
    const est = sinkCtx.estimates.get(key);
    if (est) estimatedUsd = est.costUsd;
  }

  const enriched: LlmCallEvent = {
    schemaVersion: LLM_CALLS_SCHEMA_VERSION,
    t: Date.now() - sinkCtx.startTime,
    ...(logCtx?.phase ? { phase: logCtx.phase } : {}),
    ...(logCtx?.composer ? { composer: logCtx.composer } : {}),
    ...(logCtx?.primitive ? { primitive: logCtx.primitive } : {}),
    ...event,
    costSource,
    ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
  };

  // Update in-memory aggregates. Skip null costUsd values (subscription mode).
  sinkCtx.totals.calls += 1;
  sinkCtx.totals.inputTokens += event.inputTokens;
  sinkCtx.totals.outputTokens += event.outputTokens;
  sinkCtx.totals.cacheReadTokens += event.cacheReadTokens;
  sinkCtx.totals.cacheCreationTokens += event.cacheCreationTokens;
  if (event.costUsd !== null) {
    sinkCtx.totals.costUsd += event.costUsd;
  }

  try {
    appendFileSync(sinkCtx.filePath, JSON.stringify(enriched) + '\n');
  } catch {
    // Intentionally swallowed: the run continues even if the sink can't write.
  }
}

/**
 * Record a pre-flight cost estimate. The estimate is persisted to the ledger
 * and indexed in memory so that subsequent actual calls can report their
 * deviation from the estimate.
 */
export function recordPlanEstimate(estimate: PlanEstimateInput): void {
  const sinkCtx = als.getStore();
  if (!sinkCtx) return;

  const planId = `plan-${estimate.phase}-${estimate.composer}-${estimate.stepId}`;

  const record: LlmCallEvent = {
    schemaVersion: LLM_CALLS_SCHEMA_VERSION,
    t: Date.now() - sinkCtx.startTime,
    provider: estimate.provider,
    model: estimate.model,
    phase: estimate.phase,
    composer: estimate.composer,
    primitive: estimate.primitive,
    planId,
    costSource: 'estimated',
    pricingModel: estimate.pricingModel,
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: estimate.costUsd,
    durationMs: 0,
    success: true,
  };

  // Index for later actual-vs-estimate matching
  const key = `${estimate.phase}-${estimate.composer}-${estimate.primitive}`;
  sinkCtx.estimates.set(key, { planId, costUsd: estimate.costUsd });

  try {
    appendFileSync(sinkCtx.filePath, JSON.stringify(record) + '\n');
  } catch {
    // Swallowed
  }
}

/** Return the absolute file path of the active sink, or `undefined` outside any scope. */
export function getActiveSinkPath(): string | undefined {
  return als.getStore()?.filePath;
}

/**
 * Return a snapshot of the running totals for the active sink. Returns
 * `undefined` when no sink is open.
 */
export function getActiveSinkTotals(): Readonly<LlmCallTotals> | undefined {
  const store = als.getStore();
  if (!store) return undefined;
  return { ...store.totals };
}

// ---------------------------------------------------------------------------
// Run-end writers
// ---------------------------------------------------------------------------

/** Shape of one aggregation bucket in the cost summary. */
export interface CostBucket {
  totalUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  callCount: number;
}

/** Schema of the cost summary file written at run end. */
export interface CostSummary {
  byPhase: Record<string, CostBucket>;
  byComposer: Record<string, CostBucket>;
  byPrimitive: Record<string, CostBucket>;
  byProvider: Record<string, CostBucket>;
  byModel: Record<string, CostBucket>;
}

/** Schema of one variance entry. */
export interface VarianceEntry {
  estimatedUsd: number;
  actualUsd: number;
  deviationPct: number;
}

/** Schema of the cost variance file written at run end. */
export interface CostVariance {
  byComposer: Record<string, VarianceEntry>;
  byPhase: Record<string, VarianceEntry>;
}

/**
 * Read the cost ledger NDJSON at `{runDir}/costs/ledger.ndjson`, compute
 * aggregations grouped by phase, composer, primitive, provider, and model,
 * then write `{runDir}/costs/summary.json`.
 */
export function writeCostSummary(runDir: string): void {
  const ledgerPath = costsLedgerPath(runDir);
  const records = readLedger(ledgerPath);

  // Aggregate actual + unknown calls (skip estimates — those go in variance.json).
  // `unknown` records come from subscription-mode transports where the provider
  // does not return a cost; tokens are still reported and we want them counted.
  // costUsd is null on those records, treated as 0 in totalUsd (no fiction).
  const actuals = records.filter((r) => r.costSource === 'actual' || r.costSource === 'unknown');

  const summary: CostSummary = {
    byPhase: {},
    byComposer: {},
    byPrimitive: {},
    byProvider: {},
    byModel: {},
  };

  for (const r of actuals) {
    const cost = r.costUsd ?? 0;
    accumulateBucket(summary.byPhase, r.phase ?? 'unknown', r, cost);
    accumulateBucket(summary.byComposer, r.composer ?? 'unknown', r, cost);
    accumulateBucket(summary.byPrimitive, r.primitive ?? 'unknown', r, cost);
    accumulateBucket(summary.byProvider, r.provider, r, cost);
    accumulateBucket(summary.byModel, r.model, r, cost);
  }

  const outPath = costsSummaryPath(runDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
}

function accumulateBucket(
  buckets: Record<string, CostBucket>,
  key: string,
  r: LlmCallEvent,
  cost: number,
): void {
  const b = (buckets[key] ??= {
    totalUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    callCount: 0,
  });
  b.totalUsd += cost;
  b.totalInputTokens += r.inputTokens;
  b.totalOutputTokens += r.outputTokens;
  b.totalCacheReadTokens += r.cacheReadTokens;
  b.callCount += 1;
}

/**
 * Read the cost ledger, join actuals against estimates by matching
 * `primitive` + `composer`, compute deviation per composer and per phase,
 * then write `{runDir}/costs/variance.json`.
 */
export function writeCostVariance(runDir: string): void {
  const ledgerPath = costsLedgerPath(runDir);
  const records = readLedger(ledgerPath);

  const estimates = records.filter((r) => r.costSource === 'estimated');
  // Include `unknown` (subscription-mode) actuals — null costUsd treated as 0 below
  const actuals = records.filter((r) => r.costSource === 'actual' || r.costSource === 'unknown');

  // Index estimates by composer+primitive for matching
  const estByKey = new Map<string, { costUsd: number; phase: string; composer: string }>();
  for (const e of estimates) {
    const key = `${e.composer ?? ''}-${e.primitive ?? ''}`;
    const existing = estByKey.get(key);
    estByKey.set(key, {
      costUsd: (existing?.costUsd ?? 0) + (e.costUsd ?? 0),
      phase: e.phase ?? 'unknown',
      composer: e.composer ?? 'unknown',
    });
  }

  // Accumulate actuals by composer and phase
  const byComposer: Record<string, { estimated: number; actual: number }> = {};
  const byPhase: Record<string, { estimated: number; actual: number }> = {};

  for (const a of actuals) {
    const cost = a.costUsd ?? 0;
    const composerKey = a.composer ?? 'unknown';
    const phaseKey = a.phase ?? 'unknown';

    const cb = (byComposer[composerKey] ??= { estimated: 0, actual: 0 });
    cb.actual += cost;

    const pb = (byPhase[phaseKey] ??= { estimated: 0, actual: 0 });
    pb.actual += cost;
  }

  // Add estimate totals
  for (const est of estimates) {
    const composerKey = est.composer ?? 'unknown';
    const phaseKey = est.phase ?? 'unknown';
    const estCost = est.costUsd ?? 0;

    const cb = (byComposer[composerKey] ??= { estimated: 0, actual: 0 });
    cb.estimated += estCost;

    const pb = (byPhase[phaseKey] ??= { estimated: 0, actual: 0 });
    pb.estimated += estCost;
  }

  const variance: CostVariance = {
    byComposer: {},
    byPhase: {},
  };

  for (const [key, { estimated, actual }] of Object.entries(byComposer)) {
    variance.byComposer[key] = {
      estimatedUsd: estimated,
      actualUsd: actual,
      deviationPct: estimated > 0 ? ((actual - estimated) / estimated) * 100 : 0,
    };
  }

  for (const [key, { estimated, actual }] of Object.entries(byPhase)) {
    variance.byPhase[key] = {
      estimatedUsd: estimated,
      actualUsd: actual,
      deviationPct: estimated > 0 ? ((actual - estimated) / estimated) * 100 : 0,
    };
  }

  const outPath = costsVariancePath(runDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(variance, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readLedger(filePath: string): LlmCallEvent[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LlmCallEvent);
}
