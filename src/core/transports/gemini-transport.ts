// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import {
  Config,
  AuthType,
  getAuthTypeFromEnv,
  createSessionId,
} from '@google/gemini-cli-core';
import type { GeminiClient } from '@google/gemini-cli-core';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { contextLogger } from '../../utils/log-context.js';

/**
 * Reference-counted console suppression for gemini-cli-core noise.
 * Safe for concurrent use — only actually suppresses/restores when
 * the count transitions 0→1 or 1→0.
 */
let _suppressCount = 0;
let _origLog: typeof console.log;
let _origDebug: typeof console.debug;
let _origWarn: typeof console.warn;

function suppressConsole(): void {
  if (_suppressCount === 0) {
    _origLog = console.log;
    _origDebug = console.debug;
    _origWarn = console.warn;
    console.log = () => {};
    console.debug = () => {};
    console.warn = () => {};
  }
  _suppressCount++;
}

function restoreConsole(): void {
  _suppressCount--;
  if (_suppressCount === 0) {
    console.log = _origLog;
    console.debug = _origDebug;
    console.warn = _origWarn;
  }
}

/**
 * LlmTransport implementation for Google Gemini models.
 * Wraps `@google/gemini-cli-core` to provide streaming Gemini calls
 * through the common LlmTransport interface.
 *
 * Lazy-initializes the Config and GeminiClient on first query() call.
 */
export class GeminiTransport implements LlmTransport {
  readonly provider = 'gemini' as const;
  private readonly projectRoot: string;
  private readonly model: string;
  private config?: Config;
  private client?: GeminiClient;
  private _initPromise: Promise<void> | null = null;
  private _queryQueue: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string, model: string) {
    this.projectRoot = projectRoot;
    this.model = model;
  }

  /**
   * Returns true if this transport handles the given model identifier.
   * Matches any model name starting with `gemini-`.
   *
   * @param model - Model identifier to test (e.g. `"gemini-2.0-flash"`).
   */
  supports(model: string): boolean {
    return model.startsWith('gemini-');
  }

  /** Lazy-initialize Config + GeminiClient on first call. */
  private ensureInitialized(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._initialize().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  private async _initialize(): Promise<void> {
    suppressConsole();
    try {
      this.config = new Config({
        sessionId: createSessionId(),
        targetDir: this.projectRoot,
        cwd: this.projectRoot,
        debugMode: false,
        model: this.model,
        userMemory: '',
        enableHooks: false,
        mcpEnabled: false,
        extensionsEnabled: false,
      });

      const authType = getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE;
      await this.config.refreshAuth(authType);
      await this.config.initialize();
      this.client = this.config.geminiClient;
    } finally {
      restoreConsole();
    }
  }

  /**
   * Sends a streaming request to Gemini and returns the assembled response.
   *
   * Lazily initializes the underlying {@link GeminiClient} on first call.
   * Serializes concurrent calls through an internal queue to prevent
   * interleaved `resetChat`/`setSystemInstruction` on the shared client.
   * Console output is suppressed during the call to silence `gemini-cli-core` noise.
   *
   * Emits a structured `llm_call` event via {@link contextLogger} on both
   * success and failure paths.
   *
   * @param params - The LLM request payload (system prompt, user message, model, etc.).
   * @returns The assembled LLM response including text, token counts, and transcript.
   * @throws Re-throws any error from the underlying Gemini stream after logging it.
   */
  async query(params: LlmRequest): Promise<LlmResponse> {
    await this.ensureInitialized();
    const client = this.client!;

    // Serialize _doQuery calls to prevent interleaved resetChat/getChat/setSystemInstruction
    const prev = this._queryQueue;
    let resolve!: () => void;
    this._queryQueue = new Promise<void>((r) => {
      resolve = r;
    });

    await prev;

    const start = Date.now();
    const transcriptLines: string[] = [];

    suppressConsole();
    try {
      return await this._doQuery(client, params, start, transcriptLines);
    } catch (err) {
      // Emit structured llm_call event for failure
      contextLogger().info(
        {
          event: 'llm_call',
          provider: 'gemini',
          model: params.model,
          attempt: params.attempt,
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
    } finally {
      resolve();
      restoreConsole();
    }
  }

  /**
   * Core streaming query logic. Resets the chat, optionally sets a system
   * instruction, streams the user message, and accumulates content and
   * usage metadata into an {@link LlmResponse}.
   *
   * @param client - The initialized GeminiClient instance.
   * @param params - The LLM request payload.
   * @param start  - Timestamp (ms) when the outer query() call began, used for duration.
   * @param transcriptLines - Mutable array collecting transcript sections.
   */
  private async _doQuery(
    client: GeminiClient,
    params: LlmRequest,
    start: number,
    transcriptLines: string[],
  ): Promise<LlmResponse> {
    // History isolation — reset before each call
    await client.resetChat();

    // Set system instruction
    const chat = client.getChat();
    if (params.systemPrompt) {
      chat.setSystemInstruction(params.systemPrompt);
    }

    // Build transcript header
    if (params.systemPrompt) {
      transcriptLines.push(`## System\n\n${params.systemPrompt}\n`);
    }
    transcriptLines.push(`## User\n\n${params.userMessage}\n`);

    // Send message and consume stream
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = client.sendMessageStream(
      [{ text: params.userMessage }],
      params.abortController.signal,
      createSessionId(),
    );

    for await (const event of stream) {
      switch (event.type) {
        case 'content':
          text += event.value;
          break;
        case 'finished': {
          const finished = event.value as {
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
            };
          };
          if (finished.usageMetadata) {
            inputTokens = finished.usageMetadata.promptTokenCount ?? 0;
            outputTokens = finished.usageMetadata.candidatesTokenCount ?? 0;
          }
          break;
        }
      }
    }

    const durationMs = Date.now() - start;
    transcriptLines.push(`## Assistant\n\n${text}\n`);

    // Emit structured llm_call event
    contextLogger().info(
      {
        event: 'llm_call',
        provider: 'gemini',
        model: params.model,
        attempt: params.attempt,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheHitRate: 0,
        costUsd: 0,
        durationMs,
        success: true,
        ...(params.retryReason ? { retryReason: params.retryReason } : {}),
      },
      'LLM call complete',
    );

    return {
      text,
      costUsd: 0,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: transcriptLines.join('\n'),
      sessionId: '',
    };
  }
}
