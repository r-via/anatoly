// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Provider-specific HTTP headers used to attribute Anatoly traffic.
 *
 * Currently only OpenRouter consumes attribution headers (HTTP-Referer,
 * X-OpenRouter-Title, X-OpenRouter-Categories) which power its public app
 * rankings and per-model analytics. See https://openrouter.ai/docs/app-attribution.
 *
 * Returns `undefined` for any other provider so the SDK falls back to its
 * default header set.
 */
export function getProviderHeaders(providerId: string): Record<string, string> | undefined {
  if (providerId === 'openrouter') {
    return {
      'HTTP-Referer': 'https://anatoly.cloud',
      'X-OpenRouter-Title': 'Anatoly',
      'X-OpenRouter-Categories': 'cli-agent',
    };
  }
  return undefined;
}
