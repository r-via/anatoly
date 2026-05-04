// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LlmTransport, LlmRequest, LlmResponse, AgenticRequest } from './index.js';
import { extractProvider, EVALUATOR_TEMPERATURE } from './index.js';
import { resolveProvider } from '../providers/known-providers.js';
import { getProviderHeaders } from '../providers/attribution.js';
import { calculateCost } from '../../utils/cost-calculator.js';
import { recordLlmCall } from '../../utils/llm-calls-sink.js';
import { contextLogger } from '../../utils/log-context.js';
import { initConvDump, appendAssistant, appendResult, appendError } from './conversation-dump.js';
import { runVercelAgent } from '../agents/vercel-agent.js';
import type { Config } from '../../schemas/config.js';

/**
 * Resolve a model identifier to a Vercel AI SDK model instance.
 *
 * Uses `extractProvider()` to identify the provider, then delegates to the
 * appropriate AI SDK factory (`@ai-sdk/anthropic`, `@ai-sdk/google`,
 * `@ai-sdk/openai`, or `@ai-sdk/openai-compatible`).
 *
 * @throws If the provider's API key is missing (except for ollama)
 */
export function getVercelModel(
  modelId: string,
  config: Config,
): ReturnType<typeof anthropic> {
  const providerId = extractProvider(modelId);
  const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;

  // Resolve provider config (registry defaults + user overrides)
  const providerConfig = resolveProvider(
    providerId,
    (config.providers as Record<string, Record<string, unknown>>)[providerId] ?? {},
  );

  // Check API key (ollama doesn't require one)
  const apiKey = process.env[providerConfig.env_key];
  if (!apiKey && providerId !== 'ollama') {
    throw new Error(
      `No API key for provider "${providerId}". Set ${providerConfig.env_key} in your environment.`,
    );
  }

  // Native SDK providers
  if (providerConfig.type === 'native') {
    if (providerId === 'anthropic') return anthropic(bareModel);
    if (providerId === 'google') return google(bareModel);
    if (providerId === 'openai') return openai(bareModel);
  }

  // OpenAI-compatible providers
  const provider = createOpenAICompatible({
    baseURL: providerConfig.base_url!,
    name: providerId,
    apiKey: apiKey ?? '',
    headers: getProviderHeaders(providerId),
  });
  return provider(bareModel) as ReturnType<typeof anthropic>;
}

/**
 * Unified LLM transport using Vercel AI SDK.
 *
 * Handles any provider in `api` mode via `generateText()`. Provider-specific
 * details (URL, auth, model resolution) are handled by `getVercelModel()`.
 */
export class VercelSdkTransport implements LlmTransport {
  readonly provider = 'vercel-sdk' as const;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  supports(_model: string): boolean {
    return true;
  }

