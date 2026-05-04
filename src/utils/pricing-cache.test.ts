// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PRICING_PATHS,
  _resetPricingCache,
  ensurePricing,
  lookupPrice,
} from './pricing-cache.js';

// ---------------------------------------------------------------------------
// Fixtures — minimal slices of upstream payloads, with realistic shapes.
// ---------------------------------------------------------------------------

const LITELLM_FIXTURE = {
  'claude-sonnet-4-6': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
  'claude-haiku-4-5-20251001': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  'claude-opus-4-6': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
  'gemini-2.5-flash': { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 },
  'mistral/codestral-embed-2505': {
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 0,
  },
  'voyage/voyage-code-3': { input_cost_per_token: 1.8e-7, output_cost_per_token: 0 },
};

const OPENROUTER_CHAT_FIXTURE = {
  data: [
    { id: 'qwen/qwen3-coder', pricing: { prompt: '0.000002', completion: '0.000008' } },
  ],
};

const OPENROUTER_EMBEDDINGS_FIXTURE = {
  data: [
    { id: 'qwen/qwen3-embedding-8b', pricing: { prompt: '0.00000001', completion: '0' } },
  ],
};

// ---------------------------------------------------------------------------
// Test harness — temp project root, mocked fetch.
// ---------------------------------------------------------------------------

let projectRoot: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-pricing-'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  _resetPricingCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(projectRoot, { recursive: true, force: true });
});

function jsonResponse(body: unknown, init: { etag?: string; status?: number } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.etag) headers.set('etag', init.etag);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function notModifiedResponse(): Response {
  return new Response(null, { status: 304 });
}

// ---------------------------------------------------------------------------
// ensurePricing — first run
// ---------------------------------------------------------------------------

describe('ensurePricing — first run (no cache)', () => {
  it('writes normalized pricing for non-openrouter active models from litellm', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));

    await ensurePricing(['anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5-20251001'], projectRoot);

    const path = resolve(projectRoot, PRICING_PATHS.normalized);
    expect(existsSync(path)).toBe(true);
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    expect(file.models['anthropic/claude-sonnet-4-6']).toMatchObject({
      input: 3, // 3e-6 * 1M
      output: 15, // 1.5e-5 * 1M
      source: 'litellm',
    });
    expect(file.models['anthropic/claude-haiku-4-5-20251001']).toMatchObject({
      input: 1,
      output: 5,
      source: 'litellm',
    });
  });

  it('does not call OpenRouter when no openrouter/* model is active', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('litellm');
  });

  it('fetches OpenRouter chat + embeddings when an openrouter/* model is active', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }))
      .mockResolvedValueOnce(jsonResponse(OPENROUTER_CHAT_FIXTURE, { etag: '"or-c"' }))
      .mockResolvedValueOnce(jsonResponse(OPENROUTER_EMBEDDINGS_FIXTURE, { etag: '"or-e"' }));

    await ensurePricing(
      [
        'anthropic/claude-sonnet-4-6',
        'openrouter/qwen/qwen3-embedding-8b',
      ],
      projectRoot,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['openrouter/qwen/qwen3-embedding-8b']).toMatchObject({
      // 1e-8 * 1M = 0.01
      input: 0.01,
      output: 0,
      source: 'openrouter',
    });
  });

  it('resolves litellm entries that live under a provider-prefixed key (mistral/voyage)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['mistral/codestral-embed-2505', 'voyage/voyage-code-3'], projectRoot);

    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['mistral/codestral-embed-2505']).toMatchObject({ input: 0.15, output: 0 });
    expect(file.models['voyage/voyage-code-3']).toMatchObject({ input: 0.18, output: 0 });
  });

  it('omits unknown models from the normalized output and warns', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    const logged: Array<[string, string]> = [];
    await ensurePricing(['anthropic/totally-fake-model'], projectRoot, {
      log: (lvl, msg) => logged.push([lvl, msg]),
    });
    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['anthropic/totally-fake-model']).toBeUndefined();
    expect(logged.some(([lvl, msg]) => lvl === 'warn' && msg.includes('totally-fake-model'))).toBe(true);
  });

  it('persists the litellm raw snapshot and ETag meta for next-run conditional GET', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v42"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    const rawPath = resolve(projectRoot, PRICING_PATHS.litellmRaw);
    const metaPath = resolve(projectRoot, PRICING_PATHS.litellmMeta);
    expect(existsSync(rawPath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta.etag).toBe('"v42"');
  });
});

// ---------------------------------------------------------------------------
// ensurePricing — conditional GET on subsequent runs
// ---------------------------------------------------------------------------

