import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { UsageGraph } from './usage-graph.js';
import type { FileDependencyContext } from './dependency-meta.js';
import type { SimilarityResult } from '../rag/types.js';
import type { Action } from '../schemas/review.js';
import { extractJson } from '../utils/extract-json.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { contextLogger } from '../utils/log-context.js';

// ---------------------------------------------------------------------------
// Pre-resolved RAG types (moved from prompt-builder.ts)
// ---------------------------------------------------------------------------

export interface PreResolvedRagEntry {
  symbolName: string;
  lineStart: number;
  lineEnd: number;
  /** null means the function was not found in the index */
  results: SimilarityResult[] | null;
}

export type PreResolvedRag = PreResolvedRagEntry[];

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type AxisId =
  | 'utility'
  | 'duplication'
  | 'correction'
  | 'overengineering'
  | 'tests'
  | 'best_practices';

export interface AxisContext {
  task: Task;
  fileContent: string;
  config: Config;
  projectRoot: string;
  usageGraph?: UsageGraph;
  preResolvedRag?: PreResolvedRag;
  fileDeps?: FileDependencyContext;
  projectTree?: string;
}

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

export interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}

// ---------------------------------------------------------------------------
// Model resolution (here to avoid circular deps between axes/index and evaluators)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective model for an axis evaluator based on config overrides.
 * Priority: axes.[axis].model → (haiku ? fast_model : model) → evaluator.defaultModel fallback
 */
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const axisConfig = config.llm.axes?.[evaluator.id];
  if (axisConfig?.model) return axisConfig.model;

  return evaluator.defaultModel === 'haiku'
    ? (config.llm.fast_model ?? config.llm.index_model)
    : config.llm.model;
}

/**
 * Resolve the model for the deliberation pass.
 */
export function resolveDeliberationModel(config: Config): string {
  return config.llm.deliberation_model;
}

// ---------------------------------------------------------------------------
// Shared single-turn query utility
// ---------------------------------------------------------------------------

export interface SingleTurnQueryParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
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
  const { systemPrompt: rawSystemPrompt, userMessage, model, projectRoot, abortController } = params;

  // Prepend a no-tools directive so the model never attempts tool calls.
  // All context the model needs is already embedded in the prompt.
  const systemPrompt = `IMPORTANT: You are a single-turn JSON evaluator. Do NOT use any tools (Read, Glob, Grep, Bash, Write, Edit, WebSearch, etc.). All the context you need is provided below. Respond ONLY with a JSON object — no markdown fences, no explanation.\n\n${rawSystemPrompt}`;

  const transcriptLines: string[] = [];
  let totalCost = 0;
  let totalDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  const accumulateTokens = (r: ExecQueryResult) => {
    totalCost += r.costUsd;
    totalDuration += r.durationMs;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    totalCacheCreationTokens += r.cacheCreationTokens;
  };

  const makeResult = (data: T) => ({
    data,
    costUsd: totalCost,
    durationMs: totalDuration,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    transcript: transcriptLines.join('\n'),
  });

  // --- Attempt 1 ---
  const initial = await execQuery({
    prompt: userMessage,
    systemPrompt,
    model,
    projectRoot,
    abortController,
    transcriptLines,
  });
  accumulateTokens(initial);

  const v1 = tryValidate(initial.resultText, schema);
  if (v1.success) {
    return makeResult(v1.data);
  }

  // --- Attempt 2: retry with Zod error feedback ---
  if (abortController.signal.aborted) {
    throw new AnatolyError('Aborted before retry', ERROR_CODES.SDK_TIMEOUT, true);
  }
  transcriptLines.push(`\n## Retry: validation failed\n${v1.error}\n`);

  const feedback = `Your JSON output failed validation:\n  ${v1.error}\n\nFix these issues and output ONLY the corrected JSON object. No markdown fences, no explanation.`;
  const retry = await execQuery({
    prompt: feedback,
    model,
    projectRoot,
    abortController,
    transcriptLines,
    resumeSessionId: initial.sessionId,
  });
  accumulateTokens(retry);

  const v2 = tryValidate(retry.resultText, schema);
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