  /**
   * Single-turn query: no tools.
   */
  async query(params: LlmRequest): Promise<LlmResponse> {
    const { systemPrompt, userMessage, model: modelId, abortController, conversationDir, conversationPrefix, attempt } = params;
    const start = Date.now();
    const transcriptLines: string[] = [];
    const providerId = extractProvider(modelId);

    // --- Conversation dump ---
    const dump = (conversationDir && conversationPrefix != null && attempt != null)
      ? initConvDump({ conversationDir, conversationPrefix, attempt, model: modelId, provider: `vercel-sdk (${providerId})`, systemPrompt, userMessage })
      : undefined;

    if (systemPrompt) {
      transcriptLines.push(`## System\n\n${systemPrompt}\n`);
    }
    transcriptLines.push(`## User\n\n${userMessage}\n`);

    try {
      const model = getVercelModel(modelId, this.config);
      const result = await generateText({
        model,
        system: systemPrompt || undefined,
        prompt: userMessage,
        // Pin temperature for run-to-run reproducibility on evaluator
        // pipelines. Without this, the SDK inherits its provider's
        // default (~1.0 across @ai-sdk/anthropic, @ai-sdk/google,
        // @ai-sdk/openai), which made bench measurements noisy.
        temperature: params.temperature ?? EVALUATOR_TEMPERATURE,
        abortSignal: abortController.signal,
      });

      const text = result.text ?? '';
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      const rawCached = (result.usage as Record<string, unknown>)?.cachedInputTokens;
      const cacheReadTokens = typeof rawCached === 'number' ? rawCached : 0;
      const durationMs = Date.now() - start;
      // Vercel AI SDK's unified usage shape doesn't expose cache_creation
      // tokens (only cache_read via `cachedInputTokens`), so we pass `read`
      // only. The cache_creation contribution is implicitly folded into the
      // `inputTokens` count, which means underlying Anthropic-routed calls
      // get costed at the input rate for those tokens — close enough until
      // Vercel SDK exposes the full cache breakdown.
      const costUsd = calculateCost(modelId, inputTokens, outputTokens, params.projectRoot, {
        read: cacheReadTokens,
      });

      transcriptLines.push(`## Assistant\n\n${text}\n`);

      if (dump) {
        appendAssistant(dump, text);
        appendResult(dump, { durationMs, costUsd, inputTokens, outputTokens, success: true });
      }

      recordLlmCall({
        provider: providerId,
        model: modelId,
        ...(attempt != null ? { attempt } : {}),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        costUsd,
        durationMs,
        success: true,
        ...(params.retryReason ? { retryReason: params.retryReason } : {}),
      });
      contextLogger().info(
        {
          event: 'llm_call',
          provider: providerId,
          model: modelId,
          attempt,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens: 0,
          cacheHitRate: inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 100) : 0,
          costUsd,
          durationMs,
          success: true,
          ...(params.retryReason ? { retryReason: params.retryReason } : {}),
        },
        'LLM call complete',
      );

      return {
        text,
        costUsd,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        transcript: transcriptLines.join('\n'),
        sessionId: undefined,
      };
    } catch (err) {
      if (dump) appendError(dump, err);

      const failureError = {
        code: 'VERCEL_SDK_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
      const failureDuration = Date.now() - start;
      recordLlmCall({
        provider: providerId,
        model: modelId,
        ...(attempt != null ? { attempt } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: failureDuration,
        success: false,
        ...(params.retryReason ? { retryReason: params.retryReason } : {}),
        error: failureError,
      });
      contextLogger().info(
        {
          event: 'llm_call',
          provider: providerId,
          model: modelId,
          attempt,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRate: 0,
          costUsd: 0,
          durationMs: failureDuration,
          success: false,
          ...(params.retryReason ? { retryReason: params.retryReason } : {}),
          error: failureError,
        },
        'LLM call failed',
      );
      throw err;
    }
  }

  /**
   * Agentic query: tools + multi-turn via Vercel AI SDK generateText() with tools.
   */
  async agenticQuery(params: AgenticRequest): Promise<LlmResponse> {
    const start = Date.now();
    const providerId = extractProvider(params.model);

    const dump = (params.conversationDir && params.conversationPrefix != null && params.attempt != null)
      ? initConvDump({
          conversationDir: params.conversationDir,
          conversationPrefix: params.conversationPrefix,
          attempt: params.attempt,
          model: params.model,
          provider: `vercel-sdk (${providerId})`,
          systemPrompt: params.systemPrompt,
          userMessage: params.userMessage,
        })
      : undefined;

    try {
      const result = await runVercelAgent({
        systemPrompt: params.systemPrompt,
        userMessage: params.userMessage,
        model: params.model,
        projectRoot: params.projectRoot,
        config: params.config,
        abortController: params.abortController,
        maxSteps: params.maxTurns ?? params.config.agents.max_turns,
        allowWrite: false,
        allowSearch: params.allowedTools.includes('WebSearch'),
      });

      if (dump) {
        appendAssistant(dump, result.text);
        appendResult(dump, {
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          success: true,
        });
      }

      const totalTokens = result.inputTokens + result.cacheReadTokens;
      const cacheHitRate = totalTokens > 0 ? Math.round((result.cacheReadTokens / totalTokens) * 100) : 0;

      recordLlmCall({
        provider: providerId,
        model: params.model,
        ...(params.attempt != null ? { attempt: params.attempt } : {}),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: 0,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        success: true,
        ...(params.retryReason ? { retryReason: params.retryReason } : {}),
      });
      contextLogger().info(
        {
          event: 'llm_call',
          provider: providerId,
          model: params.model,
          attempt: params.attempt,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: 0,
          cacheHitRate,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          success: true,
          ...(params.retryReason ? { retryReason: params.retryReason } : {}),
        },
        'LLM call complete (agentic)',
      );

      return {
        text: result.text,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: 0,
        transcript: result.text,
        sessionId: undefined,
      };
    } catch (err) {
      if (dump) appendError(dump, err);

      const failureError = {
        code: 'VERCEL_SDK_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
      const failureDuration = Date.now() - start;
      recordLlmCall({
        provider: providerId,
        model: params.model,
        ...(params.attempt != null ? { attempt: params.attempt } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: failureDuration,
        success: false,
        error: failureError,
      });
      contextLogger().info(
        {
          event: 'llm_call',
          provider: providerId,
          model: params.model,
          attempt: params.attempt,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRate: 0,
          costUsd: 0,
          durationMs: failureDuration,
          success: false,
          error: failureError,
        },
        'LLM call failed (agentic)',
      );
      throw err;
    }
  }
}
