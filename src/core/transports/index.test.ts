// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { TransportRouter, extractProvider } from './index.js';
import type { CircuitState } from '../circuit-breaker.js';

// ---------------------------------------------------------------------------
// Stub transports for testing
// ---------------------------------------------------------------------------

function createStubTransport(
  provider: string,
  supportsFn: (model: string) => boolean,
  response?: Partial<LlmResponse>,
): LlmTransport {
  return {
    provider,
    supports: supportsFn,
    query: async (_params: LlmRequest): Promise<LlmResponse> => ({
      text: 'stub response',
      costUsd: 0,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: '## Stub transcript',
      sessionId: 'stub-session',
      ...response,
    }),
  };
}

// ---------------------------------------------------------------------------
// LlmTransport interface shape
// ---------------------------------------------------------------------------

describe('LlmTransport interface', () => {
  it('has readonly provider, supports(), and query()', () => {
    const transport = createStubTransport('test', () => true);
    expect(transport.provider).toBe('test');
    expect(typeof transport.supports).toBe('function');
    expect(typeof transport.query).toBe('function');
  });

  it('supports() returns boolean', () => {
    const transport = createStubTransport('anthropic', (m) => !m.startsWith('gemini-'));
    expect(transport.supports('claude-sonnet-4-20250514')).toBe(true);
    expect(transport.supports('gemini-2.5-flash')).toBe(false);
  });

  it('query() returns LlmResponse with all required fields', async () => {
    const transport = createStubTransport('anthropic', () => true, {
      text: 'Hello',
      costUsd: 0.001,
      durationMs: 250,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      transcript: '## Transcript',
      sessionId: 'sess-123',
    });

    const request: LlmRequest = {
      systemPrompt: 'You are a helpful assistant.',
      userMessage: 'Hello',
      model: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/test',
      abortController: new AbortController(),
    };

    const response = await transport.query(request);
    expect(response.text).toBe('Hello');
    expect(response.costUsd).toBe(0.001);
    expect(response.durationMs).toBe(250);
    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(50);
    expect(response.cacheReadTokens).toBe(20);
    expect(response.cacheCreationTokens).toBe(10);
    expect(response.transcript).toBe('## Transcript');
    expect(response.sessionId).toBe('sess-123');
  });
});

// ---------------------------------------------------------------------------
// LlmRequest shape
// ---------------------------------------------------------------------------

describe('LlmRequest', () => {
  it('includes required fields', () => {
    const request: LlmRequest = {
      systemPrompt: 'System prompt',
      userMessage: 'User message',
      model: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/test',
      abortController: new AbortController(),
    };
    expect(request.systemPrompt).toBe('System prompt');
    expect(request.userMessage).toBe('User message');
    expect(request.model).toBe('claude-sonnet-4-20250514');
    expect(request.projectRoot).toBe('/tmp/test');
    expect(request.abortController).toBeInstanceOf(AbortController);
  });

  it('includes optional fields', () => {
    const request: LlmRequest = {
      systemPrompt: 'System prompt',
      userMessage: 'User message',
      model: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/test',
      abortController: new AbortController(),
      conversationDir: '/tmp/conversations',
      conversationPrefix: 'test-prefix',
    };
    expect(request.conversationDir).toBe('/tmp/conversations');
    expect(request.conversationPrefix).toBe('test-prefix');
  });
});

// ---------------------------------------------------------------------------
// TransportRouter
// ---------------------------------------------------------------------------

describe('TransportRouter — basic', () => {
  const stubAnthropic = createStubTransport('anthropic', () => true);
  const stubVercel = createStubTransport('vercel-sdk', () => true);

  it('resolve() routes subscription-mode provider to native transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropic },
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'subscription' } },
    });
    expect(router.resolve('claude-sonnet-4-20250514')).toBe(stubAnthropic);
  });

  it('resolve() routes api-mode provider to vercel-sdk', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropic },
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'api' } },
    });
    expect(router.resolve('claude-sonnet-4-20250514')).toBe(stubVercel);
  });

  it('resolve() defaults to vercel-sdk for unknown providers', () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: {},
    });
    expect(router.resolve('groq/llama-3-70b')).toBe(stubVercel);
  });
});

// ---------------------------------------------------------------------------
// extractProvider — Story 43.3
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TransportRouter — mode-aware resolve (Story 43.5)
// ---------------------------------------------------------------------------

