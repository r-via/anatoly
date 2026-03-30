// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { TransportRouter } from './index.js';
import type { LlmTransport, LlmResponse, TransportRouterConfig, ProviderModeConfig } from './index.js';

/** Minimal stub transport for testing. */
function stubTransport(provider: string): LlmTransport {
  return {
    provider,
    supports: () => true,
    query: async () => ({} as LlmResponse),
  };
}

/** Build a TransportRouterConfig from provider concurrency values. */
function buildConfig(providers: Record<string, number>): TransportRouterConfig {
  const nativeTransports: Record<string, LlmTransport> = {};
  const providerModes: Record<string, ProviderModeConfig> = {};
  for (const [id, concurrency] of Object.entries(providers)) {
    nativeTransports[id] = stubTransport(id);
    providerModes[id] = { mode: 'subscription', concurrency };
  }
  return {
    nativeTransports,
    vercelSdkTransport: stubTransport('vercel-sdk'),
    providerModes,
  };
}

describe('TransportRouter — Story 46.1: semaphores & breakers per provider', () => {
  it('should create a semaphore per provider from concurrency config', () => {
    const router = new TransportRouter(buildConfig({ anthropic: 24, google: 10 }));
    const stats = router.getSemaphoreStats();
    expect(stats.get('anthropic')).toEqual({ active: 0, total: 24 });
    expect(stats.get('google')).toEqual({ active: 0, total: 10 });
  });

  it('should default semaphore concurrency to 10 when not specified', () => {
    const config: TransportRouterConfig = {
      nativeTransports: {},
      vercelSdkTransport: stubTransport('vercel-sdk'),
      providerModes: { ollama: { mode: 'api' } }, // no concurrency field
    };
    const router = new TransportRouter(config);
    const stats = router.getSemaphoreStats();
    expect(stats.get('ollama')).toEqual({ active: 0, total: 10 });
  });

  it('should create a circuit breaker per provider', () => {
    const router = new TransportRouter(buildConfig({ anthropic: 24, google: 10 }));
    expect(router.getBreakerState('anthropic')).toBe('closed');
    expect(router.getBreakerState('google')).toBe('closed');
  });

  it('should return undefined for unknown provider breaker state', () => {
    const router = new TransportRouter(buildConfig({ anthropic: 24 }));
    expect(router.getBreakerState('unknown')).toBeUndefined();
  });

  it('should track semaphore stats after direct semaphore use', async () => {
    const router = new TransportRouter(buildConfig({ anthropic: 24, google: 10 }));

    // Acquire 3 anthropic slots directly
    const sem = router.semaphores.get('anthropic')!;
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    const stats = router.getSemaphoreStats();
    expect(stats.get('anthropic')).toEqual({ active: 3, total: 24 });
    expect(stats.get('google')).toEqual({ active: 0, total: 10 });

    // Release all
    sem.release();
    sem.release();
    sem.release();
    const statsAfter = router.getSemaphoreStats();
    expect(statsAfter.get('anthropic')).toEqual({ active: 0, total: 24 });
  });

  it('should create breakers for all providers in providerModes', () => {
    const config: TransportRouterConfig = {
      nativeTransports: {},
      vercelSdkTransport: stubTransport('vercel-sdk'),
      providerModes: {
        anthropic: { mode: 'subscription', concurrency: 24 },
        google: { mode: 'api' }, // no concurrency → default 10
      },
    };
    const router = new TransportRouter(config);
    expect(router.getBreakerState('anthropic')).toBe('closed');
    expect(router.getBreakerState('google')).toBe('closed');
    const stats = router.getSemaphoreStats();
    expect(stats.get('anthropic')!.total).toBe(24);
    expect(stats.get('google')!.total).toBe(10);
  });
});
