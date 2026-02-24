import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import { ReviewFileSchema } from '../schemas/review.js';
import { buildSystemPrompt, buildUserPrompt, type PromptOptions } from '../utils/prompt-builder.js';
import { toOutputName } from '../utils/cache.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { extractJson } from '../utils/extract-json.js';
import { createRagMcpServer } from '../rag/index.js';

export interface ReviewResult {
  review: ReviewFile;
  transcript: string;
  costUsd: number;
  retries: number;
}

interface QueryResult {
  resultText: string;
  costUsd: number;
  sessionId: string;
}

/**
 * Review a single file using the Claude Agent SDK.
 * Builds the system prompt, invokes the agent, streams the transcript,
 * validates the response with Zod, and retries up to max_retries times
 * if validation fails (sending ZodError feedback to the agent).
 */
export async function reviewFile(
  projectRoot: string,
  task: Task,
  config: Config,
  promptOptions: PromptOptions = {},
  externalAbort?: AbortController,
  runDir?: string,
): Promise<ReviewResult> {
  const systemPrompt = buildSystemPrompt(task, promptOptions);
  const userPrompt = buildUserPrompt(task, promptOptions);

  const logsDir = runDir ? join(runDir, 'logs') : join(projectRoot, '.anatoly', 'logs');
  mkdirSync(logsDir, { recursive: true });

  const transcriptPath = join(logsDir, `${toOutputName(task.file)}.transcript.md`);
  const transcriptLines: string[] = [];

  const appendTranscript = (line: string): void => {
    transcriptLines.push(line);
  };

  appendTranscript(`# Transcript: ${task.file}`);
  appendTranscript(`**Date:** ${new Date().toISOString()}`);
  appendTranscript(`**Model:** ${config.llm.model}`);
  appendTranscript('');
  appendTranscript('---');
  appendTranscript('');

  // Set up timeout via AbortController
  const abortController = new AbortController();
  const timeoutMs = config.llm.timeout_per_file * 1000;
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  // Link external abort (e.g. SIGINT) to internal controller
  const onExternalAbort = () => abortController.abort();
  if (externalAbort) {
    if (externalAbort.signal.aborted) {
      abortController.abort();
    } else {
      externalAbort.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  // Set up RAG MCP server when RAG is enabled
  const mcpServers: Record<string, McpServerConfig> | undefined =
    promptOptions.ragEnabled && promptOptions.vectorStore
      ? { 'anatoly-rag': createRagMcpServer(promptOptions.vectorStore) }
      : undefined;

  const maxRetries = config.llm.max_retries;
  let totalCostUsd = 0;
  let retries = 0;

  try {
    // Initial query
    const initial = await runQuery({
      prompt: userPrompt,
      systemPrompt,
      model: config.llm.model,
      projectRoot,
      abortController,
      appendTranscript,
      mcpServers,
    });
    totalCostUsd += initial.costUsd;

    // Validate + retry loop
    let resultText = initial.resultText;
    let sessionId = initial.sessionId;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const validation = tryParseReview(resultText, task.file);

      if (validation.success) {
        return {
          review: validation.data,
          transcript: transcriptLines.join('\n'),
          costUsd: totalCostUsd,
          retries: attempt - 1,
        };
      }

      // Last attempt — throw the error
      if (attempt === maxRetries) {
        throw new AnatolyError(
          `Review validation failed for ${task.file} after ${maxRetries} retries. Run with --verbose for details.`,
          ERROR_CODES.ZOD_VALIDATION_FAILED,
          true,
        );
      }

      // Send Zod error feedback and retry
      retries++;
      const feedback = formatRetryFeedback(validation.error, attempt, maxRetries);
      appendTranscript(`## Retry ${attempt}/${maxRetries}`);
      appendTranscript('');
      appendTranscript(`**Validation error:** ${validation.error}`);
      appendTranscript('');

      const retry = await runQuery({
        prompt: feedback,
        model: config.llm.model,
        projectRoot,
        abortController,
        appendTranscript,
        resumeSessionId: sessionId,
      });

      resultText = retry.resultText;
      sessionId = retry.sessionId;
      totalCostUsd += retry.costUsd;
    }

    // Should not reach here, but guard against it
    throw new AnatolyError(
      `Review validation failed for ${task.file} after ${maxRetries} retries. Run with --verbose for details.`,
      ERROR_CODES.ZOD_VALIDATION_FAILED,
      true,
    );
  } catch (error) {
    if (error instanceof AnatolyError) throw error;

    if (abortController.signal.aborted) {
      // Distinguish SIGINT abort from timeout abort
      if (externalAbort?.signal.aborted) {
        throw new AnatolyError(
          `Review interrupted for ${task.file}`,
          ERROR_CODES.LLM_API_ERROR,
          true,
        );
      }
      throw new AnatolyError(
        `Review timed out after ${config.llm.timeout_per_file}s for ${task.file}`,
        ERROR_CODES.LLM_TIMEOUT,
        true,
      );
    }

    throw new AnatolyError(
      `Agent SDK error for ${task.file}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.LLM_API_ERROR,
      true,
    );
  } finally {
    clearTimeout(timeoutId);
    if (externalAbort) {
      externalAbort.signal.removeEventListener('abort', onExternalAbort);
    }
    // Flush transcript to disk (single write instead of per-line append)
    if (transcriptLines.length > 0) {
      writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
    }
  }
}

interface RunQueryParams {
  prompt: string;
  systemPrompt?: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  appendTranscript: (line: string) => void;
  resumeSessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Run a single Agent SDK query and return the result text.
 * Supports both initial queries (with systemPrompt) and resume queries.
 */
async function runQuery(params: RunQueryParams): Promise<QueryResult> {
  const { prompt, systemPrompt, model, projectRoot, abortController, appendTranscript, resumeSessionId, mcpServers } = params;

  const q = query({
    prompt,
    options: {
      ...(systemPrompt ? { systemPrompt } : {}),
      model,
      cwd: projectRoot,
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      maxTurns: 25,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(mcpServers ? { mcpServers } : {}),
    },
  });

  let resultText = '';
  let costUsd = 0;
  let sessionId = '';

  for await (const message of q) {
    appendTranscript(formatMessage(message));
    sessionId = 'session_id' in message ? (message.session_id as string) : sessionId;

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        const successMsg = message as SDKResultSuccess;
        resultText = successMsg.result;
        costUsd = successMsg.total_cost_usd;
        sessionId = successMsg.session_id;
      } else {
        const errorMsg = message as { errors: string[] };
        throw new AnatolyError(
          `Agent error: ${errorMsg.errors?.join(', ') ?? 'unknown'}`,
          ERROR_CODES.LLM_API_ERROR,
          true,
        );
      }
    }
  }

  return { resultText, costUsd, sessionId };
}

/**
 * Try to parse and validate a review response.
 * Returns either the validated data or an error string (never throws).
 */
export function tryParseReview(
  responseText: string,
  filePath: string,
): { success: true; data: ReviewFile } | { success: false; error: string } {
  const jsonStr = extractJson(responseText);

  if (!jsonStr) {
    return { success: false, error: `No valid JSON found in response for ${filePath}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: `Invalid JSON syntax in response for ${filePath}` };
  }

  const result = ReviewFileSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    return { success: false, error: formatted };
  }

  return { success: true, data: result.data };
}

