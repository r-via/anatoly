// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import type { LlmTransport, LlmRequest, LlmResponse } from './index.js';
import { TransportRouter } from './index.js';

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
    expect(transport.supports('gemini-3-flash-preview')).toBe(false);
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

describe('TransportRouter', () => {
  it('resolve() returns first matching transport', () => {
    const anthropic = createStubTransport('anthropic', (m) => !m.startsWith('gemini-'));
    const gemini = createStubTransport('gemini', (m) => m.startsWith('gemini-'));
    const router = new TransportRouter([anthropic, gemini]);

    expect(router.resolve('claude-sonnet-4-20250514')).toBe(anthropic);
    expect(router.resolve('gemini-3-flash-preview')).toBe(gemini);
  });

  it('resolve() returns first match when multiple transports support the model', () => {
    const primary = createStubTransport('primary', () => true);
    const fallback = createStubTransport('fallback', () => true);
    const router = new TransportRouter([primary, fallback]);

    expect(router.resolve('any-model')).toBe(primary);
  });

  it('resolve() throws when no transport matches', () => {
    const anthropic = createStubTransport('anthropic', (m) => m.startsWith('claude-'));
    const router = new TransportRouter([anthropic]);

    expect(() => router.resolve('gemini-3-flash-preview')).toThrow(
      /no transport supports model.*gemini-3-flash-preview/i,
    );
  });

  it('resolve() throws with empty transport list', () => {
    const router = new TransportRouter([]);

    expect(() => router.resolve('claude-sonnet-4-20250514')).toThrow(
      /no transport supports model/i,
    );
  });

  it('works with a single transport', () => {
    const transport = createStubTransport('anthropic', () => true);
    const router = new TransportRouter([transport]);

    expect(router.resolve('any-model')).toBe(transport);
  });
});
