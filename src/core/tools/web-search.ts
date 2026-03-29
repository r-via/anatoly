// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { Config } from '../../schemas/config.js';

export interface SearchTool {
  description: string;
  parameters: z.ZodObject<{ query: z.ZodString }>;
  execute: (args: { query: string }) => Promise<string>;
}

/**
 * Return a web search tool based on the config's `search.provider` setting,
 * or `null` if no search provider is configured or required env vars are missing.
 */
export function getSearchTool(config: Config): SearchTool | null {
  const provider = config.search?.provider;
  if (!provider) return null;

  if (provider === 'exa') {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) return null;
    return createExaSearchTool(apiKey);
  }

  if (provider === 'brave') {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) return null;
    return createBraveSearchTool(apiKey);
  }

  return null;
}

function createExaSearchTool(apiKey: string): SearchTool {
  return {
    description: 'Search the web using Exa for relevant code documentation, API references, and technical information.',
    parameters: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async ({ query }) => {
      const response = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          num_results: 5,
          use_autoprompt: true,
        }),
      });
      if (!response.ok) {
        return `Exa search failed: ${response.status} ${response.statusText}`;
      }
      const data = await response.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
      const results = data.results ?? [];
      return results
        .map((r, i) => `${i + 1}. ${r.title ?? 'Untitled'}\n   ${r.url ?? ''}\n   ${(r.text ?? '').slice(0, 200)}`)
        .join('\n\n') || 'No results found.';
    },
  };
}

function createBraveSearchTool(apiKey: string): SearchTool {
  return {
    description: 'Search the web using Brave Search for relevant code documentation, API references, and technical information.',
    parameters: z.object({
      query: z.string().describe('The search query'),
    }),
    execute: async ({ query }) => {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', '5');
      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });
      if (!response.ok) {
        return `Brave search failed: ${response.status} ${response.statusText}`;
      }
      const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      const results = data.web?.results ?? [];
      return results
        .map((r, i) => `${i + 1}. ${r.title ?? 'Untitled'}\n   ${r.url ?? ''}\n   ${(r.description ?? '').slice(0, 200)}`)
        .join('\n\n') || 'No results found.';
    },
  };
}
