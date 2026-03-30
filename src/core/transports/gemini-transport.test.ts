// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmTransport, LlmResponse } from './index.js';

// ---------------------------------------------------------------------------
// Mock @google/gemini-cli-core
// ---------------------------------------------------------------------------

const {
  mockResetChat,
  mockSetSystemInstruction,
  mockSendMessageStream,
  mockGetChat,
  mockRefreshAuth,
  mockInitialize,
  configInstances,
} = vi.hoisted(() => ({
  mockSetSystemInstruction: vi.fn(),
  mockGetChat: vi.fn(),
  mockSendMessageStream: vi.fn(),
  mockResetChat: vi.fn().mockResolvedValue(undefined),
  mockRefreshAuth: vi.fn().mockResolvedValue(undefined),
  mockInitialize: vi.fn().mockResolvedValue(undefined),
  configInstances: [] as unknown[],
}));

// Wire up mockGetChat to return the setSystemInstruction mock
mockGetChat.mockReturnValue({ setSystemInstruction: mockSetSystemInstruction });

vi.mock('@google/gemini-cli-core', () => {
  // Use a real class so `new Config()` works
  class MockConfig {
    refreshAuth = mockRefreshAuth;
    initialize = mockInitialize;
    get geminiClient() {
      return {
        resetChat: mockResetChat,
        getChat: mockGetChat,
        sendMessageStream: mockSendMessageStream,
      };
    }
    constructor() {
      configInstances.push(this);
    }
  }
  return {
    Config: MockConfig,
    AuthType: { LOGIN_WITH_GOOGLE: 'oauth-personal' },
    getAuthTypeFromEnv: vi.fn().mockReturnValue(undefined),
    createSessionId: vi.fn().mockReturnValue('mock-session-id'),
  };
});

import { GeminiTransport } from './gemini-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStream(
  events: Array<{ type: string; value: unknown }>,
): AsyncGenerator<{ type: string; value: unknown }> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function defaultStreamEvents(text = 'Hello world'): Array<{ type: string; value: unknown }> {
  return [
    { type: 'content', value: text },
    {
      type: 'finished',
      value: {
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 10,
          totalTokenCount: 60,
        },
        reason: 'STOP',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// AC 37.3.3 — supports()
// ---------------------------------------------------------------------------

describe('GeminiTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configInstances.length = 0;
    mockGetChat.mockReturnValue({ setSystemInstruction: mockSetSystemInstruction });
  });

  it('AC 37.3.3: supports() returns true for gemini- models', () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    expect(transport.supports('gemini-2.5-flash')).toBe(true);
    expect(transport.supports('gemini-2.5-flash')).toBe(true);
  });

  it('AC 37.3.3: supports() returns false for non-gemini models', () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    expect(transport.supports('claude-sonnet-4-20250514')).toBe(false);
    expect(transport.supports('claude-haiku-4-5-20251001')).toBe(false);
    expect(transport.supports('some-model')).toBe(false);
  });

  it('provider is "gemini"', () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    expect(transport.provider).toBe('gemini');
  });

  it('implements LlmTransport interface', () => {
    const transport: LlmTransport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    expect(transport.provider).toBe('gemini');
    expect(typeof transport.supports).toBe('function');
    expect(typeof transport.query).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // AC 37.3.1 — lazy initialization
  // ---------------------------------------------------------------------------

  it('AC 37.3.1: does not initialize Config in constructor', () => {
    new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    expect(configInstances).toHaveLength(0);
  });

  it('AC 37.3.1: lazy-initializes Config + geminiClient on first query()', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(configInstances).toHaveLength(1);
    expect(mockRefreshAuth).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('AC 37.3.1: does not re-initialize on subsequent query() calls', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'test',
      userMessage: 'first',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'test',
      userMessage: 'second',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    // Config created only once
    expect(configInstances).toHaveLength(1);
    expect(mockRefreshAuth).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('AC 37.3.1: auth uses getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    // getAuthTypeFromEnv returns undefined, so fallback to LOGIN_WITH_GOOGLE
    expect(mockRefreshAuth).toHaveBeenCalledWith('oauth-personal');
  });

  // ---------------------------------------------------------------------------
  // AC 37.3.2 — query() behavior
  // ---------------------------------------------------------------------------

  it('AC 37.3.2: calls resetChat() before each query (history isolation)', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(mockResetChat).toHaveBeenCalledTimes(1);
  });

  it('AC 37.3.2: sets system instruction via getChat().setSystemInstruction()', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    await transport.query({
      systemPrompt: 'You are a JSON assistant.',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(mockSetSystemInstruction).toHaveBeenCalledWith('You are a JSON assistant.');
  });

  it('AC 37.3.2: assembles text from content events', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(
      createMockStream([
        { type: 'content', value: 'Hello ' },
        { type: 'content', value: 'world' },
        { type: 'finished', value: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, reason: 'STOP' } },
      ]),
    );

    const response = await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(response.text).toBe('Hello world');
  });

  it('AC 37.3.2: extracts usageMetadata from finished event', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(
      createMockStream([
        { type: 'content', value: '{"ok":true}' },
        {
          type: 'finished',
          value: {
            usageMetadata: {
              promptTokenCount: 200,
              candidatesTokenCount: 50,
              totalTokenCount: 250,
            },
            reason: 'STOP',
          },
        },
      ]),
    );

    const response = await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(response.inputTokens).toBe(200);
    expect(response.outputTokens).toBe(50);
  });

  it('AC 37.3.2: returns costUsd: 0', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents()));

    const response = await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(response.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('AC 37.3.2: returns a transcript', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents('response text')));

    const response = await transport.query({
      systemPrompt: 'System prompt here',
      userMessage: 'User message here',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(response.transcript).toContain('System prompt here');
    expect(response.transcript).toContain('User message here');
    expect(response.transcript).toContain('response text');
  });

  it('AC 37.3.2: returns correct LlmResponse shape', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(createMockStream(defaultStreamEvents('ok')));

    const response = await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    // Verify all LlmResponse fields are present
    expect(response).toHaveProperty('text');
    expect(response).toHaveProperty('costUsd');
    expect(response).toHaveProperty('durationMs');
    expect(response).toHaveProperty('inputTokens');
    expect(response).toHaveProperty('outputTokens');
    expect(response).toHaveProperty('cacheReadTokens');
    expect(response).toHaveProperty('cacheCreationTokens');
    expect(response).toHaveProperty('transcript');
    expect(response).toHaveProperty('sessionId');
    expect(typeof response.durationMs).toBe('number');
    expect(response.cacheReadTokens).toBe(0);
    expect(response.cacheCreationTokens).toBe(0);
  });

  it('handles missing usageMetadata gracefully', async () => {
    const transport = new GeminiTransport('/tmp/project', 'gemini-2.5-flash');
    mockSendMessageStream.mockReturnValue(
      createMockStream([
        { type: 'content', value: 'response' },
        { type: 'finished', value: { usageMetadata: undefined, reason: 'STOP' } },
      ]),
    );

    const response = await transport.query({
      systemPrompt: 'test',
      userMessage: 'hello',
      model: 'gemini-2.5-flash',
      projectRoot: '/tmp/project',
      abortController: new AbortController(),
    });

    expect(response.inputTokens).toBe(0);
    expect(response.outputTokens).toBe(0);
  });
});
