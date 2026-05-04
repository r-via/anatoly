// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../schemas/config.js';
import { enumerateActiveModels } from './active-models.js';

describe('enumerateActiveModels', () => {
  it('returns the three default tier models when no overrides are set', () => {
    const config = ConfigSchema.parse({});
    const models = enumerateActiveModels(config);
    // Defaults from DEFAULT_MODELS
    expect(models).toContain('anthropic/claude-sonnet-4-6');
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('deduplicates identical model ids across sources', () => {
    const config = ConfigSchema.parse({
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-sonnet-4-6',
        deliberation: 'anthropic/claude-sonnet-4-6',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models.filter((m) => m === 'anthropic/claude-sonnet-4-6')).toHaveLength(1);
  });

  it('includes axis-level model overrides', () => {
    const config = ConfigSchema.parse({
      axes: {
        utility: { enabled: true, model: 'google/gemini-2.5-flash-lite' },
        duplication: { enabled: true, model: 'google/gemini-2.5-flash' },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('google/gemini-2.5-flash-lite');
    expect(models).toContain('google/gemini-2.5-flash');
  });

  it('includes optional models.code_summary', () => {
    const config = ConfigSchema.parse({
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        code_summary: 'google/gemini-2.5-flash-lite',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('google/gemini-2.5-flash-lite');
  });

  it('includes optional agents overrides', () => {
    const config = ConfigSchema.parse({
      agents: {
        enabled: true,
        scaffolding: 'anthropic/claude-haiku-4-5-20251001',
        review: 'google/gemini-2.5-pro',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
    expect(models).toContain('google/gemini-2.5-pro');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('includes embedding code/nlp model when configured', () => {
    const config = ConfigSchema.parse({
      rag: {
        enabled: true,
        code_model: 'auto',
        nlp_model: 'auto',
        code_weight: 0.6,
        embedding: {
          code: { provider: 'voyage', model: 'voyage-code-3' },
          nlp: { provider: 'openai', model: 'text-embedding-3-large' },
        },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models).toContain('voyage-code-3');
    expect(models).toContain('text-embedding-3-large');
  });

  it('skips embedding entries without an explicit model', () => {
    const config = ConfigSchema.parse({
      rag: {
        enabled: true,
        code_model: 'auto',
        nlp_model: 'auto',
        code_weight: 0.6,
        embedding: {
          code: { provider: 'voyage' }, // no model
        },
      },
    });
    const models = enumerateActiveModels(config);
    expect(models.find((m) => m.includes('voyage'))).toBeUndefined();
  });

  it('returns a stable sorted order so callers can hash it deterministically', () => {
    const config = ConfigSchema.parse({});
    const a = enumerateActiveModels(config);
    const b = enumerateActiveModels(config);
    expect(a).toEqual(b);
    // sorted ascending
    expect([...a].sort()).toEqual(a);
  });
});
