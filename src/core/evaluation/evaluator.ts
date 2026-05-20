// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The evaluation context's **implementation** (doc 12 §4, doc 13 PR 7b).
 *
 * The runtime half of the former `axis-evaluator.ts`: system-prompt
 * composition, model resolution, and the shared single-turn query utility.
 * Types live in `./contract.js` (the published language); cross-context
 * consumers import that, not this. Every function body below is
 * byte-identical to its pre-split form; only the file split and the import
 * list (types now sourced from `./contract.js`) changed.
 */

import type { z } from 'zod';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { parseModelRef, type ConfigV3 } from '../../schemas/config-v3.js';
import { getV3Source } from '../../utils/config-loader.js';
import { resolveSystemPrompt } from '../platform/index.js';
import { formatSchemaExample } from '../../utils/schema-example.js';
import { extractJson } from '../../utils/extract-json.js';
import { runWithContext } from '../../utils/log-context.js';
import { AnatolyError, ERROR_CODES } from '../../utils/errors.js';
import type { LlmTransport, LlmResponse } from '../transports/index.js';
import { extractProvider } from '../transports/index.js';
import { AnthropicTransport } from '../transports/anthropic-transport.js';
import type { AxisEvaluator, SingleTurnQueryParams, SingleTurnQueryResult } from './contract.js';
import { runUnit } from '../harness/index.js';
import type { ExecutionUnit } from '../harness/index.js';

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the full system prompt for an axis evaluator.
 * Order: json-evaluator-wrapper → guard-rails → axis-specific prompt → user calibration (if provided) → schema example (if provided).
 * @param axisPrompt - The axis-specific system prompt text.
 * @param schema - Optional Zod schema; when provided, a formatted example is appended.
 * @param userInstructions - Optional user calibration text from ANATOLY.md.
 */
export function composeAxisSystemPrompt(axisPrompt: string, schema?: z.ZodType, userInstructions?: string): string {
  const wrapper = resolveSystemPrompt('_shared.json-evaluator-wrapper');
  const guardRails = resolveSystemPrompt('_shared.guard-rails');
  let result = `${wrapper}\n\n${guardRails}\n\n${axisPrompt}`;
  if (userInstructions) {
    result += `\n\n## User Calibration\n\nThe project maintainer provided these instructions. Adjust your evaluation accordingly — treat them as authoritative project conventions.\n\n${userInstructions}`;
  }
  if (schema) {
    result += `\n\n## Expected output schema\n\n${formatSchemaExample(schema)}`;
  }
  return result;
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
 *
 * v3 path: when the config originated from a `version: 3` YAML, this reads
 * `evaluation.axes.<id>.model` (object form) for overrides and falls back to
 * `routing.generation.fast` (haiku tier) or `routing.generation.quality`.
 */
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const v3 = getV3Source(config);
  if (v3) return resolveAxisModelV3(evaluator, v3, config);

  const axisConfig = config.axes?.[evaluator.id];
  // Honour per-axis override, but ignore gemini-* models when Google provider is absent
  if (axisConfig?.model) {
    if (extractProvider(axisConfig.model) === 'google' && !config.providers.google) {
      // Fall through to default resolution — Gemini provider not configured
    } else {
      return axisConfig.model;
    }
  }

  return evaluator.defaultModel === 'haiku'
    ? config.models.fast
    : config.models.quality;
}

function resolveAxisModelV3(
  evaluator: AxisEvaluator,
  v3: ConfigV3,
  _config: Config,
): string {
  const axis = v3.evaluation.axes[evaluator.id as keyof typeof v3.evaluation.axes];
  if (axis && typeof axis === 'object' && 'model' in axis && axis.model) {
    // Honour per-axis override, but skip if it points at a transport whose
    // provider is missing (e.g. Gemini override but no google provider).
    const parsed = parseModelRef(axis.model);
    if (parsed && v3.providers[parsed.provider]) return axis.model;
  }
  return evaluator.defaultModel === 'haiku'
    ? v3.routing.generation.fast
    : v3.routing.generation.quality;
}

/**
 * Resolve the model for code summarization during RAG indexing.
 * Returns `code_summary` when set (e.g. a Gemini model), falls back to `models.fast` (Haiku).
 *
 * v3 path: returns `routing.generation.summarization`, which is the explicit
 * slot for this purpose in the v3 schema.
 */
