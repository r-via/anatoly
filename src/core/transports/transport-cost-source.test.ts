// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLlmCallSink, type LlmCallEvent } from '../../utils/llm-calls-sink.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Anthropic Claude Code SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Gemini CLI Core
vi.mock('@google/gemini-cli-core', () => {
  class MockConfig {
    geminiClient;
    constructor() {
      this.geminiClient = {
        resetChat: vi.fn(),
        getChat: vi.fn(() => ({ setSystemInstruction: vi.fn() })),
        sendMessageStream: vi.fn(() =>
          (async function* () {
            yield { type: 'content', value: 'test response' };
            yield {
              type: 'finished',
              value: {
                usageMetadata: {
                  promptTokenCount: 200,
                  candidatesTokenCount: 75,
                  cachedContentTokenCount: 50,
                },
              },
            };
          })(),
        ),
      };
    }
    async refreshAuth() { /* mock */ }
    async initialize() { /* mock */ }
  }

  return {
    Config: MockConfig,
    AuthType: { LOGIN_WITH_GOOGLE: 'LOGIN_WITH_GOOGLE' },
    getAuthTypeFromEnv: vi.fn(() => 'LOGIN_WITH_GOOGLE'),
    createSessionId: vi.fn(() => 'mock-session-id'),
  };
});

// Vercel AI SDK + provider factories
vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn(() => 'mock-model') }));
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mock-model') }));
vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn(() => 'mock-model') }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => () => 'mock-model'),
}));
vi.mock('../providers/known-providers.js', () => ({
  resolveProvider: vi.fn(() => ({ type: 'native', env_key: 'ANTHROPIC_API_KEY' })),
}));
vi.mock('../providers/attribution.js', () => ({
  getProviderHeaders: vi.fn(() => ({})),
}));

// Shared helpers
vi.mock('../../utils/cost-calculator.js', () => ({
  calculateCost: vi.fn(() => 0.01),
}));
vi.mock('./conversation-dump.js', () => ({
  initConvDump: vi.fn(),
  appendAssistant: vi.fn(),
  appendResult: vi.fn(),
  appendError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AnthropicTransport } from './anthropic-transport.js';
import { GeminiTransport } from './gemini-transport.js';
import { VercelSdkTransport } from './vercel-sdk-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anatoly-cost-source-'));
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
});

function readEvents(sinkPath: string): LlmCallEvent[] {
  return readFileSync(sinkPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LlmCallEvent);
}

