// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';
import type { Config } from '../../../../schemas/config.js';

// ---------------------------------------------------------------------------
// Primitive identity
// ---------------------------------------------------------------------------

export type PrimitiveType = 'single-turn' | 'agentic';

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

export interface CostEstimateInput {
  /** Approximate input size in characters. */
  inputChars?: number;
  /** Number of items to process (files, cards, pages, etc.). */
  itemCount?: number;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Four-block contract
// ---------------------------------------------------------------------------

/** D.1 — Typed response / exchange output. */
export interface ResponseBlock {
  /** Raw response schema from the LLM. */
  schema: z.ZodTypeAny;
  /** Purified D.1 output schema (no prompt, cost, or cache fields). */
  outputSchema: z.ZodTypeAny;
  /** Optional retry configuration. */
  retry?: { maxRetries: number };
}

/** D.2 — Conversation dump. */
export interface DumpBlock {
  enabled: boolean;
  format: 'markdown' | 'json';
  /** Template: `{runDir}/conversations/{phase}__{composer}__{primitive}__{callId}.{ext}` */
  location: string;
  redactions?: string[];
}

/** D.3 — Structured log event fields. */
export interface LogBlock {
  extraFields?: Record<string, string>;
}

/** D.4 — Cost ledger metadata. */
export interface CostBlock {
  pricingModel: KnownPricingModel;
  capture: 'actual' | 'unknown';
}

// ---------------------------------------------------------------------------
// Optional blocks
// ---------------------------------------------------------------------------

export interface CacheDescriptor {
  strategy: 'none' | 'content-hash' | 'prompt-hash';
  location?: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// PrimitiveEntry — the registry contract
// ---------------------------------------------------------------------------

export interface PrimitiveEntry {
  /** Unique name matching the map key (e.g. `axes.utility`). */
  name: string;
  type: PrimitiveType;
  /** Resolves the model ID from the project config. */
  modelResolver: (cfg: Config) => string;
  /** Describes how prompts are constructed. */
  prompt: { kind: 'builder' } | { kind: 'template'; path: string };
  /** Pre-flight cost estimation. */
  estimateCost: (input: CostEstimateInput) => CostEstimate;
  /** D.1 — response / exchange contract. */
  response: ResponseBlock;
  /** D.2 — conversation dump contract. */
  dump: DumpBlock;
  /** D.3 — structured log contract. */
  log: LogBlock;
  /** D.4 — cost ledger contract. */
  cost: CostBlock;
  /** Agent tools (agentic primitives only). */
  tools?: ToolDescriptor[];
  /** Cache strategy. */
  cache?: CacheDescriptor;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KNOWN_PRICING_MODELS = ['api-token-based'] as const;
export type KnownPricingModel = (typeof KNOWN_PRICING_MODELS)[number];

/** Fields that must never appear in a D.1 outputSchema declaration. */
export const FORBIDDEN_OUTPUT_FIELDS = [
  'prompt',
  'system',
  'userMessage',
  'toolTurns',
  'durationMs',
  'costUsd',
  'cacheReadTokens',
  'cacheCreationTokens',
  'cacheWriteTokens',
] as const;

/** Canonical dump location template for all primitives. */
export const DUMP_LOCATION_TEMPLATE =
  '{runDir}/conversations/{phase}__{composer}__{primitive}__{callId}.{ext}';