interface ExecQueryParams {
  prompt: string;
  systemPrompt?: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  transcriptLines: string[];
  resumeSessionId?: string;
}

interface ExecQueryResult {
  resultText: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionId: string;
}

async function execQuery(params: ExecQueryParams): Promise<ExecQueryResult> {
  const { prompt, systemPrompt, model, projectRoot, abortController, transcriptLines, resumeSessionId } = params;

  const q = query({
    prompt,
    options: {
      ...(systemPrompt ? { systemPrompt } : {}),
      model,
      cwd: projectRoot,
      allowedTools: [],
      maxTurns: 2,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  let resultText = '';
  let costUsd = 0;
  let durationMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let sessionId = '';

  try {
    for await (const message of q) {
      transcriptLines.push(formatMessage(message));

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          const success = message as SDKResultSuccess;
          resultText = success.result;
          costUsd = success.total_cost_usd ?? 0;
          durationMs = success.duration_ms ?? 0;
          sessionId = success.session_id;

          // Log SDK turn count for diagnostics
          contextLogger().debug(
            { model, numTurns: success.num_turns, usage: success.usage, modelUsage: success.modelUsage },
            'SDK query result',
          );

          // Use cumulative usage (covers all turns) instead of per-model modelUsage
          if (success.usage) {
            const u = success.usage as Record<string, number>;
            inputTokens += u.input_tokens ?? 0;
            outputTokens += u.output_tokens ?? 0;
            cacheReadTokens += u.cache_read_input_tokens ?? 0;
            cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
          }
        } else {
          const errorResult = message as SDKResultError;
          const details = errorResult.errors?.join(', ') || errorResult.subtype || 'unknown';
          throw new AnatolyError(
            `Claude Code SDK error [${errorResult.subtype}]: ${details}`,
            ERROR_CODES.SDK_ERROR,
            true,
          );
        }
      }
    }
  } catch (err) {
    // Re-throw AnatolyErrors as-is (from the result handler above)
    if (err instanceof AnatolyError) throw err;
    // SDK-level error (e.g. subprocess crash, exit code 1) — attach partial transcript
    const rawMessage = err instanceof Error ? err.message : String(err);
    const partial = transcriptLines.length > 0
      ? `\n--- partial transcript ---\n${transcriptLines.join('\n')}`
      : '';
    throw new AnatolyError(
      `Claude Code SDK query failed: ${rawMessage}${partial}`,
      ERROR_CODES.SDK_ERROR,
      true,
    );
  }

  // Guard: SDK completed without yielding a result message
  if (!sessionId) {
    throw new AnatolyError(
      'Claude Code SDK query completed without producing a result message',
      ERROR_CODES.SDK_ERROR,
      true,
    );
  }

  const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const cacheHitRate = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;
  contextLogger().trace(
    {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheHitRate: Math.round(cacheHitRate * 100),
      costUsd,
      durationMs,
    },
    'SDK query complete',
  );

  return { resultText, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, sessionId };
}

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

function formatMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      const msg = message as SDKAssistantMessage;
      const content = msg.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
          : '';
      return `## Assistant\n\n${text}\n`;
    }
    case 'user': {
      const msg = message as SDKUserMessage;
      const text = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
      return `## User\n\n${text}\n`;
    }
    case 'system': {
      const msg = message as SDKSystemMessage;
      if (msg.subtype === 'init') {
        return `## System (init)\n\n**Model:** ${msg.model}\n**Mode:** axis evaluator (single-turn, no tools)\n`;
      }
      return `## System (${msg.subtype})\n`;
    }
    case 'result': {
      if (message.subtype === 'success') {
        const msg = message as SDKResultSuccess;
        const cost = msg.total_cost_usd?.toFixed(4) ?? '?';
        const duration = msg.duration_ms ? (msg.duration_ms / 1000).toFixed(1) : '?';
        return `## Result (success)\n\n**Cost:** $${cost} | **Duration:** ${duration}s\n`;
      }
      const msg = message as SDKResultError;
      return `## Result (${msg.subtype})\n\n**Errors:** ${msg.errors?.join(', ') ?? 'unknown'}\n`;
    }
    default:
      return `## ${message.type}\n`;
  }
}
