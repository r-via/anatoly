// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { TransportRouter, extractProvider } from './index.js';

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