describe('TransportRouter — mode-aware resolve', () => {
  const stubAnthropicNative = createStubTransport('anthropic-native', () => true);
  const stubGeminiNative = createStubTransport('gemini-native', () => true);
  const stubVercelSdk = createStubTransport('vercel-sdk', () => true);

  it('resolve() routes subscription-mode anthropic to native transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative, google: stubGeminiNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'subscription' } },
    });
    expect(router.resolve('anthropic/claude-sonnet-4-6')).toBe(stubAnthropicNative);
  });

  it('resolve() routes api-mode anthropic to vercel-sdk transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative, google: stubGeminiNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'api' } },
    });
    expect(router.resolve('anthropic/claude-sonnet-4-6')).toBe(stubVercelSdk);
  });

  it('resolve() routes subscription-mode google to native gemini transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative, google: stubGeminiNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { google: { mode: 'subscription' } },
    });
    expect(router.resolve('google/gemini-2.5-flash')).toBe(stubGeminiNative);
  });

  it('resolve() routes api-mode google to vercel-sdk transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative, google: stubGeminiNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { google: { mode: 'api' } },
    });
    expect(router.resolve('google/gemini-2.5-flash')).toBe(stubVercelSdk);
  });

  it('resolve() uses single_turn mode override when task is single_turn', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'api', single_turn: 'subscription' } },
    });
    expect(router.resolve('anthropic/claude-sonnet-4-6', 'single_turn')).toBe(stubAnthropicNative);
  });

  it('resolve() uses agents mode override when task is agents', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'subscription', agents: 'api' } },
    });
    expect(router.resolve('anthropic/claude-sonnet-4-6', 'agents')).toBe(stubVercelSdk);
  });

  it('resolve() defaults task to single_turn when not specified', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'api', single_turn: 'subscription' } },
    });
    // No task arg → defaults to single_turn → uses single_turn override
    expect(router.resolve('anthropic/claude-sonnet-4-6')).toBe(stubAnthropicNative);
  });

  it('resolve() falls through to vercel-sdk for providers without native transport', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { openai: { mode: 'api' } },
    });
    expect(router.resolve('openai/gpt-4o')).toBe(stubVercelSdk);
  });

  it('resolve() handles bare model names via extractProvider', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative, google: stubGeminiNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: { anthropic: { mode: 'subscription' }, google: { mode: 'subscription' } },
    });
    expect(router.resolve('claude-sonnet-4-6')).toBe(stubAnthropicNative);
    expect(router.resolve('gemini-2.5-flash')).toBe(stubGeminiNative);
  });

  it('resolve() defaults unknown providers to api mode (vercel-sdk)', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropicNative },
      vercelSdkTransport: stubVercelSdk,
      providerModes: {},
    });
    expect(router.resolve('groq/llama-3-70b')).toBe(stubVercelSdk);
  });
});

describe('extractProvider', () => {
  it('should extract provider from prefixed model id', () => {
    expect(extractProvider('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(extractProvider('google/gemini-2.5-flash')).toBe('google');
    expect(extractProvider('openai/gpt-4o')).toBe('openai');
    expect(extractProvider('groq/llama-3-70b')).toBe('groq');
  });

  it('should infer anthropic from claude-* bare names', () => {
    expect(extractProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(extractProvider('claude-opus-4-6')).toBe('anthropic');
    expect(extractProvider('claude-haiku-4-5-20251001')).toBe('anthropic');
    expect(extractProvider('claude-opus-4-20250514')).toBe('anthropic');
  });

  it('should infer google from gemini-* bare names', () => {
    expect(extractProvider('gemini-2.5-flash')).toBe('google');
    expect(extractProvider('gemini-2.5-flash-lite')).toBe('google');
    expect(extractProvider('gemini-3-flash-preview')).toBe('google');
  });

  it('should return anthropic as default for unknown bare names', () => {
    expect(extractProvider('some-unknown-model')).toBe('anthropic');
    expect(extractProvider('llama-3-70b')).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// TransportRouter — per-provider semaphores & breakers (Story 46.1)
// ---------------------------------------------------------------------------

describe('TransportRouter — semaphores & breakers (Story 46.1)', () => {
  const stubVercel = createStubTransport('vercel-sdk', () => true);
  const stubAnthropic = createStubTransport('anthropic-native', () => true);

  it('should create per-provider semaphores from concurrency config', () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropic },
      vercelSdkTransport: stubVercel,
      providerModes: {
        anthropic: { mode: 'subscription', concurrency: 24 },
        google: { mode: 'api', concurrency: 10 },
      },
    });
    const stats = router.getSemaphoreStats();
    expect(stats.get('anthropic')).toEqual({ active: 0, total: 24 });
    expect(stats.get('google')).toEqual({ active: 0, total: 10 });
  });

  it('should default concurrency to 10 when not specified', () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { ollama: { mode: 'api' } },
    });
    const stats = router.getSemaphoreStats();
    expect(stats.get('ollama')).toEqual({ active: 0, total: 10 });
  });

  it('should create a circuit breaker for each provider', () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: {
        anthropic: { mode: 'subscription' },
        google: { mode: 'api' },
      },
    });
    expect(router.getBreakerState('anthropic')).toBe('closed');
    expect(router.getBreakerState('google')).toBe('closed');
  });

  it('getSemaphoreStats() should reflect acquired slots', async () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropic },
      vercelSdkTransport: stubVercel,
      providerModes: {
        anthropic: { mode: 'subscription', concurrency: 24 },
        google: { mode: 'api', concurrency: 10 },
      },
    });

    // Acquire 3 slots on anthropic
    const sem = router.semaphores.get('anthropic')!;
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    const stats = router.getSemaphoreStats();
    expect(stats.get('anthropic')).toEqual({ active: 3, total: 24 });
    expect(stats.get('google')).toEqual({ active: 0, total: 10 });

    // Cleanup
    sem.release();
    sem.release();
    sem.release();
  });

  it('getBreakerState() should return undefined for unknown provider', () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'subscription' } },
    });
    expect(router.getBreakerState('unknown')).toBeUndefined();
  });

  it('breakers should track failures and trip', () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { google: { mode: 'api' } },
    });

    const breaker = router.breakers.get('google')!;
    expect(router.getBreakerState('google')).toBe('closed');

    // 3 consecutive failures should trip the breaker (default threshold)
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(router.getBreakerState('google')).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// TransportRouter — acquire / acquireSlot / release (Story 46.2)
// ---------------------------------------------------------------------------

