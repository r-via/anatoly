// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Per-call LLM event sink. Persists every LLM call (success or failure) as
 * one JSON line to `.anatoly/runs/<runId>/llm-calls.ndjson`. The file is the
 * bit-perfect source of truth for replay (e.g. `anatoly estimate <runId>`)
 * and for retroactive analysis (cost outliers, retry storms, axis budgets).
 *
 * Scoping is via AsyncLocalStorage: the run command wraps its body in
 * {@link withLlmCallSink}, transports anywhere in the call tree call
 * {@link recordLlmCall} which finds the sink through the ALS context. Calls
 * made outside any active sink are silently dropped — convenient for tests
 * and ad-hoc tool invocations that don't open a run.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogContext } from './log-context.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One persisted LLM call record. Append-only; existing fields are stable
 * within a {@link LLM_CALLS_SCHEMA_VERSION} value. New optional fields may
 * be added without bumping the version; semantic changes to existing fields
 * require a bump.
 */
export interface LlmCallEvent {
  schemaVersion: typeof LLM_CALLS_SCHEMA_VERSION;
  /** Milliseconds since the sink was opened (≈ run start). */
  t: number;
  provider: string;
  model: string;
  /** Pipeline phase, when known via the log context (e.g. 'review', 'rag-index'). */
  phase?: string;
  /** Axis id, when this call belongs to one (e.g. 'utility'). */
  axis?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  /** 1-based retry attempt number. */
  attempt?: number;
  success: boolean;
  retryReason?: string;
  error?: { code: string; message: string };
  /** Path of the conversation dump, relative to the run dir. */
  conversationFile?: string;
}

export const LLM_CALLS_SCHEMA_VERSION = 1 as const;

/** Fields the caller must supply. The sink fills in `schemaVersion`, `t`, and pulls `phase`/`axis` from the log context. */
export type LlmCallInput = Omit<LlmCallEvent, 'schemaVersion' | 't' | 'phase' | 'axis'>;

// ---------------------------------------------------------------------------
// AsyncLocalStorage-backed sink context
// ---------------------------------------------------------------------------

interface SinkContext {
  filePath: string;
  startTime: number;
}

const als = new AsyncLocalStorage<SinkContext>();

/**
 * Open a sink scope. Every {@link recordLlmCall} made within `fn` (sync or
 * async, including descendants) appends to `filePath`. The parent directory
 * is created if missing.
 *
 * Nested calls override the parent — useful only for tests; production code
 * has exactly one outer scope per run.
 */
export function withLlmCallSink<T>(filePath: string, fn: () => T): T {
  mkdirSync(dirname(filePath), { recursive: true });
  return als.run({ filePath, startTime: Date.now() }, fn);
}

/**
 * Imperative variant: opens the sink for the remainder of the current async
 * chain. Use this at the top of a long-lived run body where wrapping the
 * whole body in a {@link withLlmCallSink} callback would force a massive
 * re-indent. The sink is implicitly torn down when the process exits.
 *
 * Not safe to use multiple times in the same process — subsequent calls
 * shadow the previous sink for downstream async work but the previous
 * sink's ALS context survives in any in-flight chains. Tests should prefer
 * {@link withLlmCallSink}.
 */
export function enterLlmCallSink(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  als.enterWith({ filePath, startTime: Date.now() });
}

/**
 * Append one LLM call record to the active sink. No-op when called outside
 * any {@link withLlmCallSink} scope. Never throws — write failures are
 * swallowed so logging cannot abort a run.
 */
export function recordLlmCall(event: LlmCallInput): void {
  const sinkCtx = als.getStore();
  if (!sinkCtx) return;

  const logCtx = getLogContext();
  const enriched: LlmCallEvent = {
    schemaVersion: LLM_CALLS_SCHEMA_VERSION,
    t: Date.now() - sinkCtx.startTime,
    ...(logCtx?.phase ? { phase: logCtx.phase } : {}),
    ...(logCtx?.axis ? { axis: logCtx.axis } : {}),
    ...event,
  };

  try {
    // Single appendFileSync with O_APPEND is atomic for writes ≤ PIPE_BUF
    // (typically 4096 bytes on Linux). Our events are ~500 bytes, so we get
    // multi-process / multi-worker safety without a mutex.
    appendFileSync(sinkCtx.filePath, JSON.stringify(enriched) + '\n');
  } catch {
    // Intentionally swallowed: the run continues even if the sink can't
    // write. The transport's contextLogger().info() call still emits the
    // event to the console/run log for live diagnostics.
  }
}

/** Return the absolute file path of the active sink, or `undefined` outside any scope. Useful for tests and tooling. */
export function getActiveSinkPath(): string | undefined {
  return als.getStore()?.filePath;
}
