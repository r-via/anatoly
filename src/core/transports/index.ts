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
  /** Session ID for resume support. Undefined when the transport has no session concept. */
  sessionId?: string;
}

import { Semaphore } from '../sdk-semaphore.js';
import { CircuitBreaker, type CircuitState } from '../circuit-breaker.js';
import { retryWithBackoff } from '../../utils/rate-limiter.js';

/**
 * Common interface for LLM providers (Anthropic, Gemini, etc.).
 */
export interface LlmTransport {
  readonly provider: string;
  supports(model: string): boolean;
  query(params: LlmRequest): Promise<LlmResponse>;
  /** When implemented, the transport supports agentic multi-turn queries with tools. */
  agenticQuery?(params: AgenticRequest): Promise<LlmResponse>;
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
  /** Max concurrent calls for this provider. Defaults to 10. */
  concurrency?: number;
}

/** Task type for mode resolution. */
export type TaskType = 'single_turn' | 'agents';

/**
 * Extended request for agentic (multi-turn, tool-use) queries.
 */
export interface AgenticRequest extends LlmRequest {
  /** Tool names the agent may invoke (e.g. 'Read', 'Grep', 'Glob', 'Bash', 'WebFetch'). */
  allowedTools: string[];
  /** Maximum agentic turns. When omitted, uses the provider's default. */
  maxTurns?: number;
  /** Project config — needed for model resolution and tool configuration. */
  config: import('../../schemas/config.js').Config;
}

/** Configuration for the mode-aware TransportRouter. */
export interface TransportRouterConfig {
  /** Native transports keyed by provider id (e.g. anthropic, google). */
  nativeTransports: Record<string, LlmTransport>;
  /** Vercel AI SDK transport for all api-mode calls. */
  vercelSdkTransport: LlmTransport;
  /** Provider mode configurations (from config.providers). */
  providerModes: Record<string, ProviderModeConfig>;
  /** Explicit per-provider concurrency overrides. Takes precedence over providerModes[].concurrency. */
  providerConcurrency?: Record<string, number>;
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
/** Default concurrency for providers without an explicit concurrency setting. */
const DEFAULT_PROVIDER_CONCURRENCY = 10;

export class TransportRouter {
  private readonly nativeTransports: Record<string, LlmTransport>;
  private readonly vercelSdkTransport: LlmTransport;
  private readonly providerModes: Record<string, ProviderModeConfig>;

  /** Per-provider concurrency semaphores. */
  readonly semaphores: Map<string, Semaphore>;
  /** Per-provider circuit breakers. */
  readonly breakers: Map<string, CircuitBreaker>;

  constructor(config: TransportRouterConfig) {
    this.nativeTransports = config.nativeTransports;
    this.vercelSdkTransport = config.vercelSdkTransport;
    this.providerModes = config.providerModes;

    // Create per-provider semaphores and breakers
    this.semaphores = new Map();
    this.breakers = new Map();
    for (const [providerId, providerConfig] of Object.entries(config.providerModes)) {
      const concurrency = config.providerConcurrency?.[providerId]
        ?? providerConfig.concurrency
        ?? DEFAULT_PROVIDER_CONCURRENCY;
      this.semaphores.set(providerId, new Semaphore(concurrency));
      this.breakers.set(providerId, new CircuitBreaker());
    }
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

  /**
   * Acquire a concurrency slot for the given model's provider.
   * Checks the circuit breaker first; if open, throws immediately.
   *
   * @returns An object with a `release` function. Call `release({ success })` in
   *   a finally block to free the slot and record breaker outcome.
   */
  async acquireSlot(model: string): Promise<{ release: (opts?: { success: boolean }) => void }> {
    const providerId = extractProvider(model);
    const breaker = this.breakers.get(providerId);

    if (breaker?.shouldFallback()) {
      throw new Error(`Provider '${providerId}' circuit breaker is open`);
    }

    const sem = this.semaphores.get(providerId);
    if (sem) await sem.acquire();

    let released = false;
    return {
      release: (opts?: { success: boolean }) => {
        if (released) return;
        released = true;
        if (sem) sem.release();
        if (breaker) {
          if (opts?.success === false) {
            breaker.recordFailure();
          } else {
            breaker.recordSuccess();
          }
        }
      },
    };
  }

  /**
   * Acquire a concurrency slot and resolve the transport for the given model.
   * Checks the circuit breaker first; if open, throws immediately.
   *
   * @param model - Model identifier (prefixed or bare)
   * @param task - Task type for mode resolution (default: 'single_turn')
   * @returns An object with the resolved `transport` and a `release` function.
   */
  async acquire(model: string, task: TaskType = 'single_turn'): Promise<{ transport: LlmTransport; release: (opts?: { success: boolean }) => void }> {
    const { release } = await this.acquireSlot(model);
    const transport = this.resolve(model, task);
    return { transport, release };
  }

  /**
   * Run an agentic query (multi-turn with tools) through the appropriate backend.
   *
   * Resolves the transport using the same mode logic as single-turn (subscription vs api),
   * with an agents-specific override. Each transport owns its agentic implementation:
   * - AnthropicTransport → Claude Code subprocess with tools
   * - VercelSdkTransport → Vercel AI SDK generateText() with tools
   * - GeminiTransport    → Gemini CLI (falls back to single-turn, tools not yet supported)
   *
   * **Retry contract:** This method manages retry/backoff internally (3 retries, 5s base,
   * 60s max, jitter 0.2). Callers MUST NOT wrap calls in their own retryWithBackoff.
   *
   * Handles slot acquisition, circuit breaker, retry/backoff, and release.
   */
  async agenticQuery(params: AgenticRequest): Promise<LlmResponse> {
    return retryWithBackoff(
      async () => {
        const { release } = await this.acquireSlot(params.model);
        let success = false;
        try {
          const transport = this.resolve(params.model, 'agents');

          if (!transport.agenticQuery) {
            throw new Error(`Transport '${transport.provider}' does not support agentic queries`);
          }

          const response = await transport.agenticQuery(params);
          success = true;
          return response;
        } finally {
          release({ success });
        }
      },
      {
        maxRetries: 3,
        baseDelayMs: 5000,
        maxDelayMs: 60_000,
        jitterFactor: 0.2,
        filePath: `agentic:${params.model}`,
      },
    );
  }

  /** Get semaphore stats (active/total) for all providers. */
  getSemaphoreStats(): Map<string, { active: number; total: number }> {
    const stats = new Map<string, { active: number; total: number }>();
    for (const [providerId, sem] of this.semaphores) {
      stats.set(providerId, { active: sem.running, total: sem.capacity });
    }
    return stats;
  }

  /** Get the circuit breaker state for a provider. */
  getBreakerState(providerId: string): CircuitState | undefined {
    return this.breakers.get(providerId)?.state;
  }
}
