// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmRequest } from './index.js';

// ---------------------------------------------------------------------------
// Mock external Vercel AI SDK modules — use vi.hoisted() to avoid TDZ issues
// ---------------------------------------------------------------------------

const {
  mockGenerateText,
  mockAnthropicFactory,
  mockGoogleFactory,
  mockOpenaiFactory,
  mockCompatibleModelFn,
  mockCreateOpenAICompatible,
} = vi.hoisted(() => {
  const mockCompatibleModelFn = vi.fn().mockReturnValue('compatible-model-ref');
  return {
    mockGenerateText: vi.fn(),
    mockAnthropicFactory: vi.fn().mockReturnValue('anthropic-model-ref'),
    mockGoogleFactory: vi.fn().mockReturnValue('google-model-ref'),
    mockOpenaiFactory: vi.fn().mockReturnValue('openai-model-ref'),
    mockCompatibleModelFn,
    mockCreateOpenAICompatible: vi.fn().mockReturnValue(mockCompatibleModelFn),
  };
});

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: mockAnthropicFactory }));
vi.mock('@ai-sdk/google', () => ({ google: mockGoogleFactory }));
vi.mock('@ai-sdk/openai', () => ({ openai: mockOpenaiFactory }));
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: mockCreateOpenAICompatible }));

// Import after mocks
import { VercelSdkTransport, getVercelModel } from './vercel-sdk-transport.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function makeRequest(model: string): LlmRequest {
  return {
    systemPrompt: 'You are a helpful assistant.',
    userMessage: 'Hello',
    model,
    projectRoot: '/tmp/test',
    abortController: new AbortController(),
  };
}

// ---------------------------------------------------------------------------
// getVercelModel
// ---------------------------------------------------------------------------

describe('getVercelModel', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('GROQ_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('should return anthropic model for anthropic/ prefix', () => {
    const config = makeConfig();
    getVercelModel('anthropic/claude-sonnet-4-6', config);
    expect(mockAnthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('should return google model for google/ prefix', () => {
    const config = makeConfig({ providers: { google: { mode: 'api' } } });
    getVercelModel('google/gemini-2.5-flash', config);
    expect(mockGoogleFactory).toHaveBeenCalledWith('gemini-2.5-flash');
  });

  it('should return openai model for openai/ prefix', () => {
    const config = makeConfig({ providers: { openai: {} } });
    getVercelModel('openai/gpt-4o', config);
    expect(mockOpenaiFactory).toHaveBeenCalledWith('gpt-4o');
  });

  it('should return openai-compatible model for known compatible provider', () => {
    const config = makeConfig({ providers: { groq: {} } });
    getVercelModel('groq/llama-3-70b', config);
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'groq',
        baseURL: expect.stringContaining('groq.com'),
      }),
    );
    expect(mockCompatibleModelFn).toHaveBeenCalledWith('llama-3-70b');
  });

  it('should throw when API key is missing for non-ollama provider', () => {
    vi.unstubAllEnvs();
    const config = makeConfig({ providers: { groq: {} } });
    expect(() => getVercelModel('groq/llama-3-70b', config)).toThrow(
      /No API key for provider "groq".*GROQ_API_KEY/,
    );
  });

  it('should NOT throw when API key is missing for ollama', () => {
    vi.unstubAllEnvs();
    const config = makeConfig({ providers: { ollama: {} } });
    expect(() => getVercelModel('ollama/llama3', config)).not.toThrow();
  });

  it('should handle bare claude-* model names (inferred anthropic)', () => {
    const config = makeConfig();
    getVercelModel('claude-sonnet-4-6', config);
    expect(mockAnthropicFactory).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('should handle bare gemini-* model names (inferred google)', () => {
    const config = makeConfig({ providers: { google: { mode: 'api' } } });
    getVercelModel('gemini-2.5-flash', config);
    expect(mockGoogleFactory).toHaveBeenCalledWith('gemini-2.5-flash');
  });
});

// ---------------------------------------------------------------------------
// VercelSdkTransport
// ---------------------------------------------------------------------------

describe('VercelSdkTransport', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key');
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('should have provider = "vercel-sdk"', () => {
    const transport = new VercelSdkTransport(makeConfig());
    expect(transport.provider).toBe('vercel-sdk');
  });

  it('supports() should return true for any model', () => {
    const transport = new VercelSdkTransport(makeConfig());
    expect(transport.supports('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(transport.supports('google/gemini-2.5-flash')).toBe(true);
    expect(transport.supports('unknown/model')).toBe(true);
  });

  it('query() should call generateText and return LlmResponse', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Hello from AI',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    });

    const transport = new VercelSdkTransport(makeConfig());
    const response = await transport.query(makeRequest('anthropic/claude-sonnet-4-6'));

    expect(response.text).toBe('Hello from AI');
    expect(response.inputTokens).toBe(100);
    expect(response.outputTokens).toBe(50);
    expect(response.costUsd).toBeGreaterThan(0);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof response.transcript).toBe('string');
    expect(typeof response.sessionId).toBe('string');
  });

  it('query() should map usage fields correctly', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Response',
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        cachedInputTokens: 50,
      },
    });

    const transport = new VercelSdkTransport(makeConfig());
    const response = await transport.query(makeRequest('anthropic/claude-sonnet-4-6'));

    expect(response.inputTokens).toBe(200);
    expect(response.outputTokens).toBe(100);
    expect(response.cacheReadTokens).toBe(50);
  });

  it('query() should return costUsd: 0 for models not in pricing table', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Response',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // Use a known provider but an unpriced model
    const transport = new VercelSdkTransport(makeConfig({ providers: { openai: {} } }));
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const response = await transport.query(makeRequest('openai/o3-some-future-model'));

    expect(response.costUsd).toBe(0);
  });

  it('query() should pass system prompt and user message to generateText', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'OK',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const transport = new VercelSdkTransport(makeConfig());
    await transport.query({
      ...makeRequest('anthropic/claude-sonnet-4-6'),
      systemPrompt: 'Be concise.',
      userMessage: 'What is 2+2?',
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'Be concise.',
        prompt: 'What is 2+2?',
      }),
    );
  });

  it('query() should propagate errors from generateText', async () => {
    mockGenerateText.mockRejectedValue(new Error('Rate limited'));

    const transport = new VercelSdkTransport(makeConfig());
    await expect(transport.query(makeRequest('anthropic/claude-sonnet-4-6'))).rejects.toThrow('Rate limited');
  });
});
