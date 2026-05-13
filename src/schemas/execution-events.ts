// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * D.3 event vocabulary v1. Defines Zod schemas for 16 structured execution
 * events emitted by the orchestration runtime. Every schema carries
 * `event_version: 'v1'` and scope fields (`runId`, `phase`, `composer`,
 * `primitive`, `callId`) as applicable.
 */

import { z } from 'zod';

export const EVENT_VERSION = 'v1' as const;

// ---------------------------------------------------------------------------
// Base scope — fields carried by every execution event
// ---------------------------------------------------------------------------

const baseScope = {
  event_version: z.literal(EVENT_VERSION),
  runId: z.string().optional(),
  phase: z.string().optional(),
  composer: z.string().optional(),
  primitive: z.string().optional(),
  callId: z.string().optional(),
};

// ---------------------------------------------------------------------------
// Phase lifecycle
// ---------------------------------------------------------------------------

export const PhaseStartEvent = z.object({
  ...baseScope,
  event: z.literal('phase_start'),
  phase: z.string(),
});
export type PhaseStartEvent = z.infer<typeof PhaseStartEvent>;

export const PhaseEndEvent = z.object({
  ...baseScope,
  event: z.literal('phase_end'),
  phase: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
});
export type PhaseEndEvent = z.infer<typeof PhaseEndEvent>;

// ---------------------------------------------------------------------------
// Composer lifecycle
// ---------------------------------------------------------------------------

export const ComposerStartEvent = z.object({
  ...baseScope,
  event: z.literal('composer_start'),
  composer: z.string(),
});
export type ComposerStartEvent = z.infer<typeof ComposerStartEvent>;

export const ComposerEndEvent = z.object({
  ...baseScope,
  event: z.literal('composer_end'),
  composer: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
});
export type ComposerEndEvent = z.infer<typeof ComposerEndEvent>;

// ---------------------------------------------------------------------------
// Resource (LLM) call lifecycle
// ---------------------------------------------------------------------------

export const ResourceCallStartEvent = z.object({
  ...baseScope,
  event: z.literal('resource_call_start'),
  primitive: z.string(),
  provider: z.string(),
  model: z.string(),
});
export type ResourceCallStartEvent = z.infer<typeof ResourceCallStartEvent>;

export const ResourceCallEndEvent = z.object({
  ...baseScope,
  event: z.literal('resource_call_end'),
  primitive: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
  success: z.boolean(),
});
export type ResourceCallEndEvent = z.infer<typeof ResourceCallEndEvent>;

export const ResourceCallErrorEvent = z.object({
  ...baseScope,
  event: z.literal('resource_call_error'),
  provider: z.string(),
  model: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ResourceCallErrorEvent = z.infer<typeof ResourceCallErrorEvent>;

// ---------------------------------------------------------------------------
// Cache events
// ---------------------------------------------------------------------------

export const CacheHitEvent = z.object({
  ...baseScope,
  event: z.literal('cache_hit'),
  key: z.string().optional(),
});
export type CacheHitEvent = z.infer<typeof CacheHitEvent>;

export const CacheMissEvent = z.object({
  ...baseScope,
  event: z.literal('cache_miss'),
  key: z.string().optional(),
});
export type CacheMissEvent = z.infer<typeof CacheMissEvent>;

// ---------------------------------------------------------------------------
// Validation & retry
// ---------------------------------------------------------------------------

export const ValidationFailEvent = z.object({
  ...baseScope,
  event: z.literal('validation_fail'),
  stepId: z.string().optional(),
  details: z.string().optional(),
});
export type ValidationFailEvent = z.infer<typeof ValidationFailEvent>;

export const RetryAttemptEvent = z.object({
  ...baseScope,
  event: z.literal('retry_attempt'),
  attempt: z.number(),
  reason: z.string().optional(),
});
export type RetryAttemptEvent = z.infer<typeof RetryAttemptEvent>;

// ---------------------------------------------------------------------------
// Exchange operations
// ---------------------------------------------------------------------------

export const ExchangeWriteEvent = z.object({
  ...baseScope,
  event: z.literal('exchange_write'),
  stepId: z.string(),
});
export type ExchangeWriteEvent = z.infer<typeof ExchangeWriteEvent>;

export const ExchangeReadEvent = z.object({
  ...baseScope,
  event: z.literal('exchange_read'),
  stepId: z.string(),
});
export type ExchangeReadEvent = z.infer<typeof ExchangeReadEvent>;

// ---------------------------------------------------------------------------
// Step lifecycle
// ---------------------------------------------------------------------------

export const StepSkippedEvent = z.object({
  ...baseScope,
  event: z.literal('step_skipped'),
  stepId: z.string(),
  reason: z.string().optional(),
});
export type StepSkippedEvent = z.infer<typeof StepSkippedEvent>;

// ---------------------------------------------------------------------------
// Plan & actuals
// ---------------------------------------------------------------------------

export const PlanEmittedEvent = z.object({
  ...baseScope,
  event: z.literal('plan_emitted'),
  composer: z.string(),
  stepCount: z.number().optional(),
});
export type PlanEmittedEvent = z.infer<typeof PlanEmittedEvent>;

export const ActualsEmittedEvent = z.object({
  ...baseScope,
  event: z.literal('actuals_emitted'),
  composer: z.string(),
  totalCostUsd: z.number().nullable().optional(),
});
export type ActualsEmittedEvent = z.infer<typeof ActualsEmittedEvent>;

// ---------------------------------------------------------------------------
// Union & canonical list
// ---------------------------------------------------------------------------

export const ExecutionEvent = z.discriminatedUnion('event', [
  PhaseStartEvent,
  PhaseEndEvent,
  ComposerStartEvent,
  ComposerEndEvent,
  ResourceCallStartEvent,
  ResourceCallEndEvent,
  ResourceCallErrorEvent,
  CacheHitEvent,
  CacheMissEvent,
  ValidationFailEvent,
  RetryAttemptEvent,
  ExchangeWriteEvent,
  ExchangeReadEvent,
  StepSkippedEvent,
  PlanEmittedEvent,
  ActualsEmittedEvent,
]);
export type ExecutionEventType = z.infer<typeof ExecutionEvent>;

/** Canonical event names for programmatic use. */
export const EXECUTION_EVENT_NAMES = [
  'phase_start',
  'phase_end',
  'composer_start',
  'composer_end',
  'resource_call_start',
  'resource_call_end',
  'resource_call_error',
  'cache_hit',
  'cache_miss',
  'validation_fail',
  'retry_attempt',
  'exchange_write',
  'exchange_read',
  'step_skipped',
  'plan_emitted',
  'actuals_emitted',
] as const;
