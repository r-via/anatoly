import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import { ReviewFileSchema } from '../schemas/review.js';
import { buildSystemPrompt, buildUserPrompt } from '../utils/prompt-builder.js';
import { toOutputName } from '../utils/cache.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';

export interface ReviewResult {
  review: ReviewFile;
  transcript: string;
  costUsd: number;
}

/**
 * Review a single file using the Claude Agent SDK.
 * Builds the system prompt, invokes the agent, streams the transcript,
 * and returns the validated ReviewFile result.
 */
export async function reviewFile(
  projectRoot: string,
  task: Task,
  config: Config,
): Promise<ReviewResult> {
  const systemPrompt = buildSystemPrompt(task);
  const userPrompt = buildUserPrompt(task);

  const anatolyDir = resolve(projectRoot, '.anatoly');
  const logsDir = join(anatolyDir, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const transcriptPath = join(logsDir, `${toOutputName(task.file)}.transcript.md`);
  const transcriptLines: string[] = [];

  // Append to transcript file
  const appendTranscript = (line: string): void => {
    transcriptLines.push(line);
    appendFileSync(transcriptPath, line + '\n');
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

  let resultText = '';
  let costUsd = 0;

  try {
    const q = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model: config.llm.model,
        cwd: projectRoot,
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        maxTurns: 25,
        persistSession: false,
      },
    });

    for await (const message of q) {
      appendTranscript(formatMessage(message));

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          const successMsg = message as SDKResultSuccess;
          resultText = successMsg.result;
          costUsd = successMsg.total_cost_usd;
        } else {
          const errorMsg = message;
          throw new AnatolyError(
            `Agent error for ${task.file}: ${(errorMsg as { errors: string[] }).errors?.join(', ') ?? 'unknown error'}`,
            ERROR_CODES.LLM_API_ERROR,
            true,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof AnatolyError) throw error;

    if (abortController.signal.aborted) {
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
  }

  // Parse and validate the response
  const review = parseReviewResponse(resultText, task.file);

  return {
    review,
    transcript: transcriptLines.join('\n'),
    costUsd,
  };
}

/**
 * Extract JSON from agent response text and validate against ReviewFileSchema.
 * The agent may include markdown fences or extra text around the JSON.
 */
export function parseReviewResponse(responseText: string, filePath: string): ReviewFile {
  const jsonStr = extractJson(responseText);

  if (!jsonStr) {
    throw new AnatolyError(
      `No valid JSON found in agent response for ${filePath}`,
      ERROR_CODES.ZOD_VALIDATION_FAILED,
      true,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new AnatolyError(
      `Invalid JSON in agent response for ${filePath}`,
      ERROR_CODES.ZOD_VALIDATION_FAILED,
      true,
    );
  }

  const result = ReviewFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new AnatolyError(
      `Zod validation failed for ${filePath}: ${issues}`,
      ERROR_CODES.ZOD_VALIDATION_FAILED,
      true,
    );
  }

  return result.data;
}

/**
 * Extract JSON object from a string that may contain markdown fences or surrounding text.
 */
function extractJson(text: string): string | null {
  // Try extracting from markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try to find a JSON object directly (first { to last })
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return null;
}

/**
 * Format an SDK message for the transcript log.
 */
function formatMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      const assistantMsg = message as SDKAssistantMessage;
      const content = assistantMsg.message.content;
      const textParts = Array.isArray(content)
        ? content
            .filter((c): c is { type: 'text'; text: string } => 'type' in c && c.type === 'text')
            .map((c) => c.text)
            .join('\n')
        : String(content);
      return `## Assistant\n\n${textParts}\n`;
    }
    case 'result':
      return `## Result\n\nSubtype: ${message.subtype}\n`;
    default:
      return `## ${message.type}\n\n(message logged)\n`;
  }
}
