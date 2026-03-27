// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { GoogleGenAI } from '@google/genai';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { contextLogger } from '../../utils/log-context.js';
import { initConvDump, appendAssistant, appendResult, appendError } from './conversation-dump.js';

/**
 * Gemini API pricing per 1M tokens (USD).
 * Source: https://ai.google.dev/pricing
 */
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite':  { input: 0.075,  output: 0.30 },
  'gemini-2.5-flash':       { input: 0.15,   output: 0.60 },
  'gemini-2.5-pro':         { input: 1.25,   output: 10.00 },
};

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = GEMINI_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * LlmTransport implementation using the @google/genai SDK directly.
 * Authenticates via GEMINI_API_KEY environment variable.
 * No OAuth, no session management, no console monkey-patching.
 */
export class GeminiGenaiTransport implements LlmTransport {
  readonly provider = 'gemini' as const;
  private readonly client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required for gemini type: genai');
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  supports(model: string): boolean {
    return model.startsWith('gemini-');
  }

  async query(params: LlmRequest): Promise<LlmResponse> {
    const { systemPrompt, userMessage, model, abortController, conversationDir, conversationPrefix, attempt } = params;
    const start = Date.now();
    const transcriptLines: string[] = [];

    // --- Conversation dump ---
    const dump = (conversationDir && conversationPrefix != null && attempt != null)
      ? initConvDump({ conversationDir, conversationPrefix, attempt, model, provider: 'gemini (genai)', systemPrompt, userMessage })
      : undefined;

    if (systemPrompt) {
      transcriptLines.push(`## System\n\n${systemPrompt}\n`);
    }
    transcriptLines.push(`## User\n\n${userMessage}\n`);

    try {
      const response = await this.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        config: {
          systemInstruction: systemPrompt || undefined,
          abortSignal: abortController.signal,
        },
      });

      const text = response.text ?? '';
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      const durationMs = Date.now() - start;
      const costUsd = computeCost(model, inputTokens, outputTokens);

      transcriptLines.push(`## Assistant\n\n${text}\n`);

      if (dump) {
        appendAssistant(dump, text);
        appendResult(dump, { durationMs, costUsd, inputTokens, outputTokens, success: true });
      }

      contextLogger().info(
        {
          event: 'llm_call',
          provider: 'gemini',
          model,
          attempt,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRate: 0,
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
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: transcriptLines.join('\n'),
        sessionId: '',
      };
    } catch (err) {
      if (dump) appendError(dump, err);

      contextLogger().info(
        {
          event: 'llm_call',
          provider: 'gemini',
          model,
          attempt,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheHitRate: 0,
          costUsd: 0,
          durationMs: Date.now() - start,
          success: false,
          ...(params.retryReason ? { retryReason: params.retryReason } : {}),
          error: {
            code: 'GEMINI_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        'LLM call failed',
      );
      throw err;
    }
  }
}