function anthropicMessageStream(overrides?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
}) {
  return async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: 'test response',
      session_id: 'sess-test',
      total_cost_usd: overrides?.costUsd ?? 0.01,
      duration_ms: 100,
      usage: {
        inputTokens: overrides?.inputTokens ?? 100,
        outputTokens: overrides?.outputTokens ?? 50,
        cacheReadInputTokens: overrides?.cacheRead ?? 0,
        cacheCreationInputTokens: overrides?.cacheCreation ?? 0,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Anthropic transport (subscription mode)
// ---------------------------------------------------------------------------

describe('anthropic transport (subscription mode)', () => {
  it('emits costUsd: null + costSource: unknown + pricingModel: subscription-claude-code-sdk', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    (sdk.query as unknown as Mock).mockReturnValueOnce(anthropicMessageStream()());

    const sinkPath = join(dir, 'ledger.ndjson');
    await withLlmCallSink(sinkPath, async () => {
      await new AnthropicTransport().query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'anthropic/claude-sonnet-4-6',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events).toHaveLength(1);
    expect(events[0].costUsd).toBeNull();
    expect(events[0].costSource).toBe('unknown');
    expect(events[0].pricingModel).toBe('subscription-claude-code-sdk');
    expect(events[0].provider).toBe('anthropic');
  });

  it('captures tokens even when costUsd is null', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    (sdk.query as unknown as Mock).mockReturnValueOnce(
      anthropicMessageStream({ inputTokens: 500, outputTokens: 250, cacheRead: 100, cacheCreation: 10 })(),
    );

    const sinkPath = join(dir, 'ledger.ndjson');
    await withLlmCallSink(sinkPath, async () => {
      await new AnthropicTransport().query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'anthropic/claude-sonnet-4-6',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events).toHaveLength(1);
    expect(events[0].costUsd).toBeNull();
    expect(events[0].inputTokens).toBe(500);
    expect(events[0].outputTokens).toBe(250);
    expect(events[0].cacheReadTokens).toBe(100);
    expect(events[0].cacheCreationTokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Gemini transport (subscription mode)
// ---------------------------------------------------------------------------

describe('gemini transport (subscription mode)', () => {
  it('emits costUsd: null + costSource: unknown + pricingModel: subscription-gemini-cli-core', async () => {
    const sinkPath = join(dir, 'ledger.ndjson');
    await withLlmCallSink(sinkPath, async () => {
      await new GeminiTransport(dir, 'gemini-2.5-flash').query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'gemini-2.5-flash',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events).toHaveLength(1);
    expect(events[0].costUsd).toBeNull();
    expect(events[0].costSource).toBe('unknown');
    expect(events[0].pricingModel).toBe('subscription-gemini-cli-core');
    expect(events[0].provider).toBe('gemini');
  });

  it('captures tokens from subscription-mode call', async () => {
    const sinkPath = join(dir, 'ledger.ndjson');
    await withLlmCallSink(sinkPath, async () => {
      await new GeminiTransport(dir, 'gemini-2.5-flash').query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'gemini-2.5-flash',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events[0].costUsd).toBeNull();
    expect(events[0].inputTokens).toBe(200);
    expect(events[0].outputTokens).toBe(75);
    expect(events[0].cacheReadTokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Vercel SDK transport (API mode)
// ---------------------------------------------------------------------------

describe('vercel-sdk transport (API mode)', () => {
  it('emits costSource: actual + pricingModel: vercel-sdk-{provider}-2025-05', async () => {
    const ai = await import('ai');
    (ai.generateText as unknown as Mock).mockResolvedValueOnce({
      text: 'test response',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });

    const sinkPath = join(dir, 'ledger.ndjson');
    const transport = new VercelSdkTransport({ providers: { anthropic: {} } } as never);
    await withLlmCallSink(sinkPath, async () => {
      await transport.query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'anthropic/claude-sonnet-4-6',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events).toHaveLength(1);
    expect(events[0].costSource).toBe('actual');
    expect(events[0].pricingModel).toBe('vercel-sdk-anthropic-2025-05');
    expect(events[0].costUsd).toBeTypeOf('number');
    expect(events[0].costUsd).not.toBeNull();
    expect(events[0].provider).toBe('anthropic');
  });

  it('never emits costSource: unknown', async () => {
    const ai = await import('ai');
    (ai.generateText as unknown as Mock).mockResolvedValueOnce({
      text: 'response',
      usage: {
        inputTokens: 50,
        outputTokens: 25,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });

    const sinkPath = join(dir, 'ledger.ndjson');
    const transport = new VercelSdkTransport({ providers: { anthropic: {} } } as never);
    await withLlmCallSink(sinkPath, async () => {
      await transport.query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'anthropic/claude-sonnet-4-6',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events[0].costSource).not.toBe('unknown');
  });

  it('cache hit: costUsd 0 + costSource actual (distinct from subscription null/unknown)', async () => {
    const ai = await import('ai');
    (ai.generateText as unknown as Mock).mockResolvedValueOnce({
      text: 'cached',
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 100, cacheWriteTokens: 0 },
      },
    });

    const costCalc = await import('../../utils/cost-calculator.js');
    (costCalc.calculateCost as unknown as Mock).mockReturnValueOnce(0);

    const sinkPath = join(dir, 'ledger.ndjson');
    const transport = new VercelSdkTransport({ providers: { anthropic: {} } } as never);
    await withLlmCallSink(sinkPath, async () => {
      await transport.query({
        systemPrompt: 'sys',
        userMessage: 'msg',
        model: 'anthropic/claude-sonnet-4-6',
        projectRoot: dir,
        abortController: new AbortController(),
      });
    });

    const events = readEvents(sinkPath);
    expect(events).toHaveLength(1);
    // API mode cache hit: costUsd is 0 (number), NOT null
    expect(events[0].costUsd).toBe(0);
    expect(events[0].costSource).toBe('actual');
    // Distinct from subscription mode
    expect(events[0].costUsd).not.toBeNull();
  });
});