describe('ensurePricing — conditional GET', () => {
  it('honours 304 Not Modified by re-using the on-disk snapshot', async () => {
    // Seed a previous run.
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);
    _resetPricingCache();

    // Subsequent run gets a 304.
    fetchMock.mockResolvedValueOnce(notModifiedResponse());
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['anthropic/claude-sonnet-4-6']).toMatchObject({ input: 3, output: 15 });
  });

  it('sends If-None-Match using the stored etag', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);
    _resetPricingCache();

    fetchMock.mockResolvedValueOnce(notModifiedResponse());
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    const secondCall = fetchMock.mock.calls[1];
    const headers = secondCall[1].headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
  });
});

// ---------------------------------------------------------------------------
// ensurePricing — failure modes
// ---------------------------------------------------------------------------

describe('ensurePricing — network failure', () => {
  it('falls back to the on-disk snapshot when fetch throws and a cache exists', async () => {
    // Seed.
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);
    _resetPricingCache();

    // Simulate offline run.
    fetchMock.mockRejectedValueOnce(new Error('ENETUNREACH'));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['anthropic/claude-sonnet-4-6']).toMatchObject({ input: 3 });
  });

  it('warns and emits zero-cost entries when no cache exists and fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENETUNREACH'));
    const logged: Array<[string, string]> = [];
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot, {
      log: (lvl, msg) => logged.push([lvl, msg]),
    });

    const file = JSON.parse(readFileSync(resolve(projectRoot, PRICING_PATHS.normalized), 'utf-8'));
    expect(file.models['anthropic/claude-sonnet-4-6']).toBeUndefined();
    expect(logged.some(([lvl]) => lvl === 'warn')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensurePricing — strict mode
//
// Required by the run / estimate commands: they must refuse to start if any
// configured model has no pricing entry, otherwise cost reports silently
// degrade to zero and break replay/forecast.
// ---------------------------------------------------------------------------

describe('ensurePricing — strict mode', () => {
  it('does not throw when all active models resolve to a pricing entry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await expect(
      ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot, { strict: true }),
    ).resolves.toBeUndefined();
  });

  it('throws PRICING_INCOMPLETE listing the offending models when one is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await expect(
      ensurePricing(
        ['anthropic/claude-sonnet-4-6', 'anthropic/claude-imaginary-9-9'],
        projectRoot,
        { strict: true },
      ),
    ).rejects.toMatchObject({
      code: 'PRICING_INCOMPLETE',
      message: expect.stringContaining('anthropic/claude-imaginary-9-9'),
    });
  });

  it('throws even when the network is offline if no resolvable pricing remains', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENETUNREACH'));
    await expect(
      ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot, { strict: true }),
    ).rejects.toMatchObject({ code: 'PRICING_INCOMPLETE' });
  });

  it('still persists the partial pricing.json so diagnostics can show what was resolved', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await expect(
      ensurePricing(
        ['anthropic/claude-sonnet-4-6', 'anthropic/claude-imaginary-9-9'],
        projectRoot,
        { strict: true },
      ),
    ).rejects.toThrow();

    const path = resolve(projectRoot, PRICING_PATHS.normalized);
    expect(existsSync(path)).toBe(true);
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    // Resolved model is persisted; missing model is absent (caller can list).
    expect(file.models['anthropic/claude-sonnet-4-6']).toBeDefined();
    expect(file.models['anthropic/claude-imaginary-9-9']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lookupPrice
// ---------------------------------------------------------------------------

describe('lookupPrice', () => {
  it('returns the in-memory entry written by ensurePricing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    const price = lookupPrice('anthropic/claude-sonnet-4-6', projectRoot);
    expect(price).toEqual({ input: 3, output: 15 });
  });

  it('lazily hydrates from disk when called without prior ensurePricing in this session', async () => {
    // Seed disk in a separate "session".
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);
    _resetPricingCache();

    const price = lookupPrice('anthropic/claude-sonnet-4-6', projectRoot);
    expect(price).toEqual({ input: 3, output: 15 });
  });

  it('returns null for an unknown model without throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITELLM_FIXTURE, { etag: '"v1"' }));
    await ensurePricing(['anthropic/claude-sonnet-4-6'], projectRoot);

    expect(lookupPrice('something/else', projectRoot)).toBeNull();
  });

  it('returns null when no cache file exists', () => {
    expect(lookupPrice('anthropic/claude-sonnet-4-6', projectRoot)).toBeNull();
  });

  it('tolerates prefix drift by falling back to a stripped-prefix lookup', async () => {
    // Seed using a bare key so that `lookupPrice` has to hunt by stripped prefix.
    mkdirSync(resolve(projectRoot, '.anatoly'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, PRICING_PATHS.normalized),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        models: {
          'anthropic/claude-sonnet-4-6': { input: 3, output: 15, source: 'litellm' },
        },
      }),
    );
    expect(lookupPrice('claude-sonnet-4-6', projectRoot)).toEqual({ input: 3, output: 15 });
  });
});
