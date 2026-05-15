// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { wizardProvidersToV3 } from './wizard-v3-mapping.js';
import type { ProviderSelection } from '../commands/init.js';

function sel(s: ProviderSelection): ProviderSelection {
  return s;
}

const MODELS = {
  quality: 'anthropic/claude-sonnet-4-6',
  fast: 'anthropic/claude-haiku-4-5',
  deliberation: 'anthropic/claude-opus-4-7',
};

describe('wizardProvidersToV3', () => {
  it('1. anthropic subscription only → claude_agent_sdk + oauth, no env_key', () => {
    const r = wizardProvidersToV3(new Map([['anthropic', sel({ mode: 'subscription' })]]), MODELS);
    expect(r.providers.anthropic).toMatchObject({ transport: 'claude_agent_sdk', auth: 'oauth' });
    expect(r.providers.anthropic.env_key).toBeUndefined();
    expect(r.providers.anthropic.base_url).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('2. anthropic api → claude_agent_sdk + api_key + ANTHROPIC_API_KEY', () => {
    const r = wizardProvidersToV3(new Map([['anthropic', sel({ mode: 'api' })]]), MODELS);
    expect(r.providers.anthropic).toMatchObject({
      transport: 'claude_agent_sdk',
      auth: 'api_key',
      env_key: 'ANTHROPIC_API_KEY',
    });
  });

  it('3. google subscription → google_genai + oauth', () => {
    const r = wizardProvidersToV3(new Map([['google', sel({ mode: 'subscription' })]]), {
      ...MODELS,
      quality: 'google/gemini-2.5-pro',
    });
    expect(r.providers.google).toMatchObject({ transport: 'google_genai', auth: 'oauth' });
  });

  it('4. openai-compatible (groq) api → openai_compatible + api_key + GROQ_API_KEY + base_url', () => {
    const r = wizardProvidersToV3(new Map([['groq', sel({ mode: 'api' })]]), {
      ...MODELS,
      quality: 'groq/llama-3.3-70b',
    });
    expect(r.providers.groq).toMatchObject({
      transport: 'openai_compatible',
      auth: 'api_key',
      env_key: 'GROQ_API_KEY',
      base_url: 'https://api.groq.com/openai/v1',
    });
  });

  it('5. custom provider api → openai_compatible + CUSTOM_API_KEY fallback', () => {
    const r = wizardProvidersToV3(new Map([['my-llm', sel({ mode: 'api' })]]), {
      ...MODELS,
      quality: 'my-llm/x',
    });
    expect(r.providers['my-llm']).toMatchObject({
      transport: 'openai_compatible',
      auth: 'api_key',
      env_key: 'MY_LLM_API_KEY',
    });
  });

  it('6. subscription on openai_compatible → downgraded to api_key + warning', () => {
    const r = wizardProvidersToV3(new Map([['mistral', sel({ mode: 'subscription' })]]), {
      ...MODELS,
      quality: 'mistral/mistral-large',
    });
    expect(r.providers.mistral.auth).toBe('api_key');
    expect(r.providers.mistral.env_key).toBe('MISTRAL_API_KEY');
    expect(r.warnings.some((w) => w.includes('mistral') && w.includes('api_key'))).toBe(true);
  });

  it('7. summarization defaults to fast when code_summary absent', () => {
    const r = wizardProvidersToV3(new Map([['anthropic', sel({ mode: 'api' })]]), MODELS);
    expect(r.routingGeneration.summarization).toBe(r.routingGeneration.fast);
    expect(r.routingGeneration).toMatchObject({
      quality: 'anthropic/claude-sonnet-4-6',
      fast: 'anthropic/claude-haiku-4-5',
      deliberation: 'anthropic/claude-opus-4-7',
      summarization: 'anthropic/claude-haiku-4-5',
    });
  });

  it('7b. summarization uses code_summary when present', () => {
    const r = wizardProvidersToV3(new Map([['anthropic', sel({ mode: 'api' })]]), {
      ...MODELS,
      code_summary: 'anthropic/claude-haiku-4-5',
    });
    expect(r.routingGeneration.summarization).toBe('anthropic/claude-haiku-4-5');
  });

  it('8. provider models[] collects the referenced model ids', () => {
    const r = wizardProvidersToV3(new Map([['anthropic', sel({ mode: 'api' })]]), MODELS);
    expect(r.providers.anthropic.models.sort()).toEqual(
      ['claude-haiku-4-5', 'claude-opus-4-7', 'claude-sonnet-4-6'].sort(),
    );
  });

  // --- Split modes: two provider entries ---

  it('split: subscription agents + api single_turn → P (api_key) + P-agentic (oauth)', () => {
    const r = wizardProvidersToV3(
      new Map([['anthropic', sel({ mode: 'subscription', single_turn: 'api', agents: 'subscription' })]]),
      MODELS,
    );
    // single_turn entry keeps the bare name, api auth
    expect(r.providers.anthropic).toMatchObject({ auth: 'api_key', env_key: 'ANTHROPIC_API_KEY' });
    // agentic entry split out, oauth
    expect(r.providers['anthropic-agentic']).toMatchObject({ auth: 'oauth' });
    expect(r.providers['anthropic-agentic'].env_key).toBeUndefined();
    // deliberation (agentic) routed to the -agentic entry; others to bare name
    expect(r.routingGeneration.deliberation).toBe('anthropic-agentic/claude-opus-4-7');
    expect(r.routingGeneration.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(r.routingGeneration.fast).toBe('anthropic/claude-haiku-4-5');
    // models[] partitioned across the two entries
    expect(r.providers.anthropic.models.sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    expect(r.providers['anthropic-agentic'].models).toEqual(['claude-opus-4-7']);
  });

  it('split collapses to one entry when single_turn and agents resolve to the same auth', () => {
    const r = wizardProvidersToV3(
      new Map([['anthropic', sel({ mode: 'api', single_turn: 'api', agents: 'api' })]]),
      MODELS,
    );
    expect(r.providers['anthropic-agentic']).toBeUndefined();
    expect(r.routingGeneration.deliberation).toBe('anthropic/claude-opus-4-7');
  });
});
