// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { getProviderHeaders } from './attribution.js';

describe('getProviderHeaders', () => {
  it('returns OpenRouter attribution headers for the openrouter provider', () => {
    expect(getProviderHeaders('openrouter')).toEqual({
      'HTTP-Referer': 'https://anatoly.cloud',
      'X-OpenRouter-Title': 'Anatoly',
      'X-OpenRouter-Categories': 'cli-agent',
    });
  });

  it.each(['anthropic', 'openai', 'google', 'groq', 'mistral', 'deepseek', 'ollama', 'voyage', 'cohere'])(
    'returns undefined for non-openrouter provider %s',
    (providerId) => {
      expect(getProviderHeaders(providerId)).toBeUndefined();
    },
  );

  it('is case-sensitive (does not match "OpenRouter")', () => {
    expect(getProviderHeaders('OpenRouter')).toBeUndefined();
  });
});
