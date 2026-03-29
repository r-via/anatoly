// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { UsageGraph } from './usage-graph.js';
import type { FileDependencyContext } from './dependency-meta.js';
import type { SimilarityResult } from '../rag/types.js';
import type { Action } from '../schemas/review.js';
import { resolveSystemPrompt } from './prompt-resolver.js';
import { formatSchemaExample } from '../utils/schema-example.js';
import { extractJson } from '../utils/extract-json.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { contextLogger } from '../utils/log-context.js';
import type { Semaphore } from './sdk-semaphore.js';
import type { GeminiCircuitBreaker } from './circuit-breaker.js';
import type { LlmTransport, LlmResponse } from './transports/index.js';
import { AnthropicTransport } from './transports/anthropic-transport.js';
import { GeminiTransport } from './transports/gemini-transport.js';
import { GeminiGenaiTransport } from './transports/gemini-genai-transport.js';

/** Module-level cache for Gemini transport instances, keyed by projectRoot.
 *  Avoids creating a new Config (and its `model-changed` listener) per call. */
const geminiTransportCache = new Map<string, LlmTransport>();

/** Gemini transport mode, set once at startup via {@link setGeminiTransportType}. */
let _geminiTransportMode: 'subscription' | 'api' = 'subscription';

/** Configure which Gemini transport backend to use. Call once at startup. */
export function setGeminiTransportType(mode: 'subscription' | 'api'): void {
  _geminiTransportMode = mode;
  geminiTransportCache.clear();
}

function getOrCreateGeminiTransport(projectRoot: string, model: string): LlmTransport {
  const existing = geminiTransportCache.get(projectRoot);
  if (existing) return existing;
  const transport = _geminiTransportMode === 'api'
    ? new GeminiGenaiTransport()
    : new GeminiTransport(projectRoot, model);
  geminiTransportCache.set(projectRoot, transport);
  return transport;
}

// ---------------------------------------------------------------------------
// Pre-resolved RAG types (moved from prompt-builder.ts)
// ---------------------------------------------------------------------------

/** A single pre-resolved RAG lookup for one symbol, mapping it to similarity results from the vector index. */
export interface PreResolvedRagEntry {
  symbolName: string;
  lineStart: number;
  lineEnd: number;
  /** null means the function was not found in the index */
  results: SimilarityResult[] | null;
}

export type PreResolvedRag = PreResolvedRagEntry[];

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the full system prompt for an axis evaluator.
 * Order: json-evaluator-wrapper → guard-rails → axis-specific prompt → schema example (if provided).
 * @param axisPrompt - The axis-specific system prompt text.
 * @param schema - Optional Zod schema; when provided, a formatted example is appended.
 */
