// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from './with-timeout.js';
import { ERROR_CODES } from './errors.js';

describe('withTimeout', () => {
  it('resolves with the task value when it settles before the budget', async () => {
    const result = await withTimeout(async () => 'ok', { timeoutMs: 1000, label: 'fast' });
    expect(result).toBe('ok');
  });

  it('propagates a task rejection unchanged (no TimeoutError wrapping)', async () => {
    const boom = new Error('task failed');
    await expect(
      withTimeout(() => Promise.reject(boom), { timeoutMs: 1000, label: 'failing' }),
    ).rejects.toBe(boom);
  });

  it('rejects with a recoverable SDK_TIMEOUT TimeoutError when the budget is exceeded', async () => {
    const never = new Promise<never>(() => {});
    const err = await withTimeout(() => never, { timeoutMs: 10, label: 'stuck' }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.code).toBe(ERROR_CODES.SDK_TIMEOUT);
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain('stuck');
  });

  it('invokes onTimeout once on expiry so the caller can abort the in-flight call', async () => {
    const onTimeout = vi.fn();
    const never = new Promise<never>(() => {});
    await withTimeout(() => never, { timeoutMs: 10, label: 'stuck', onTimeout }).catch(() => {});
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing onTimeout mask the TimeoutError', async () => {
    const never = new Promise<never>(() => {});
    const err = await withTimeout(() => never, {
      timeoutMs: 10,
      label: 'stuck',
      onTimeout: () => { throw new Error('abort blew up'); },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('does not fire onTimeout when the task wins the race', async () => {
    const onTimeout = vi.fn();
    await withTimeout(async () => 'fast', { timeoutMs: 1000, label: 'fast', onTimeout });
    // Give any stray timer a tick to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