export function resolveCodeSummaryModel(config: Config): string {
  const v3 = getV3Source(config);
  if (v3) return v3.routing.generation.summarization;
  return config.models.code_summary ?? config.models.fast;
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
 *
 * v3 path: returns `routing.generation.deliberation` directly (the v3 schema
 * has no per-agent overrides — that level of indirection was removed since
 * routing slots are already declarative).
 */
export function resolveDeliberationModel(config: Config): string {
  const v3 = getV3Source(config);
  if (v3) return v3.routing.generation.deliberation;
  return config.agents.deliberation ?? config.models.deliberation;
}

/**
 * Resolve the model for an agentic phase (scaffolding, review).
 * Uses agents.[phase] override if set, otherwise falls back to models.quality.
 *
 * v3 path: returns `routing.generation.quality` (v3 schema has no per-phase
 * overrides; if a project needs them we'll re-introduce a dedicated routing
 * slot rather than smuggle a parallel agent table).
 */
export function resolveAgentModel(phase: 'scaffolding' | 'review', config: Config): string {
  const v3 = getV3Source(config);
  if (v3) return v3.routing.generation.quality;
  return config.agents[phase] ?? config.models.quality;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Shared single-turn query utility
// ---------------------------------------------------------------------------

/**
 * Execute a single-turn LLM query (no tools), validate the response with a
 * Zod schema, and retry once with Zod error feedback if validation fails.
 *
 * Shared by all axis evaluators to eliminate duplicated SDK boilerplate.
 *
 * doc 14 PR 2a: the body is unchanged (byte-verbatim); it is now the `run`
 * of the single-turn {@link ExecutionUnit}, reached only through
 * {@link runSingleTurnQuery} below, which routes it through {@link runUnit}.
 */
async function runSingleTurnQueryImpl<T>(
  params: SingleTurnQueryParams,
  schema: z.ZodType<T>,
): Promise<SingleTurnQueryResult<T>> {
  const { systemPrompt: rawSystemPrompt, userMessage, model, projectRoot, abortController, conversationDir, callId, router, userInstructions, composer, primitive } = params;

  // Acquire concurrency slot + transport from router (handles breaker + semaphore)
  let release: ((opts?: { success: boolean; error?: unknown }) => void) | undefined;
  let effectiveTransport: LlmTransport;
  if (router) {
    const acquired = await router.acquire(model, 'single_turn');
    effectiveTransport = acquired.transport;
    release = acquired.release;
  } else {
    effectiveTransport = new AnthropicTransport();
  }

  // Story 56.11 — open ALS scope binding composer + primitive so recordLlmCall
  // (called by transports during the SDK invocation below) enriches each ledger
  // record with these fields, enabling D.4 byComposer / byPrimitive aggregations.
  const exec = async (): Promise<SingleTurnQueryResult<T>> => {
    let success = false;
    let failErr: unknown;
    try {
      const result = await _runSingleTurnQueryInner(rawSystemPrompt, userMessage, model, projectRoot, abortController, conversationDir, schema, effectiveTransport, userInstructions);
      success = true;
      return result;
    } catch (err) {
      failErr = err;
      throw err;
    } finally {
      release?.({ success, error: failErr });
    }
  };

  if (composer || primitive || callId) {
    return runWithContext({
      ...(composer ? { composer } : {}),
      ...(primitive ? { primitive } : {}),
      ...(callId ? { callId } : {}),
    }, exec);
  }
  return exec();
}

/**
 * doc 14 PR 2a: the single-turn LLM interaction modelled as an
 * {@link ExecutionUnit} and run through the {@link runUnit} agent-grain
 * harness. Public name, signature and behaviour are unchanged: `runUnit` is
 * pure pass-through in PR 2a, so this is byte-equivalent to the pre-PR-2a
 * `runSingleTurnQuery` (the seam PR 2b folds cost into). Every axis that
 * called `runSingleTurnQuery` is untouched and now flows through `runUnit`.
 * `name` is the per-call composer/primitive identity (cost/event attribution
 * for PR 2b); falls back to a stable generic label.
 */
export function runSingleTurnQuery<T>(
  params: SingleTurnQueryParams,
  schema: z.ZodType<T>,
): Promise<SingleTurnQueryResult<T>> {
  const unit: ExecutionUnit<{ params: SingleTurnQueryParams; schema: z.ZodType<T> }, SingleTurnQueryResult<T>> = {
    name: params.composer ?? params.primitive ?? 'agent.single-turn',
    run: (input) => runSingleTurnQueryImpl(input.params, input.schema),
  };
  return runUnit(unit, { params, schema }, { abortController: params.abortController });
}

async function _runSingleTurnQueryInner<T>(
  rawSystemPrompt: string,
  userMessage: string,
  model: string,
  projectRoot: string,
  abortController: AbortController,
  conversationDir: string | undefined,
  schema: z.ZodType<T>,
  transport: LlmTransport,
  userInstructions?: string,
): Promise<SingleTurnQueryResult<T>> {

  // Compose the system prompt: json-evaluator-wrapper → guard-rails → axis-specific prompt → user calibration → schema example
  const systemPrompt = composeAxisSystemPrompt(rawSystemPrompt, schema, userInstructions);

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
