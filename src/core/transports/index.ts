// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Request payload for an LLM transport call.
 */
export interface LlmRequest {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  conversationDir?: string;
  conversationPrefix?: string;
  /** Session ID to resume (for retry/continuation) */
  resumeSessionId?: string;
  /** Attempt number (1-based, for logging and conversation dump naming) */
  attempt?: number;
  /** Reason for retry (for structured logging) */
  retryReason?: string;
}

/**
 * Response from an LLM transport call.
 */
export interface LlmResponse {
  text: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
  sessionId: string;
}

/**
 * Common interface for LLM providers (Anthropic, Gemini, etc.).
 */
export interface LlmTransport {
  readonly provider: string;
  supports(model: string): boolean;
  query(params: LlmRequest): Promise<LlmResponse>;
}
