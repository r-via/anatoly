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
import { appendFileSync } from 'node:fs';
import { stripPrefix, extractProvider, type LlmTransport, type LlmRequest, type LlmResponse } from './index.js';
import { calculateCost } from '../../utils/cost-calculator.js';
import { recordLlmCall } from '../../utils/llm-calls-sink.js';
import { AnatolyError, ERROR_CODES, isAuthFailureMessage, authError } from '../../utils/errors.js';
import { RateLimitStandbyError } from '../../utils/rate-limiter.js';
import { contextLogger } from '../../utils/log-context.js';
import { initConvDump, appendResult, appendError, type ConvDump } from './conversation-dump.js';

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
            ? (content as unknown as Array<Record<string, unknown>>)
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
    return extractProvider(model) !== 'google';
  }

  /**
   * Single-turn query: no tools, maxTurns=2.
   */
  async query(params: LlmRequest): Promise<LlmResponse> {
    return this._execute(params, { allowedTools: [], maxTurns: 2 });
  }

  /**
   * Agentic query: tools + multi-turn via Claude Code subprocess.
   */
  async agenticQuery(params: import('./index.js').AgenticRequest): Promise<LlmResponse> {
    return this._execute(params, {
      allowedTools: params.allowedTools,
      maxTurns: params.maxTurns ?? params.config.agents.max_turns,
    });
  }

  /**
   * Shared SDK execution logic for both single-turn and agentic modes.
   */
  private async _execute(
    params: LlmRequest,
    opts: { allowedTools: string[]; maxTurns: number },
  ): Promise<LlmResponse> {
    const {
      userMessage,
      systemPrompt,
      model: rawModel,
      projectRoot,
      abortController,
      conversationDir,
      resumeSessionId,
      attempt,
      retryReason,
    } = params;

    // Strip provider prefix for native SDK (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
    const model = stripPrefix(rawModel);

    const transcriptLines: string[] = [];

    // --- Conversation dump setup ---
    // doc 19 PR 3: dump prefix is derived by initConvDump from the active
    // ALS log-context (`{phase}__{composer}__{primitive}__{callId}`); the
    // caller no longer hands a `conversationPrefix` in.
    let convDump: ConvDump | undefined;
    let convPath: string | undefined;
    if (conversationDir && attempt != null) {
      convDump = initConvDump({ conversationDir, attempt, model: rawModel, provider: 'anthropic', systemPrompt, userMessage });
      convPath = convDump?.path;
    }

    // --- SDK call ---
    const q = query({
      prompt: userMessage,
      options: {
        ...(systemPrompt ? { systemPrompt } : {}),
        model,
        cwd: projectRoot,
        allowedTools: opts.allowedTools,
        maxTurns: opts.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        persistSession: true,
        // doc 16 root cause: on the FIRST query() of a run the bundled
        // `claude` CLI bootstraps the official plugin marketplace via
        // `git clone anthropics/claude-plugins-official` (built-in
        // timeout 120000ms, SSH URL first). In a network-restricted /
        // IPv6-blackhole env that stalls the whole 120s, and whatever
        // unit makes the run's first SDK call (doc-conflict-detection)
        // wears the abort. anatoly drives the SDK purely programmatically
        // (explicit allowedTools, bypassPermissions) — it never uses
        // plugins, the marketplace, or the auto-updater. Disable that
        // dead-weight bootstrap for every call; spread process.env first
        // since the SDK's `env` REPLACES it (defaults to process.env).
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        } as Record<string, string>,
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
            durationMs = success.duration_ms ?? 0;
            sessionId = success.session_id;

            if (success.usage) {
              // The Claude Agent SDK's `NonNullableUsage` is derived from the
              // upstream `BetaUsage` type, which mirrors the Anthropic API and
              // uses snake_case keys (`input_tokens`, `output_tokens`, …). The
              // prior camelCase reads silently fell through to `?? 0` on every
              // call, which is why every entry in `costs/ledger.ndjson` and the
              // run-metrics axisStats reported 0 tokens despite a non-zero
              // costUsd. Fall back to camelCase shapes only as a defensive
              // path in case a future SDK version normalizes the keys.
              const u = success.usage as unknown as {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                inputTokens?: number;
                outputTokens?: number;
                cacheReadInputTokens?: number;
                cacheCreationInputTokens?: number;
              };
              inputTokens += u.input_tokens ?? u.inputTokens ?? 0;
              outputTokens += u.output_tokens ?? u.outputTokens ?? 0;
              cacheReadTokens += u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0;
              cacheCreationTokens += u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0;
            }

            // Prefer the SDK's precise cost (accounts for cache discount and
            // creation premium); fall back to our own table only when the
            // SDK omits it.
            costUsd = success.total_cost_usd
              ?? calculateCost(rawModel, inputTokens, outputTokens, projectRoot, {
                read: cacheReadTokens,
                creation: cacheCreationTokens,
              });
          } else {
            const errorResult = message as SDKResultError;
            const details =
              errorResult.errors?.join(', ') || errorResult.subtype || 'unknown';
            // A 401 / bad-credential is fatal and non-recoverable: do not
            // dress it as a generic (retryable) SDK error.
            if (isAuthFailureMessage(details) || isAuthFailureMessage(transcriptLines.join('\n'))) {
              throw authError('anthropic', transcriptLines.join('\n'));
            }
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
      if (convDump) {
        appendError(convDump, err);
      }

      // Emit llm_call event for failed call
      const failureError = {
        code:
          err instanceof AnatolyError ? (err as AnatolyError).code : 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      };
      contextLogger().info(
        {
          event: 'llm_call',
          provider: 'anthropic',
          model,
          attempt,
          inputTokens,
          outputTokens,
          cacheHit: cacheReadTokens > 0,
          costUsd,
          durationMs,
          success: false,
          ...(retryReason ? { retryReason } : {}),
          error: failureError,
          ...(convDump?.fileName
            ? { conversationFile: `conversations/${convDump?.fileName}` }
            : {}),
        },
        'LLM call failed',
      );
      recordLlmCall({
        provider: 'anthropic',
        model,
        ...(attempt != null ? { attempt } : {}),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd: null,
        costSource: 'unknown',
        pricingModel: 'subscription-claude-code-sdk',
        durationMs,
        success: false,
        ...(retryReason ? { retryReason } : {}),
        error: failureError,
        ...(convDump?.fileName
          ? { conversationFile: `conversations/${convDump.fileName}` }
          : {}),
      });

      const rawMessage = err instanceof Error ? err.message : String(err);
      const partial =
        transcriptLines.length > 0 ? transcriptLines.join('\n') : undefined;
      // Auth failure detection: the SDK exits code 1 on a 401 with the auth
      // error only in the streamed transcript ("Failed to authenticate. API
      // Error: 401"), not in the thrown message. Surface it as the canonical
      // non-recoverable auth error so the orchestrator stops the whole run.
      if (isAuthFailureMessage(rawMessage) || isAuthFailureMessage(partial)) {
        throw authError('anthropic', partial);
      }
      if (err instanceof AnatolyError) throw err;
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
    if (convDump) {
      appendResult(convDump, { durationMs, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheHitRate, success: true });
    }

    // Emit structured llm_call event
    recordLlmCall({
      provider: 'anthropic',
      model,
      ...(attempt != null ? { attempt } : {}),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: null,
      costSource: 'unknown',
      pricingModel: 'subscription-claude-code-sdk',
      durationMs,
      success: true,
      ...(retryReason ? { retryReason } : {}),
      ...(convDump?.fileName
        ? { conversationFile: `conversations/${convDump.fileName}` }
        : {}),
    });
    contextLogger().info(
      {
        event: 'llm_call',
        provider: 'anthropic',
        model,
        attempt,
        inputTokens,
        outputTokens,
        cacheHit: cacheReadTokens > 0,
        costUsd,
        durationMs,
        success: true,
        ...(retryReason ? { retryReason } : {}),
        ...(convDump?.fileName
          ? { conversationFile: `conversations/${convDump?.fileName}` }
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
