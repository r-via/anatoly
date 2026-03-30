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

  it('AC 46.2: acquire() should block when all slots are taken', async () => {
    const router = new TransportRouter(buildConfig({ anthropic: 2 }));

    // Acquire both slots
    const slot1 = await router.acquire('anthropic/claude-sonnet-4-6', 'single_turn');
    const slot2 = await router.acquire('anthropic/claude-sonnet-4-6', 'single_turn');

    // Third acquire should block until a slot is released
    let thirdResolved = false;
    const thirdPromise = router.acquire('anthropic/claude-sonnet-4-6', 'single_turn').then(r => {
      thirdResolved = true;
      return r;
    });

    // Give event loop time to process
    await new Promise(r => setTimeout(r, 20));
    expect(thirdResolved).toBe(false);

    // Release one slot — third should now resolve
    slot1.release({ success: true });
    const slot3 = await thirdPromise;
    expect(thirdResolved).toBe(true);

    // Cleanup
    slot2.release({ success: true });
    slot3.release({ success: true });
  });

  it('AC 46.6: acquireSlot() should block at concurrency limit', async () => {
    const router = new TransportRouter(buildConfig({ anthropic: 2 }));

    const s1 = await router.acquireSlot('anthropic/claude-sonnet-4-6');
    const s2 = await router.acquireSlot('anthropic/claude-sonnet-4-6');

    let blocked = true;
    const s3Promise = router.acquireSlot('anthropic/claude-sonnet-4-6').then(r => {
      blocked = false;
      return r;
    });

    await new Promise(r => setTimeout(r, 20));
    expect(blocked).toBe(true);

    s1.release({ success: true });
    const s3 = await s3Promise;
    expect(blocked).toBe(false);

    s2.release({ success: true });
    s3.release({ success: true });
  });

  it('AC 46.6: 3 failed releases should trip breaker, next acquire() throws', async () => {
    const router = new TransportRouter(buildConfig({ anthropic: 10 }));

    // 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      const slot = await router.acquireSlot('anthropic/claude-sonnet-4-6');
      slot.release({ success: false });
    }

    expect(router.getBreakerState('anthropic')).toBe('open');

    // Next acquireSlot should throw immediately
    await expect(router.acquireSlot('anthropic/claude-sonnet-4-6'))
      .rejects.toThrow(/circuit breaker is open/);
  });

  it('AC 46.6: acquireSlot + release(success:true) frees slot and records success', async () => {
    const router = new TransportRouter(buildConfig({ anthropic: 2 }));

    const slot = await router.acquireSlot('anthropic/claude-sonnet-4-6');
    const stats1 = router.getSemaphoreStats();
    expect(stats1.get('anthropic')!.active).toBe(1);

    slot.release({ success: true });
    const stats2 = router.getSemaphoreStats();
    expect(stats2.get('anthropic')!.active).toBe(0);
    expect(router.getBreakerState('anthropic')).toBe('closed');
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
