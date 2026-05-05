// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, it, expect, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmTransport, LlmResponse } from './index.js';
import { TransportRouter } from './index.js';
import { AnthropicTransport } from './anthropic-transport.js';
import { withLlmCallSink } from '../../utils/llm-calls-sink.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

/** Build a minimal mock router that returns the given transport from acquire(). */
function mockRouter(transport: LlmTransport): TransportRouter {
  return { acquire: async () => ({ transport, release: () => {} }) } as unknown as TransportRouter;
}

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
        router: mockRouter(mockTransport),
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
        router: mockRouter(mockTransport),
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
        router: mockRouter(mockTransport),
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
          router: mockRouter(mockTransport),
        },
        schema,
      ),
    ).rejects.toThrow(/validation failed after 2 attempts/i);

    expect(mockTransport.query).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Regression: SDK→LlmResponse token extraction
//
// The Claude Agent SDK exposes usage fields in camelCase (inputTokens,
// outputTokens, cacheReadInputTokens, cacheCreationInputTokens). An earlier
// version of the transport read snake_case keys, silently zeroing every
// token count on every Anthropic call. This test guards against any future
// rename or accidental cast that would re-introduce the same silent miss.
// ---------------------------------------------------------------------------

describe('AnthropicTransport — SDK usage extraction', () => {
  it('extracts camelCase token fields from SDKResultSuccess.usage into LlmResponse', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const mockedQuery = sdk.query as unknown as Mock;

    async function* messageStream() {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'response text',
        session_id: 'session-test',
        total_cost_usd: 0.0123,
        duration_ms: 1500,
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 1500,
          cacheCreationInputTokens: 50,
        },
      };
    }
    mockedQuery.mockReturnValueOnce(messageStream());

    const transport = new AnthropicTransport();
    const response = await transport.query({
      systemPrompt: 'sys',
      userMessage: 'msg',
      model: 'anthropic/claude-sonnet-4-6',
      projectRoot: '/tmp',
      abortController: new AbortController(),
    });

    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(200);
    expect(response.cacheReadTokens).toBe(1500);
    expect(response.cacheCreationTokens).toBe(50);
    expect(response.costUsd).toBe(0.0123);
    expect(response.sessionId).toBe('session-test');
  });

  describe('end-to-end: per-call sink', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anatoly-sink-itest-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('writes one llm_call record per query when run inside withLlmCallSink', async () => {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const mockedQuery = sdk.query as unknown as Mock;

      async function* messageStream() {
        yield {
          type: 'result', subtype: 'success', result: 'ok',
          session_id: 'sess', total_cost_usd: 0.01, duration_ms: 100,
          usage: {
            inputTokens: 50, outputTokens: 25,
            cacheReadInputTokens: 1000, cacheCreationInputTokens: 10,
          },
        };
      }
      mockedQuery.mockReturnValueOnce(messageStream());

      const sinkPath = join(dir, 'llm-calls.ndjson');
      const transport = new AnthropicTransport();
      await withLlmCallSink(sinkPath, async () => {
        await transport.query({
          systemPrompt: 'sys',
          userMessage: 'msg',
          model: 'anthropic/claude-sonnet-4-6',
          projectRoot: dir,
          abortController: new AbortController(),
        });
      });

      const lines = readFileSync(sinkPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.provider).toBe('anthropic');
      // model on the record is the stripped form passed to the SDK
      expect(event.model).toBe('claude-sonnet-4-6');
      expect(event.inputTokens).toBe(50);
      expect(event.outputTokens).toBe(25);
      expect(event.cacheReadTokens).toBe(1000);
      expect(event.cacheCreationTokens).toBe(10);
      expect(event.success).toBe(true);
      expect(event.schemaVersion).toBe(1);
    });
  });

  it('returns 0 tokens when SDK returns snake_case keys (defensive — proves the previous bug shape)', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const mockedQuery = sdk.query as unknown as Mock;

    async function* messageStream() {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'response text',
        session_id: 'session-legacy',
        total_cost_usd: 0.005,
        duration_ms: 1000,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 50,
        },
      };
    }
    mockedQuery.mockReturnValueOnce(messageStream());

    const transport = new AnthropicTransport();
    const response = await transport.query({
      systemPrompt: 'sys',
      userMessage: 'msg',
      model: 'anthropic/claude-sonnet-4-6',
      projectRoot: '/tmp',
      abortController: new AbortController(),
    });

    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(200);
    expect(response.cacheReadTokens).toBe(1500);
    expect(response.cacheCreationTokens).toBe(50);
    expect(response.costUsd).toBe(0.005);
  });
});
