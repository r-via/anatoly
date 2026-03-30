// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildProviderChecks, formatProvidersTable, type ProviderCheckResult } from './providers.js';
import { ConfigSchema } from '../schemas/config.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// buildProviderChecks
// ---------------------------------------------------------------------------

describe('buildProviderChecks', () => {
  it('should return Claude models when Gemini is not configured', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every(c => c.provider === 'anthropic')).toBe(true);
  });

  it('should include the main model and deliberation model', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    const models = checks.map(c => c.model);
    expect(models).toContain('anthropic/claude-sonnet-4-6');
    expect(models).toContain('anthropic/claude-opus-4-6');
  });

  it('should deduplicate models', () => {
    const config = makeConfig({
      models: { quality: 'anthropic/claude-sonnet-4-6', deliberation: 'anthropic/claude-sonnet-4-6' },
    });
    const checks = buildProviderChecks(config);
    const sonnetCount = checks.filter(c => c.model === 'anthropic/claude-sonnet-4-6').length;
    expect(sonnetCount).toBe(1);
  });

  it('should include fast model (haiku) in checks', () => {
    const config = makeConfig();
    const checks = buildProviderChecks(config);
    const models = checks.map(c => c.model);
    expect(models).toContain('anthropic/claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// formatProvidersTable
// ---------------------------------------------------------------------------

describe('formatProvidersTable', () => {
  const results: ProviderCheckResult[] = [
    { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', latencyMs: 1234, auth: 'ANTHROPIC_API_KEY' },
    { provider: 'anthropic', model: 'claude-opus-4-6', status: 'error', latencyMs: 0, auth: 'ANTHROPIC_API_KEY', error: 'timeout' },
  ];

  it('should produce a string containing all providers', () => {
    const table = formatProvidersTable(results);
    expect(table).toContain('anthropic');
    expect(table).toContain('claude-sonnet-4-6');
    expect(table).toContain('claude-opus-4-6');
  });

  it('should show checkmark for successful checks', () => {
    const table = formatProvidersTable(results);
    // Check for the checkmark character
    expect(table).toMatch(/✓/);
  });

  it('should show cross for failed checks', () => {
    const table = formatProvidersTable(results);
    expect(table).toMatch(/✗/);
  });

  it('should display latency for successful checks', () => {
    const table = formatProvidersTable(results);
    expect(table).toContain('1234');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('JSON output shape', () => {
  it('should produce valid JSON with providers array', () => {
    const results: ProviderCheckResult[] = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', latencyMs: 500, auth: 'ANTHROPIC_API_KEY' },
    ];
    const json = JSON.parse(JSON.stringify({ providers: results }));
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status: 'ok',
      latencyMs: 500,
      auth: 'ANTHROPIC_API_KEY',
    });
  });
});
