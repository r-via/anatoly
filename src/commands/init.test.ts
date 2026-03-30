// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateProviderMode,
  detectApiKey,
  buildInitConfig,
  type WizardSelections,
} from './init.js';

// ---------------------------------------------------------------------------
// validateProviderMode
// ---------------------------------------------------------------------------

describe('validateProviderMode', () => {
  it('allows subscription mode for anthropic', () => {
    expect(validateProviderMode('anthropic', 'subscription')).toBeNull();
  });

  it('allows subscription mode for google', () => {
    expect(validateProviderMode('google', 'subscription')).toBeNull();
  });

  it('rejects subscription mode for other providers', () => {
    expect(validateProviderMode('groq', 'subscription')).toMatch(
      /subscription mode only available/i,
    );
  });

  it('allows api mode for any provider', () => {
    expect(validateProviderMode('groq', 'api')).toBeNull();
    expect(validateProviderMode('anthropic', 'api')).toBeNull();
    expect(validateProviderMode('custom-provider', 'api')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectApiKey
// ---------------------------------------------------------------------------

describe('detectApiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('detects ANTHROPIC_API_KEY for anthropic', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(detectApiKey('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('detects GOOGLE_GENERATIVE_AI_API_KEY for google', () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key');
    expect(detectApiKey('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('returns null when env var is missing', () => {
    delete process.env.GROQ_API_KEY;
    expect(detectApiKey('groq')).toBeNull();
  });

  it('derives env var name for unknown providers', () => {
    vi.stubEnv('MY_PROVIDER_API_KEY', 'secret');
    expect(detectApiKey('my-provider')).toBe('MY_PROVIDER_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// buildInitConfig
// ---------------------------------------------------------------------------

describe('buildInitConfig', () => {
  it('generates valid v2 config with prefixed model names', () => {
    const selections: WizardSelections = {
      providers: new Map([
        ['anthropic', { mode: 'subscription' }],
        ['google', { mode: 'api' }],
      ]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'google/gemini-2.5-flash-lite',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    };

    const config = buildInitConfig(selections);

    expect(config.providers.anthropic).toEqual({ mode: 'subscription' });
    expect(config.providers.google).toEqual({ mode: 'api' });
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.fast).toBe('google/gemini-2.5-flash-lite');
    expect(config.models.deliberation).toBe('anthropic/claude-opus-4-6');
  });

  it('includes code_summary when provided', () => {
    const selections: WizardSelections = {
      providers: new Map([['anthropic', { mode: 'subscription' }]]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        code_summary: 'anthropic/claude-haiku-4-5-20251001',
      },
    };

    const config = buildInitConfig(selections);
    expect(config.models.code_summary).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('includes split modes when present', () => {
    const selections: WizardSelections = {
      providers: new Map([
        ['anthropic', { mode: 'subscription', single_turn: 'subscription', agents: 'api' }],
      ]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    };

    const config = buildInitConfig(selections);
    expect(config.providers.anthropic).toEqual({
      mode: 'subscription',
      single_turn: 'subscription',
      agents: 'api',
    });
  });
});
