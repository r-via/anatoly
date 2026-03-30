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

/**
 * Extract the provider id from a model identifier.
 *
 * - Prefixed: `"anthropic/claude-sonnet-4-6"` → `"anthropic"`
 * - Bare `claude-*` → `"anthropic"`
 * - Bare `gemini-*` → `"google"`
 * - Unknown bare name → `"anthropic"` (default fallback)
 */
export function extractProvider(modelId: string): string {
  if (modelId.includes('/')) {
    return modelId.split('/')[0];
  }
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('gpt-')) return 'openai';
  return 'anthropic';
}

/**
 * Strip the provider prefix from a model identifier.
 * E.g. `"google/gemini-2.5-flash"` → `"gemini-2.5-flash"`, bare names pass through.
 */
export function stripPrefix(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
}

/**
 * Find the first model in the config that belongs to a given provider.
 * Searches `config.axes.*.model`, `config.models.*`, and `config.agents.*`.
 * Returns `undefined` if no model for the given provider is found.
 */
export function findModelForProvider(config: { axes: Record<string, { model?: string }>; models: Record<string, string | undefined>; agents: Record<string, unknown> }, providerId: string): string | undefined {
  // Check axes models first
  for (const axis of Object.values(config.axes)) {
    if (axis && axis.model && extractProvider(axis.model) === providerId) return axis.model;
  }
  // Check named models
  for (const value of Object.values(config.models)) {
    if (typeof value === 'string' && extractProvider(value) === providerId) return value;
  }
  // Check agents
  for (const [key, value] of Object.entries(config.agents)) {
    if (key !== 'enabled' && typeof value === 'string' && extractProvider(value) === providerId) return value;
  }
  return undefined;
}

/** Provider mode config used by the router. */
export interface ProviderModeConfig {
  mode: 'subscription' | 'api';
  single_turn?: 'subscription' | 'api';
  agents?: 'subscription' | 'api';
}

/** Task type for mode resolution. */
export type TaskType = 'single_turn' | 'agents';

/** Configuration for the mode-aware TransportRouter. */
export interface TransportRouterConfig {
  /** Native transports keyed by provider id (e.g. anthropic, google). */
  nativeTransports: Record<string, LlmTransport>;
  /** Vercel AI SDK transport for all api-mode calls. */
  vercelSdkTransport: LlmTransport;
  /** Provider mode configurations (from config.providers). */
  providerModes: Record<string, ProviderModeConfig>;
}

/**
 * Mode-aware transport router.
 *
 * Routes models to the appropriate transport based on the provider's configured
 * mode (subscription vs api) and optional task-level overrides (single_turn, agents).
 *
 * - subscription → native transport (AnthropicTransport, GeminiTransport)
 * - api → VercelSdkTransport
 */
export class TransportRouter {
  private readonly nativeTransports: Record<string, LlmTransport>;
  private readonly vercelSdkTransport: LlmTransport;
  private readonly providerModes: Record<string, ProviderModeConfig>;

  constructor(config: TransportRouterConfig) {
    this.nativeTransports = config.nativeTransports;
    this.vercelSdkTransport = config.vercelSdkTransport;
    this.providerModes = config.providerModes;
  }

  /**
   * Resolve a model to the appropriate transport.
   *
   * @param model - Model identifier (prefixed or bare)
   * @param task - Task type for mode override resolution (default: 'single_turn')
   */
  resolve(model: string, task: TaskType = 'single_turn'): LlmTransport {
    const providerId = extractProvider(model);
    const providerConfig = this.providerModes[providerId];

    // Determine effective mode: task-specific override > base mode > default api
    let effectiveMode: 'subscription' | 'api' = providerConfig?.mode ?? 'api';
    if (task === 'single_turn' && providerConfig?.single_turn) {
      effectiveMode = providerConfig.single_turn;
    } else if (task === 'agents' && providerConfig?.agents) {
      effectiveMode = providerConfig.agents;
    }

    // subscription → native transport if available
    if (effectiveMode === 'subscription') {
      const native = this.nativeTransports[providerId];
      if (native) return native;
      // No native transport for subscription mode — warn and fall through to API
      process.stderr.write(`⚠ ${providerId}: subscription mode requested but no native transport — falling back to API billing\n`);
    }

    // api or fallback → vercel-sdk
    return this.vercelSdkTransport;
  }
}
