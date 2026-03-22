// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
// System prompt composition
// ---------------------------------------------------------------------------

/**
 * Compose the full system prompt for an axis evaluator.
 * Order: json-evaluator-wrapper → guard-rails → axis-specific prompt.
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
}

export interface RelevantDoc {
  path: string;
  content: string;
  /** Origin of the doc: 'project' (docs/) or 'internal' (.anatoly/docs/). */
  source?: 'project' | 'internal';
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
  /** Full path to conversations/ dir — when set, a conversation dump .md is written per attempt */
  conversationDir?: string;
  /** Prefix for conversation file naming (e.g. "src-cli__documentation") */
  conversationPrefix?: string;
  /** Global SDK concurrency semaphore — when set, acquire/release around SDK calls */
  semaphore?: Semaphore;
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
  const { systemPrompt: rawSystemPrompt, userMessage, model, projectRoot, abortController, conversationDir, conversationPrefix, semaphore } = params;

  if (semaphore) {
    await semaphore.acquire();
  }
  try {
    return await _runSingleTurnQueryInner(rawSystemPrompt, userMessage, model, projectRoot, abortController, conversationDir, conversationPrefix, schema);
  } finally {
    if (semaphore) {
      semaphore.release();
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
): Promise<SingleTurnQueryResult<T>> {

  // Compose the system prompt: json-evaluator-wrapper → guard-rails → axis-specific prompt → schema example
  const systemPrompt = composeAxisSystemPrompt(rawSystemPrompt, schema);

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

  // Capture the user prompt in the transcript (SDK does not stream it back)
  transcriptLines.push(`## User\n\n${userMessage}\n`);

  // --- Attempt 1 ---
  const initial = await execQuery({
    prompt: userMessage,
    systemPrompt,
    model,
    projectRoot,
    abortController,
    transcriptLines,
    conversationDir,
    conversationPrefix,
    attempt: 1,
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
    conversationDir,
    conversationPrefix,
    attempt: 2,
    retryReason: 'zod_validation_failed',
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
  /** Full path to conversations/ dir — when set, a conversation dump .md is written */
  conversationDir?: string;
  /** Prefix for conversation file naming (e.g. "src-cli__documentation") */
  conversationPrefix?: string;
  /** Attempt number (1 = initial, 2 = Zod retry) */
  attempt?: number;
  /** Reason for retry (e.g. 'zod_validation_failed') — logged in the llm_call event */
  retryReason?: string;
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
  const { prompt, systemPrompt, model, projectRoot, abortController, transcriptLines, resumeSessionId,
    conversationDir, conversationPrefix, attempt, retryReason } = params;

  // --- Conversation dump setup ---
  let convPath: string | undefined;
  let convFileName: string | undefined; // Actual filename (may be truncated) for ndjson reference
  if (conversationDir && conversationPrefix != null && attempt != null) {
    try {
      mkdirSync(conversationDir, { recursive: true });
      // Truncate filename to stay under OS 255-byte limit, preserving __<attempt>.md suffix
      const suffix = `__${attempt}.md`;
      const rawName = `${conversationPrefix}${suffix}`;
      const safeName = rawName.length > 250 ? conversationPrefix.slice(0, 250 - suffix.length) + suffix : rawName;
      convFileName = safeName;
      convPath = join(conversationDir, safeName);

      const title = conversationPrefix.replace(/__/g, ' — ');
      let header = `# Conversation: ${title} (attempt ${attempt})\n\n`;
      header += `| Field | Value |\n|-------|-------|\n`;
      header += `| Model | ${model} |\n`;
      header += `| Timestamp | ${new Date().toISOString()} |\n\n---\n\n`;
      if (systemPrompt) {
        header += `## System\n\n${systemPrompt}\n\n---\n\n`;
      }
      header += `## User\n\n${prompt}\n\n---\n\n`;
      writeFileSync(convPath, header);
    } catch {
      // Conversation dump is best-effort — don't crash the axis evaluation
      convPath = undefined;
    }
  }

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

      // Stream assistant response to conversation dump for crash-safety
      if (convPath && message.type === 'assistant') {
        try { appendFileSync(convPath, formatMessage(message) + '\n---\n\n'); } catch (e) {
          contextLogger().warn({ err: e instanceof Error ? e.message : String(e), path: convPath }, 'conversation dump append failed');
          convPath = undefined; // Stop further attempts
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          const success = message as SDKResultSuccess;
          resultText = success.result;
          costUsd = success.total_cost_usd ?? 0;
          durationMs = success.duration_ms ?? 0;
          sessionId = success.session_id;

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
    // Append error to conversation dump before re-throwing
    if (convPath) {
      try {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorCode = err instanceof AnatolyError ? (err as AnatolyError).code : 'UNKNOWN';
        appendFileSync(convPath, `## Error\n\n**Type:** ${errorCode}\n**Message:** ${errorMsg}\n`);
      } catch { /* best-effort */ }
    }

    // Emit llm_call event for the failed call
    contextLogger().info(
      {
        event: 'llm_call',
        model,
        attempt,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheHitRate: 0,
        costUsd,
        durationMs,
        success: false,
        ...(retryReason ? { retryReason } : {}),
        error: {
          code: err instanceof AnatolyError ? (err as AnatolyError).code : 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        },
        ...(convFileName ? { conversationFile: `conversations/${convFileName}` } : {}),
      },
      'LLM call failed',
    );

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

  // --- Append final metrics to conversation dump ---
  const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const cacheHitRate = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;
  if (convPath) {
    try {
      let result = `## Result\n\n`;
      result += `| Field | Value |\n|-------|-------|\n`;
      result += `| Duration | ${(durationMs / 1000).toFixed(1)}s |\n`;
      result += `| Cost | $${costUsd.toFixed(4)} |\n`;
      result += `| Input tokens | ${inputTokens} |\n`;
      result += `| Output tokens | ${outputTokens} |\n`;
      result += `| Cache read | ${cacheReadTokens} |\n`;
      result += `| Cache creation | ${cacheCreationTokens} |\n`;
      result += `| Cache hit rate | ${Math.round(cacheHitRate * 100)}% |\n`;
      result += `| Success | true |\n`;
      appendFileSync(convPath, result);
    } catch (e) {
      contextLogger().warn({ err: e instanceof Error ? e.message : String(e), path: convPath }, 'conversation dump result write failed');
    }
  }

  // Emit structured llm_call event (info level for ndjson visibility)
  contextLogger().info(
    {
      event: 'llm_call',
      model,
      attempt,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheHitRate: Math.round(cacheHitRate * 100),
      costUsd,
      durationMs,
      success: true,
      ...(retryReason ? { retryReason } : {}),
      ...(convFileName ? { conversationFile: `conversations/${convFileName}` } : {}),
    },
    'LLM call complete',
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
