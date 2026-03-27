// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { AnatolyError, ERROR_CODES } from '../../utils/errors.js';
import { RateLimitStandbyError } from '../../utils/rate-limiter.js';
import { contextLogger } from '../../utils/log-context.js';

// ---------------------------------------------------------------------------
// Transcript formatting (extracted from axis-evaluator.ts)
// ---------------------------------------------------------------------------

function formatMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      const msg = message as SDKAssistantMessage;
      const content = msg.message.content;
      const text =
        typeof content === 'string'
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
      const text =
        typeof msg.message.content === 'string'
          ? msg.message.content
          : JSON.stringify(msg.message.content);
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

// ---------------------------------------------------------------------------
// AnthropicTransport — wraps Claude SDK via @anthropic-ai/claude-agent-sdk
// ---------------------------------------------------------------------------

/**
 * LlmTransport implementation for Anthropic/Claude models.
 * Encapsulates the Claude Agent SDK call, conversation dumps, rate-limit
 * detection, and structured logging.
 */
export class AnthropicTransport implements LlmTransport {
  readonly provider = 'anthropic' as const;

  supports(model: string): boolean {
    return !model.startsWith('gemini-');
  }

  async query(params: LlmRequest): Promise<LlmResponse> {
    const {
      userMessage,
      systemPrompt,
      model,
      projectRoot,
      abortController,
      conversationDir,
      conversationPrefix,
      resumeSessionId,
      attempt,
      retryReason,
    } = params;

    const transcriptLines: string[] = [];

    // --- Conversation dump setup ---
    let convPath: string | undefined;
    let convFileName: string | undefined;
    if (conversationDir && conversationPrefix != null && attempt != null) {
      try {
        mkdirSync(conversationDir, { recursive: true });
        const suffix = `__${attempt}.md`;
        const rawName = `${conversationPrefix}${suffix}`;
        const safeName =
          rawName.length > 250
            ? conversationPrefix.slice(0, 250 - suffix.length) + suffix
            : rawName;
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
        header += `## User\n\n${userMessage}\n\n---\n\n`;
        writeFileSync(convPath, header);
      } catch {
        convPath = undefined;
      }
    }

    // --- SDK call ---
    const q = query({
      prompt: userMessage,
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
    let rateLimitResetsAt: number | undefined;

    try {
      for await (const message of q) {
        transcriptLines.push(formatMessage(message));

        // Detect tier-level rate limit
        if (message.type === 'rate_limit_event') {
          const info = (message as Record<string, unknown>).rate_limit_info as
            | { status?: string; resetsAt?: number }
            | undefined;
          if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
            rateLimitResetsAt = info.resetsAt * 1000;
          }
        }

        // Stream assistant response to conversation dump
        if (convPath && message.type === 'assistant') {
          try {
            appendFileSync(convPath, formatMessage(message) + '\n---\n\n');
          } catch (e) {
            contextLogger().warn(
              {
                err: e instanceof Error ? e.message : String(e),
                path: convPath,
              },
              'conversation dump append failed',
            );
            convPath = undefined;
          }
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const success = message as SDKResultSuccess;
            resultText = success.result;
            costUsd = success.total_cost_usd ?? 0;
            durationMs = success.duration_ms ?? 0;
            sessionId = success.session_id;

            if (success.usage) {
              const u = success.usage as Record<string, number>;
              inputTokens += u.input_tokens ?? 0;
              outputTokens += u.output_tokens ?? 0;
              cacheReadTokens += u.cache_read_input_tokens ?? 0;
              cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
            }
          } else {
            const errorResult = message as SDKResultError;
            const details =
              errorResult.errors?.join(', ') || errorResult.subtype || 'unknown';
            throw new AnatolyError(
              `Claude Code SDK error [${errorResult.subtype}]: ${details}`,
              ERROR_CODES.SDK_ERROR,
              true,
            );
          }
        }
      }
    } catch (err) {
      // Append error to conversation dump
      if (convPath) {
        try {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const errorCode =
            err instanceof AnatolyError ? (err as AnatolyError).code : 'UNKNOWN';
          appendFileSync(
            convPath,
            `## Error\n\n**Type:** ${errorCode}\n**Message:** ${errorMsg}\n`,
          );
        } catch {
          /* best-effort */
        }
      }

      // Emit llm_call event for failed call
      contextLogger().info(
        {
          event: 'llm_call',
          provider: 'anthropic',
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
            code:
              err instanceof AnatolyError ? (err as AnatolyError).code : 'UNKNOWN',
            message: err instanceof Error ? err.message : String(err),
          },
          ...(convFileName
            ? { conversationFile: `conversations/${convFileName}` }
            : {}),
        },
        'LLM call failed',
      );

      if (err instanceof AnatolyError) throw err;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const partial =
        transcriptLines.length > 0 ? transcriptLines.join('\n') : undefined;
      throw new AnatolyError(
        `Claude Code SDK query failed: ${rawMessage}`,
        ERROR_CODES.SDK_ERROR,
        true,
        undefined,
        partial,
      );
    }

    // Guard: tier-level rate limit
    if (rateLimitResetsAt != null && costUsd === 0) {
      throw new RateLimitStandbyError(rateLimitResetsAt);
    }

    // Guard: no result message
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
        contextLogger().warn(
          { err: e instanceof Error ? e.message : String(e), path: convPath },
          'conversation dump result write failed',
        );
      }
    }

    // Emit structured llm_call event
    contextLogger().info(
      {
        event: 'llm_call',
        provider: 'anthropic',
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
        ...(convFileName
          ? { conversationFile: `conversations/${convFileName}` }
          : {}),
      },
      'LLM call complete',
    );

    return {
      text: resultText,
      costUsd,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript: transcriptLines.join('\n'),
      sessionId,
    };
  }
}