describe('TransportRouter — acquire / acquireSlot / release (Story 46.2)', () => {
  const stubVercel = createStubTransport('vercel-sdk', () => true);
  const stubAnthropic = createStubTransport('anthropic-native', () => true);
  const stubGoogle = createStubTransport('google-native', () => true);

  it('acquire() returns transport and release when breaker is closed', async () => {
    const router = new TransportRouter({
      nativeTransports: { google: stubGoogle },
      vercelSdkTransport: stubVercel,
      providerModes: { google: { mode: 'subscription', concurrency: 10 } },
    });
    const { transport, release } = await router.acquire('google/gemini-2.5-flash');
    expect(transport).toBe(stubGoogle);
    const stats = router.getSemaphoreStats();
    expect(stats.get('google')!.active).toBe(1);
    release();
    expect(router.getSemaphoreStats().get('google')!.active).toBe(0);
  });

  it('acquire() throws when breaker is open', async () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { google: { mode: 'api', concurrency: 10 } },
    });
    // Trip the breaker
    const breaker = router.breakers.get('google')!;
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await expect(router.acquire('google/gemini-2.5-flash')).rejects.toThrow(
      "Provider 'google' circuit breaker is open",
    );
    // No semaphore slot should be consumed
    expect(router.getSemaphoreStats().get('google')!.active).toBe(0);
  });

  it('acquireSlot() returns release function', async () => {
    const router = new TransportRouter({
      nativeTransports: { anthropic: stubAnthropic },
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'subscription', concurrency: 24 } },
    });
    const { release } = await router.acquireSlot('anthropic/claude-opus-4-6');
    expect(router.getSemaphoreStats().get('anthropic')!.active).toBe(1);
    release();
    expect(router.getSemaphoreStats().get('anthropic')!.active).toBe(0);
  });

  it('release({ success: true }) records success on breaker', async () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { google: { mode: 'api', concurrency: 10 } },
    });
    // Record a failure first, then succeed
    const breaker = router.breakers.get('google')!;
    breaker.recordFailure();
    const { release } = await router.acquireSlot('google/gemini-2.5-flash');
    release({ success: true });
    // Breaker should be closed (success resets counter)
    expect(router.getBreakerState('google')).toBe('closed');
  });

  it('release({ success: false }) records failure on breaker', async () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { google: { mode: 'api', concurrency: 10 } },
    });
    // 2 prior failures + 1 from release = 3 = trip
    const breaker = router.breakers.get('google')!;
    breaker.recordFailure();
    breaker.recordFailure();
    const { release } = await router.acquireSlot('google/gemini-2.5-flash');
    release({ success: false });
    expect(router.getBreakerState('google')).toBe('open');
  });

  it('release() without args defaults to success', async () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'api', concurrency: 24 } },
    });
    const breaker = router.breakers.get('anthropic')!;
    breaker.recordFailure();
    const { release } = await router.acquireSlot('anthropic/claude-sonnet-4-6');
    release(); // no args = success
    expect(router.getBreakerState('anthropic')).toBe('closed');
  });

  it('release() is idempotent (double-release is safe)', async () => {
    const router = new TransportRouter({
      nativeTransports: {},
      vercelSdkTransport: stubVercel,
      providerModes: { anthropic: { mode: 'api', concurrency: 24 } },
    });
    const { release } = await router.acquireSlot('anthropic/claude-sonnet-4-6');
    release();
    release(); // should not throw or decrement below 0
    expect(router.getSemaphoreStats().get('anthropic')!.active).toBe(0);
  });
});