/**
 * Extract JSON from agent response text and validate against ReviewFileSchema.
 * Throws AnatolyError on failure.
 */
export function parseReviewResponse(responseText: string, filePath: string): ReviewFile {
  const result = tryParseReview(responseText, filePath);
  if (result.success) return result.data;

  throw new AnatolyError(
    `Zod validation failed for ${filePath}: ${result.error}`,
    ERROR_CODES.ZOD_VALIDATION_FAILED,
    true,
  );
}

/**
 * Format Zod validation error into a feedback prompt for the agent.
 */
export function formatRetryFeedback(
  validationError: string,
  attempt: number,
  maxRetries: number,
): string {
  return `Your previous response failed Zod validation (attempt ${attempt}/${maxRetries}).

**Validation errors:**
  ${validationError}

Please fix these issues and output the corrected JSON object. Remember:
- Output ONLY the JSON object (no markdown fences, no explanation outside JSON)
- All required fields must be present
- Enum values must match exactly (e.g., "OK", "NEEDS_FIX", "ERROR" for correction)
- confidence must be an integer 0-100
- detail must be at least 10 characters
- Review ALL symbols from the original file`;
}


/**
 * Extract text content from an SDK message content array or string.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object' && 'type' in block) {
      if (block.type === 'text' && 'text' in block) {
        parts.push(block.text as string);
      } else if (block.type === 'tool_use' && 'name' in block) {
        const input = 'input' in block ? JSON.stringify(block.input, null, 2) : '';
        parts.push(`**Tool use:** \`${block.name}\`\n\`\`\`json\n${input}\n\`\`\``);
      } else if (block.type === 'tool_result' && 'content' in block) {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : extractTextContent(block.content);
        parts.push(`**Tool result:**\n${resultContent}`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Format an SDK message for the transcript log.
 */
function formatMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      const msg = message as SDKAssistantMessage;
      const text = extractTextContent(msg.message.content);
      return `## Assistant\n\n${text}\n`;
    }
    case 'user': {
      const msg = message as SDKUserMessage;
      const text = extractTextContent(msg.message.content);
      return `## User\n\n${text}\n`;
    }
    case 'system': {
      const msg = message as SDKSystemMessage;
      if (msg.subtype === 'init') {
        return `## System (init)\n\n**Model:** ${msg.model}\n**Tools:** ${msg.tools.join(', ')}\n**CWD:** ${msg.cwd}\n`;
      }
      return `## System (${msg.subtype})\n`;
    }
    case 'result': {
      if (message.subtype === 'success') {
        const msg = message as SDKResultSuccess;
        return `## Result (success)\n\n**Turns:** ${msg.num_turns} | **Cost:** $${msg.total_cost_usd.toFixed(4)} | **Duration:** ${(msg.duration_ms / 1000).toFixed(1)}s\n`;
      }
      const msg = message as SDKResultError;
      return `## Result (${msg.subtype})\n\n**Errors:** ${msg.errors?.join(', ') ?? 'unknown'}\n`;
    }
    default:
      return `## ${message.type}\n\n${JSON.stringify(message, null, 2)}\n`;
  }
}
