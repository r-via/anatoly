// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

// ---------------------------------------------------------------------------
// Mock generateText + getVercelModel
// ---------------------------------------------------------------------------

const { mockGenerateText, mockGetVercelModel } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetVercelModel: vi.fn().mockReturnValue('mock-model-ref'),
}));

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('../transports/vercel-sdk-transport.js', () => ({
  getVercelModel: mockGetVercelModel,
}));

import { runVercelAgent, type VercelAgentParams } from './vercel-agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function makeParams(overrides: Partial<VercelAgentParams> = {}): VercelAgentParams {
  return {
    systemPrompt: 'You are an investigator.',
    userMessage: 'Investigate this code.',
    model: 'anthropic/claude-sonnet-4-6',
    projectRoot: '/tmp/test-project',
    config: makeConfig(),
    abortController: new AbortController(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runVercelAgent', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    mockGenerateText.mockReset();
    mockGetVercelModel.mockReset();
    mockGetVercelModel.mockReturnValue('mock-model-ref');
    mockGenerateText.mockResolvedValue({
      text: 'Investigation complete.',
      usage: { inputTokens: 500, outputTokens: 200 },
      steps: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('calls generateText with maxSteps defaulting to 20', async () => {
    await runVercelAgent(makeParams());

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxSteps: 20 }),
    );
  });

  it('uses custom maxSteps when provided', async () => {
    await runVercelAgent(makeParams({ maxSteps: 100 }));

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxSteps: 100 }),
    );
  });

  it('passes system prompt and user message', async () => {
    await runVercelAgent(makeParams({
      systemPrompt: 'Be thorough.',
      userMessage: 'Check file.ts',
    }));

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'Be thorough.',
        prompt: 'Check file.ts',
      }),
    );
  });

  it('includes bash tool in tools', async () => {
    await runVercelAgent(makeParams());

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.tools.bash).toBeDefined();
  });

  it('bash tool is read-only by default (allowWrite: false)', async () => {
    await runVercelAgent(makeParams());

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools.bash.description).toMatch(/read[- ]only/i);
  });

  it('bash tool is writable when allowWrite: true', async () => {
    await runVercelAgent(makeParams({ allowWrite: true }));

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools.bash.description).not.toMatch(/read[- ]only/i);
  });

  it('returns text, costUsd, and usage fields', async () => {
    const result = await runVercelAgent(makeParams());

    expect(result.text).toBe('Investigation complete.');
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(200);
    expect(typeof result.costUsd).toBe('number');
    expect(typeof result.durationMs).toBe('number');
  });

  it('calculates costUsd via the cost calculator', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Done',
      usage: { inputTokens: 1000, outputTokens: 500 },
      steps: [],
    });

    const result = await runVercelAgent(makeParams({ model: 'anthropic/claude-sonnet-4-6' }));

    // claude-sonnet-4-6: input $3.00/M, output $15.00/M
    // Cost = (1000 * 3.00 + 500 * 15.00) / 1_000_000 = 0.0105
    expect(result.costUsd).toBeCloseTo(0.0105, 4);
  });

  it('does NOT include search tool when allowSearch is false/omitted', async () => {
    await runVercelAgent(makeParams());

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools.web_search).toBeUndefined();
  });

  it('includes search tool when allowSearch is true and search provider configured', async () => {
    vi.stubEnv('EXA_API_KEY', 'test-exa-key');
    await runVercelAgent(makeParams({
      allowSearch: true,
      config: makeConfig({ search: { provider: 'exa' } }),
    }));

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools.web_search).toBeDefined();
  });

  it('omits search tool when allowSearch is true but no search provider configured', async () => {
    await runVercelAgent(makeParams({ allowSearch: true }));

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools.web_search).toBeUndefined();
  });

  it('propagates errors from generateText', async () => {
    mockGenerateText.mockRejectedValue(new Error('Model overloaded'));

    await expect(runVercelAgent(makeParams())).rejects.toThrow('Model overloaded');
  });

  it('resolves the model via getVercelModel', async () => {
    await runVercelAgent(makeParams({ model: 'google/gemini-2.5-pro' }));

    expect(mockGetVercelModel).toHaveBeenCalledWith(
      'google/gemini-2.5-pro',
      expect.anything(),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mock-model-ref' }),
    );
  });
});
