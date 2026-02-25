import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { UsageGraph } from './usage-graph.js';
import type { SimilarityResult } from '../rag/types.js';
import type { Action } from '../schemas/review.js';

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
import { extractJson } from '../utils/extract-json.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';

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
  usageGraph?: UsageGraph;
  preResolvedRag?: PreResolvedRag;
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
  transcript: string;
}

/**
 * Execute a single-turn LLM query (maxTurns: 1, no tools), validate the
 * response with a Zod schema, and retry once with Zod error feedback if
 * validation fails.
 *
 * Shared by all axis evaluators to eliminate duplicated SDK boilerplate.
 */
export async function runSingleTurnQuery<T>(
  params: SingleTurnQueryParams,
  schema: z.ZodType<T>,
): Promise<SingleTurnQueryResult<T>> {
  const { systemPrompt, userMessage, model, projectRoot, abortController } = params;

  const transcriptLines: string[] = [];
  let totalCost = 0;
  let totalDuration = 0;

  // --- Attempt 1 ---
  const initial = await execQuery({
    prompt: userMessage,
    systemPrompt,
    model,
    projectRoot,
    abortController,
    transcriptLines,
  });
  totalCost += initial.costUsd;
  totalDuration += initial.durationMs;

  const v1 = tryValidate(initial.resultText, schema);
  if (v1.success) {
    return { data: v1.data, costUsd: totalCost, durationMs: totalDuration, transcript: transcriptLines.join('\n') };
  }

  // --- Attempt 2: retry with Zod error feedback ---
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
  totalCost += retry.costUsd;
  totalDuration += retry.durationMs;

  const v2 = tryValidate(retry.resultText, schema);
  if (v2.success) {
    return { data: v2.data, costUsd: totalCost, durationMs: totalDuration, transcript: transcriptLines.join('\n') };
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
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      maxTurns: 1,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  let resultText = '';
  let costUsd = 0;
  let durationMs = 0;
  let sessionId = '';

  for await (const message of q) {
    transcriptLines.push(formatMessage(message));

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        const success = message as SDKResultSuccess;
        resultText = success.result;
        costUsd = success.total_cost_usd;
        durationMs = success.duration_ms;
        sessionId = success.session_id;
      } else {
        const errorMsg = message as { errors?: string[] };
        throw new AnatolyError(
          `Agent error: ${errorMsg.errors?.join(', ') ?? 'unknown'}`,
          ERROR_CODES.LLM_API_ERROR,
          true,
        );
      }
    }
  }

  return { resultText, costUsd, durationMs, sessionId };
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
        return `## Result (success)\n\n**Cost:** $${msg.total_cost_usd.toFixed(4)} | **Duration:** ${(msg.duration_ms / 1000).toFixed(1)}s\n`;
      }
      const msg = message as SDKResultError;
      return `## Result (${msg.subtype})\n\n**Errors:** ${msg.errors?.join(', ') ?? 'unknown'}\n`;
    }
    default:
      return `## ${message.type}\n`;
  }
}
