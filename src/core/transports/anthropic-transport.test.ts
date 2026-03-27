// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { LlmTransport, LlmResponse } from './index.js';
import { AnthropicTransport } from './anthropic-transport.js';

// ---------------------------------------------------------------------------
// AC 37.2.1 — AnthropicTransport shape and contract
// ---------------------------------------------------------------------------

describe('AnthropicTransport', () => {
  it('AC 37.2.1: provider is "anthropic"', () => {
    const transport = new AnthropicTransport();
    expect(transport.provider).toBe('anthropic');
  });

  it('AC 37.2.1: supports() returns true for any model NOT starting with gemini-', () => {
    const transport = new AnthropicTransport();
    expect(transport.supports('claude-sonnet-4-20250514')).toBe(true);
    expect(transport.supports('claude-haiku-4-5-20251001')).toBe(true);
    expect(transport.supports('some-other-model')).toBe(true);
  });

  it('AC 37.2.1: supports() returns false for gemini models', () => {
    const transport = new AnthropicTransport();
    expect(transport.supports('gemini-2.5-flash')).toBe(false);
    expect(transport.supports('gemini-2.5-flash')).toBe(false);
  });

  it('AC 37.2.1: implements LlmTransport interface', () => {
    const transport: LlmTransport = new AnthropicTransport();
    expect(transport.provider).toBe('anthropic');
    expect(typeof transport.supports).toBe('function');
    expect(typeof transport.query).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC 37.2.2 — runSingleTurnQuery transport integration
// ---------------------------------------------------------------------------

describe('runSingleTurnQuery transport integration', () => {
  it('AC 37.2.2: uses provided transport for I/O', async () => {
    const { runSingleTurnQuery } = await import('../axis-evaluator.js');

    const mockTransport: LlmTransport = {
      provider: 'mock',
      supports: () => true,
      query: vi.fn().mockResolvedValue({
        text: '{"value": 42}',
        costUsd: 0.001,
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '## mock transcript',
        sessionId: 'mock-session',
      } satisfies LlmResponse),
    };

    const schema = z.object({ value: z.number() });
    const result = await runSingleTurnQuery(
      {
        systemPrompt: 'You are a test assistant.',
        userMessage: 'Return {"value": 42}',
        model: 'test-model',
        projectRoot: '/tmp/test',
        abortController: new AbortController(),
        transport: mockTransport,
      },
      schema,
    );

    expect(mockTransport.query).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ value: 42 });
    expect(result.costUsd).toBe(0.001);
    expect(result.durationMs).toBe(100);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('AC 37.2.2: keeps Zod validation + retry logic when using transport', async () => {
    const { runSingleTurnQuery } = await import('../axis-evaluator.js');

    const mockTransport: LlmTransport = {
      provider: 'mock',
      supports: () => true,
      query: vi
        .fn()
        .mockResolvedValueOnce({
          text: '{"wrong": "format"}',
          costUsd: 0.001,
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          transcript: '## attempt 1',
          sessionId: 'sess-1',
        } satisfies LlmResponse)
        .mockResolvedValueOnce({
          text: '{"value": 99}',
          costUsd: 0.002,
          durationMs: 200,
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          transcript: '## attempt 2',
          sessionId: 'sess-1',
        } satisfies LlmResponse),
    };

    const schema = z.object({ value: z.number() });
    const result = await runSingleTurnQuery(
      {
        systemPrompt: 'You are a test assistant.',
        userMessage: 'test',
        model: 'test-model',
        projectRoot: '/tmp/test',
        abortController: new AbortController(),
        transport: mockTransport,
      },
      schema,
    );

    // Should retry once (2 total calls)
    expect(mockTransport.query).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ value: 99 });
    // Cost accumulated from both attempts
    expect(result.costUsd).toBeCloseTo(0.003);
    expect(result.durationMs).toBe(300);
  });

  it('AC 37.2.2: passes resumeSessionId on retry', async () => {
    const { runSingleTurnQuery } = await import('../axis-evaluator.js');

    const mockTransport: LlmTransport = {
      provider: 'mock',
      supports: () => true,
      query: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'not json',
          costUsd: 0,
          durationMs: 50,
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          transcript: '',
          sessionId: 'sess-abc',
        } satisfies LlmResponse)
        .mockResolvedValueOnce({
          text: '{"ok": true}',
          costUsd: 0,
          durationMs: 50,
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          transcript: '',
          sessionId: 'sess-abc',
        } satisfies LlmResponse),
    };

    const schema = z.object({ ok: z.boolean() });
    await runSingleTurnQuery(
      {
        systemPrompt: 'test',
        userMessage: 'test',
        model: 'test-model',
        projectRoot: '/tmp',
        abortController: new AbortController(),
        transport: mockTransport,
      },
      schema,
    );

    // Second call should include resumeSessionId from first call's response
    const secondCallArgs = (mockTransport.query as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCallArgs.resumeSessionId).toBe('sess-abc');
    expect(secondCallArgs.attempt).toBe(2);
    expect(secondCallArgs.retryReason).toBe('zod_validation_failed');
  });

  it('AC 37.2.2: throws after 2 failed validation attempts', async () => {
    const { runSingleTurnQuery } = await import('../axis-evaluator.js');

    const mockTransport: LlmTransport = {
      provider: 'mock',
      supports: () => true,
      query: vi.fn().mockResolvedValue({
        text: '{"wrong": "always"}',
        costUsd: 0,
        durationMs: 50,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '',
        sessionId: 'sess-fail',
      } satisfies LlmResponse),
    };

    const schema = z.object({ value: z.number() });
    await expect(
      runSingleTurnQuery(
        {
          systemPrompt: 'test',
          userMessage: 'test',
          model: 'test-model',
          projectRoot: '/tmp',
          abortController: new AbortController(),
          transport: mockTransport,
        },
        schema,
      ),
    ).rejects.toThrow(/validation failed after 2 attempts/i);

    expect(mockTransport.query).toHaveBeenCalledTimes(2);
  });
});