export function composeAxisSystemPrompt(axisPrompt: string, schema?: z.ZodType): string {
  const wrapper = resolveSystemPrompt('_shared.json-evaluator-wrapper');
  const guardRails = resolveSystemPrompt('_shared.guard-rails');
  let result = `${wrapper}\n\n${guardRails}\n\n${axisPrompt}`;
  if (schema) {
    result += `\n\n## Expected output schema\n\n${formatSchemaExample(schema)}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type AxisId =
  | 'utility'
  | 'duplication'
  | 'correction'
  | 'overengineering'
  | 'tests'
  | 'best_practices'
  | 'documentation';

/** Input bundle passed to every axis evaluator's `evaluate()` method. */
export interface AxisContext {
  task: Task;
  fileContent: string;
  config: Config;
  projectRoot: string;
  usageGraph?: UsageGraph;
  preResolvedRag?: PreResolvedRag;
  fileDeps?: FileDependencyContext;
  projectTree?: string;
  /** Content of the associated test file (e.g. foo.test.ts for foo.ts), if it exists */
  testFileContent?: string;
  /** Relative path of the resolved test file (e.g. "src/foo.test.ts") */
  testFileName?: string;
  /** ASCII tree of docs/ directory (null if no docs dir) */
  docsTree?: string | null;
  /** Relevant documentation pages resolved for the current file */
  relevantDocs?: RelevantDoc[];
  /** Full path to conversations/ dir in the run dir (undefined = no dump) */
  conversationDir?: string;
  /** Pre-computed file slug for conversation file naming (e.g. "src-cli") */
  conversationFileSlug?: string;
  /** Global SDK concurrency semaphore — when set, passed to runSingleTurnQuery */
  semaphore?: Semaphore;
  /** Gemini-specific SDK concurrency semaphore — used when model starts with `gemini-` */
  geminiSemaphore?: Semaphore;
  /** Circuit breaker for Gemini fallback — when tripped, Gemini models redirect to Claude */
  circuitBreaker?: GeminiCircuitBreaker;
  /** Claude model to fall back to when circuit breaker redirects Gemini calls */
  fallbackModel?: string;
}

export interface RelevantDoc {
  path: string;
  content: string;
  /** Origin of the doc: 'project' (docs/) or 'internal' (.anatoly/docs/). */
  source?: 'project' | 'internal';
}

/** Per-symbol output record produced by an axis evaluator. */
export interface AxisSymbolResult {
  name: string;
  line_start: number;
  line_end: number;
  /** The axis-specific value (e.g. "USED", "DEAD", "OK", "NEEDS_FIX") */
  value: string;
  confidence: number;
  detail: string;
  /** For duplication axis only */
  duplicate_target?: { file: string; symbol: string; similarity: string };
}

/** Complete result of one axis evaluation run, including per-symbol verdicts, actions, and cost metrics. */
export interface AxisResult {
  axisId: AxisId;
  symbols: AxisSymbolResult[];
  /** File-level results (optional, e.g. unused_imports) */
  fileLevel?: Partial<{ unused_imports: string[]; circular_dependencies: string[]; general_notes: string }>;
  actions: Action[];
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
}

/** Contract implemented by all axis evaluators. `defaultModel` selects haiku (fast) or sonnet (capable). */
export interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}

// ---------------------------------------------------------------------------
// Language / framework injection helpers (Story 31.19)
// ---------------------------------------------------------------------------

/**
 * Return the markdown code-fence language tag for a task.
 * Falls back to 'typescript' when no language is set.
 */
export function getCodeFenceTag(task: Task): string {
  return task.language ?? 'typescript';
}

/**
 * Return `## Language:` / `## Framework:` header lines to inject into user
 * messages.  Returns an empty array for plain TypeScript (no framework) so
 * that existing output is unchanged (zero regression).
 */
export function getLanguageLines(task: Task): string[] {
  const lang = task.language;
  const fw = task.framework;

  // Zero regression: TypeScript (or unset) with no framework → no headers
  if ((!lang || lang === 'typescript') && !fw) return [];

  const lines: string[] = [];
  if (lang) lines.push(`## Language: ${lang}`);
  if (fw) lines.push(`## Framework: ${fw}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Model resolution (here to avoid circular deps between axes/index and evaluators)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective model for an axis evaluator based on config overrides.
 * Priority: axes.[axis].model → (haiku ? models.fast : models.quality)
 *
 * Gemini routing is now implicit: if the user sets `axes.utility.model: gemini-2.5-flash`
 * in the config, the model name determines the transport (no separate defaultGeminiMode flag).
 */
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const axisConfig = config.axes?.[evaluator.id];
  // Honour per-axis override, but ignore gemini-* models when Google provider is absent
  if (axisConfig?.model) {
    if (axisConfig.model.startsWith('gemini-') && !config.providers.google) {
      // Fall through to default resolution — Gemini provider not configured
    } else {
      return axisConfig.model;
    }
  }

  return evaluator.defaultModel === 'haiku'
    ? config.models.fast
    : config.models.quality;
}

/**
 * Resolve the model for code summarization during RAG indexing.
 * Returns `code_summary` when set (e.g. a Gemini model), falls back to `models.fast` (Haiku).
 */
export function resolveCodeSummaryModel(config: Config): string {
  return config.models.code_summary ?? config.models.fast;
}

/** @deprecated Alias kept for consumers not yet migrated (Story 42.4). */
export function resolveNlpModel(config: Config): string {
  return resolveCodeSummaryModel(config);
}

/**
 * Build per-provider stats from axis timing data.
 * Returns a `providers` object with call counts and cost per provider,
 * plus `claude_quota_saved_pct` indicating what percentage of calls were offloaded to Gemini.
 */
export function buildProviderStats(timings: ReadonlyArray<{ provider: 'anthropic' | 'gemini'; costUsd: number }>): {
  providers: { anthropic: { calls: number; costUsd: number }; gemini: { calls: number; costUsd: number } };
  claude_quota_saved_pct: number;
} {
  const anthropic = { calls: 0, costUsd: 0 };
  const gemini = { calls: 0, costUsd: 0 };

  for (const t of timings) {
    if (t.provider === 'gemini') {
      gemini.calls++;
      gemini.costUsd += t.costUsd;
    } else {
      anthropic.calls++;
      anthropic.costUsd += t.costUsd;
    }
  }

  // Round cost to avoid floating point noise
  anthropic.costUsd = Math.round(anthropic.costUsd * 100) / 100;
  gemini.costUsd = Math.round(gemini.costUsd * 100) / 100;

  const total = anthropic.calls + gemini.calls;
  const claude_quota_saved_pct = total > 0
    ? Math.round((gemini.calls / total) * 100)
    : 0;

  return { providers: { anthropic, gemini }, claude_quota_saved_pct };
}

/**
 * Resolve the model for the deliberation pass.
 * Uses agents.deliberation override if set, otherwise falls back to models.deliberation.
 */
export function resolveDeliberationModel(config: Config): string {
  return config.agents.deliberation ?? config.models.deliberation;
}

/**
 * Resolve the model for an agentic phase (scaffolding, review).
 * Uses agents.[phase] override if set, otherwise falls back to models.quality.
 */
export function resolveAgentModel(phase: 'scaffolding' | 'review', config: Config): string {
  return config.agents[phase] ?? config.models.quality;
}

// ---------------------------------------------------------------------------
// Dual semaphore routing (Story 2.2)
// ---------------------------------------------------------------------------

/**
 * Select the correct concurrency semaphore based on model prefix.
 * Gemini models (prefixed `gemini-`) use the Gemini semaphore when available;
 * all other models use the Claude semaphore.
 */
export function resolveSemaphore(
  model: string,
  claudeSemaphore: Semaphore | undefined,
  geminiSemaphore: Semaphore | undefined,
): Semaphore | undefined {
  if (model.startsWith('gemini-')) {
    if (geminiSemaphore) return geminiSemaphore;
    contextLogger().warn(
      { event: 'gemini_semaphore_missing', model },
      'Gemini model requested but no geminiSemaphore configured — falling back to Claude semaphore',
    );
  }
  return claudeSemaphore;
}

// ---------------------------------------------------------------------------
// Shared single-turn query utility
// ---------------------------------------------------------------------------

/** Parameters for a single-turn LLM query executed via {@link runSingleTurnQuery}. */
export interface SingleTurnQueryParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  /** Full path to conversations/ dir — when set, a conversation dump .md is written per attempt */
  conversationDir?: string;
  /** Prefix for conversation file naming (e.g. "src-cli__documentation") */
  conversationPrefix?: string;
  /** Global SDK concurrency semaphore — when set, acquire/release around SDK calls */
  semaphore?: Semaphore;
  /** Gemini-specific semaphore — used instead of `semaphore` when model starts with `gemini-` */
  geminiSemaphore?: Semaphore;
  /** Circuit breaker for Gemini fallback */
  circuitBreaker?: GeminiCircuitBreaker;
  /** Claude model to fall back to when circuit breaker redirects Gemini calls */
  fallbackModel?: string;
  /** LLM transport override — defaults to AnthropicTransport when not provided */
  transport?: LlmTransport;
}

export interface SingleTurnQueryResult<T> {
  data: T;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
}

/**
 * Execute a single-turn LLM query (no tools), validate the response with a
 * Zod schema, and retry once with Zod error feedback if validation fails.
 *
 * Shared by all axis evaluators to eliminate duplicated SDK boilerplate.
 */
export async function runSingleTurnQuery<T>(
  params: SingleTurnQueryParams,
  schema: z.ZodType<T>,
): Promise<SingleTurnQueryResult<T>> {
  const { systemPrompt: rawSystemPrompt, userMessage, model, projectRoot, abortController, conversationDir, conversationPrefix, semaphore, geminiSemaphore, circuitBreaker, fallbackModel, transport } = params;

  // Circuit breaker: redirect Gemini → Claude when tripped
  const isGeminiModel = model.startsWith('gemini-');
  const effectiveModel = (isGeminiModel && circuitBreaker && fallbackModel)
    ? circuitBreaker.resolveModel(model, fallbackModel)
    : model;

  // Resolve transport based on effective model (after circuit breaker may redirect)
  const effectiveTransport = transport ?? (
    effectiveModel.startsWith('gemini-')
      ? getOrCreateGeminiTransport(projectRoot, effectiveModel)
      : new AnthropicTransport()
  );

  const activeSemaphore = resolveSemaphore(effectiveModel, semaphore, geminiSemaphore);
  if (activeSemaphore) {
    await activeSemaphore.acquire();
  }
  try {
    const result = await _runSingleTurnQueryInner(rawSystemPrompt, userMessage, effectiveModel, projectRoot, abortController, conversationDir, conversationPrefix, schema, effectiveTransport);

    // Record success for Gemini calls (only if we actually called Gemini)
    if (effectiveModel.startsWith('gemini-') && circuitBreaker) {
      circuitBreaker.recordSuccess();
    }

    return result;
  } catch (err) {
    // Record failure for Gemini calls (based on original model, not effective model after redirect)
    if (isGeminiModel && circuitBreaker) {
      circuitBreaker.recordFailure();
      if (circuitBreaker.consumeWarning()) {
        contextLogger().warn(
          { event: 'gemini_circuit_breaker_tripped' },
          '\u26A0 Gemini quota exhausted \u2014 falling back to Claude',
        );
      }
    }
    throw err;
  } finally {
    if (activeSemaphore) {
      activeSemaphore.release();
    }
  }
}

async function _runSingleTurnQueryInner<T>(
  rawSystemPrompt: string,
  userMessage: string,
  model: string,
  projectRoot: string,
  abortController: AbortController,
  conversationDir: string | undefined,
  conversationPrefix: string | undefined,
  schema: z.ZodType<T>,
  transport: LlmTransport,
): Promise<SingleTurnQueryResult<T>> {

  // Compose the system prompt: json-evaluator-wrapper → guard-rails → axis-specific prompt → schema example
  const systemPrompt = composeAxisSystemPrompt(rawSystemPrompt, schema);

  const transcriptParts: string[] = [];
  let totalCost = 0;
  let totalDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  const accumulateFromResponse = (r: LlmResponse) => {
    totalCost += r.costUsd;
    totalDuration += r.durationMs;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    totalCacheCreationTokens += r.cacheCreationTokens;
    transcriptParts.push(r.transcript);
  };

  const makeResult = (data: T) => ({
    data,
    costUsd: totalCost,
    durationMs: totalDuration,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    transcript: transcriptParts.join('\n'),
  });

  // Capture the user prompt in the transcript (SDK does not stream it back)
  transcriptParts.push(`## User\n\n${userMessage}\n`);

  // --- Attempt 1 ---
  const initial = await transport.query({
    systemPrompt,
    userMessage,
    model,
    projectRoot,
    abortController,
    conversationDir,
    conversationPrefix,
    attempt: 1,
  });
  accumulateFromResponse(initial);

  const v1 = tryValidate(initial.text, schema);
  if (v1.success) {
    return makeResult(v1.data);
  }

  // --- Attempt 2: retry with Zod error feedback ---
  if (abortController.signal.aborted) {
    throw new AnatolyError('Aborted before retry', ERROR_CODES.SDK_TIMEOUT, true);
  }
  transcriptParts.push(`\n## Retry: validation failed\n${v1.error}\n`);

  const feedback = `Your JSON output failed validation:\n  ${v1.error}\n\nFix these issues and output ONLY the corrected JSON object. No markdown fences, no explanation.`;
  const retry = await transport.query({
    systemPrompt,
    userMessage: feedback,
    model,
    projectRoot,
    abortController,
    resumeSessionId: initial.sessionId,
    conversationDir,
    conversationPrefix,
    attempt: 2,
    retryReason: 'zod_validation_failed',
  });
  accumulateFromResponse(retry);

  const v2 = tryValidate(retry.text, schema);
  if (v2.success) {
    return makeResult(v2.data);
  }

  // Both attempts failed
  throw new AnatolyError(
    `Axis validation failed after 2 attempts: ${v2.error}`,
    ERROR_CODES.ZOD_VALIDATION_FAILED,
    true,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryValidate<T>(
  responseText: string,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  const jsonStr = extractJson(responseText);
  if (!jsonStr) return { success: false, error: 'No valid JSON found in response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: 'Invalid JSON syntax' };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    return { success: false, error: formatted };
  }

  return { success: true, data: result.data };
}
