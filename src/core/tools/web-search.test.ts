// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSearchTool } from './web-search.js';
import { ConfigSchema } from '../../schemas/config.js';
import type { Config } from '../../schemas/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

describe('getSearchTool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no search provider is configured', () => {
    const config = makeConfig();
    expect(getSearchTool(config)).toBeNull();
  });

  it('returns an exa search tool when provider is "exa"', () => {
    vi.stubEnv('EXA_API_KEY', 'test-exa-key');
    const config = makeConfig({ search: { provider: 'exa' } });
    const tool = getSearchTool(config);
    expect(tool).not.toBeNull();
    expect(tool!.description).toMatch(/search/i);
  });

  it('returns a brave search tool when provider is "brave" and BRAVE_API_KEY is set', () => {
    vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
    const config = makeConfig({ search: { provider: 'brave' } });
    const tool = getSearchTool(config);
    expect(tool).not.toBeNull();
    expect(tool!.description).toMatch(/search/i);
  });

  it('returns null for brave when BRAVE_API_KEY is missing', () => {
    vi.unstubAllEnvs();
    delete process.env.BRAVE_API_KEY;
    const config = makeConfig({ search: { provider: 'brave' } });
    expect(getSearchTool(config)).toBeNull();
  });
});
